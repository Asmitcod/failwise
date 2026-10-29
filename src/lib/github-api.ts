import { createPrivateKey, sign } from "node:crypto";
import { unzipSync } from "fflate";
import { extractLogExcerpt, type ChangedFile } from "./triage.ts";

const API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_COMPRESSED_LOG_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_LOG_BYTES = 16 * 1024 * 1024;
const MAX_LOG_FILES = 32;

export interface GitHubJobLog {
  jobId: string;
  jobName: string;
  failedStep: string | null;
  logExcerpt: string;
  excerptBytes: number;
  redactionCount: number;
}

export interface GitHubCollection {
  failedJobs: GitHubJobLog[];
  changedFiles: (ChangedFile & { baseSha: string | null; htmlUrl: string | null })[];
  baseSha: string | null;
  unavailableLogs: number;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;

  constructor(status: number, retryAfter: string | null) {
    super(`GitHub API request failed with status ${status}.`);
    this.name = "GitHubApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

interface GitHubApiConfig {
  appId: string | undefined;
  privateKey: string | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps: { name: string; conclusion: string | null }[] | null;
}

interface RunSnapshot {
  repository: string;
  installationId: number;
  runId: string;
  runAttempt: number;
  workflowName: string;
  headSha: string;
  headBranch: string;
  baseSha: string | null;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function createAppJwt(appId: string, privateKeyPem: string, now: number): string {
  if (!/^\d+$/.test(appId)) {
    throw new Error("GITHUB_APP_ID must be a positive numeric app ID.");
  }
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iat: issuedAt,
      exp: issuedAt + 9 * 60,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${claims}`;

  let key;
  try {
    key = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be a valid PEM private key.");
  }

  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflowJob(value: unknown): WorkflowJob {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.name !== "string" ||
    value.name.length > 500
  ) {
    throw new Error("GitHub returned an invalid workflow job.");
  }

  const steps = Array.isArray(value.steps)
    ? value.steps.map((step) => {
        if (!isRecord(step) || typeof step.name !== "string") {
          throw new Error("GitHub returned invalid workflow step metadata.");
        }
        return {
          name: step.name,
          conclusion: typeof step.conclusion === "string" ? step.conclusion : null,
        };
      })
    : null;

  return {
    id: value.id,
    name: value.name,
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    steps,
  };
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("GitHub job log archive exceeds the download size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function getLogText(archive: Uint8Array): string {
  if (archive.byteLength < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b) {
    throw new Error("GitHub returned an invalid job log archive.");
  }

  let extractedBytes = 0;
  let extractedFiles = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, {
      filter: (file) => {
        const isTextLog = file.name.toLowerCase().endsWith(".txt");
        if (
          !isTextLog ||
          file.originalSize > MAX_EXTRACTED_LOG_BYTES - extractedBytes ||
          extractedFiles >= MAX_LOG_FILES
        ) {
          return false;
        }
        extractedBytes += file.originalSize;
        extractedFiles += 1;
        return true;
      },
    });
  } catch {
    throw new Error("GitHub job log archive could not be decoded.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  return Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([, contents]) => decoder.decode(contents))
    .join("\n");
}

export class GitHubActionsClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly installationTokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(config: GitHubApiConfig) {
    if (!config.appId || !config.privateKey) {
      throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for GitHub API access.");
    }
    this.appId = config.appId;
    this.privateKey = config.privateKey;
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? Date.now;
  }

  private readonly appId: string;
  private readonly privateKey: string;

  private async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt > this.now() + 60_000) return cached.token;

    const jwt = createAppJwt(this.appId, this.privateKey, this.now());
    const response = await this.fetcher(
      `${API_URL}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permissions: { actions: "read", contents: "read", pull_requests: "read" },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) throw new GitHubApiError(response.status, response.headers.get("retry-after"));
    const result: unknown = await response.json();
    if (
      !isRecord(result) ||
      typeof result.token !== "string" ||
      typeof result.expires_at !== "string"
    ) {
      throw new Error("GitHub returned an invalid installation access token response.");
    }

    const expiresAt = Date.parse(result.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error("GitHub returned an expired installation access token.");
    }
    this.installationTokens.set(installationId, { token: result.token, expiresAt });
    return result.token;
  }

  private async requestJson(
    token: string,
    path: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${API_URL}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GitHubApiError(response.status, response.headers.get("retry-after"));

    const result: unknown = await response.json();
    if (!isRecord(result)) {
      throw new Error("GitHub returned an invalid API response.");
    }
    return result;
  }

  private async listJobs(
    token: string,
    repository: string,
    runId: string,
    attempt: number,
  ): Promise<WorkflowJob[]> {
    const [owner, repo] = repository.split("/");
    const jobs: WorkflowJob[] = [];

    for (let page = 1; page <= 10; page += 1) {
      const result = await this.requestJson(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(result.jobs)) {
        throw new Error("GitHub returned an invalid workflow jobs response.");
      }
      const currentJobs = result.jobs.map(parseWorkflowJob);
      jobs.push(...currentJobs);
      if (currentJobs.length < 100) return jobs;
    }

    throw new Error("GitHub workflow run returned more than 1000 jobs.");
  }

  private async getJobLog(
    token: string,
    repository: string,
    jobId: number,
  ): Promise<string> {
    const [owner, repo] = repository.split("/");
    const response = await this.fetcher(
      `${API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
        },
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (response.status === 404 || response.status === 410) return "";
    if (!response.ok) throw new GitHubApiError(response.status, response.headers.get("retry-after"));
    const archive = await readBoundedBytes(response, MAX_COMPRESSED_LOG_BYTES);
    return getLogText(archive);
  }

  private async getBaseSha(
    token: string,
    run: RunSnapshot,
  ): Promise<string | null> {
    if (run.baseSha) return run.baseSha;
    const [owner, repo] = run.repository.split("/");
    const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    try {
      const runsResponse = await this.requestJson(
        token,
        `${basePath}/actions/runs?branch=${encodeURIComponent(run.headBranch)}&status=success&per_page=20`,
      );
      if (Array.isArray(runsResponse.workflow_runs)) {
        const previousGreenRun = runsResponse.workflow_runs.find(
          (candidate) =>
            isRecord(candidate) &&
              candidate.name === run.workflowName &&
              typeof candidate.head_sha === "string" &&
            candidate.head_sha !== run.headSha,
        );
        if (isRecord(previousGreenRun) && typeof previousGreenRun.head_sha === "string") {
          return previousGreenRun.head_sha;
        }
      }
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
    }

    const commit = await this.requestJson(
      token,
      `${basePath}/commits/${encodeURIComponent(run.headSha)}`,
    );
    if (!Array.isArray(commit.parents) || commit.parents.length === 0) return null;
    const parent = commit.parents[0];
    return isRecord(parent) && typeof parent.sha === "string" ? parent.sha : null;
  }

  private async listChangedFiles(
    token: string,
    run: RunSnapshot,
    baseSha: string | null,
  ): Promise<GitHubCollection["changedFiles"]> {
    if (!baseSha || baseSha === run.headSha) return [];

    const [owner, repo] = run.repository.split("/");
    const comparePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(`${baseSha}...${run.headSha}`)}`;
    const files: GitHubCollection["changedFiles"] = [];

    for (let page = 1; page <= 3; page += 1) {
      const result = await this.requestJson(token, `${comparePath}?per_page=100&page=${page}`);
      if (!Array.isArray(result.files)) {
        throw new Error("GitHub returned an invalid commit comparison response.");
      }

      for (const item of result.files) {
        if (
          !isRecord(item) ||
          typeof item.filename !== "string" ||
          typeof item.status !== "string" ||
          !Number.isSafeInteger(item.additions) ||
          !Number.isSafeInteger(item.deletions) ||
          typeof item.blob_url !== "string"
        ) {
          throw new Error("GitHub returned an invalid changed file.");
        }

        let fileUrl: URL;
        try {
          fileUrl = new URL(item.blob_url);
        } catch {
          throw new Error("GitHub returned an invalid changed file URL.");
        }
        if (fileUrl.protocol !== "https:" || fileUrl.hostname !== "github.com") {
          throw new Error("GitHub returned a changed file URL outside github.com.");
        }

        files.push({
          path: item.filename,
          changeType: item.status,
          additions: Math.max(0, item.additions as number),
          deletions: Math.max(0, item.deletions as number),
          baseSha,
          htmlUrl: item.blob_url,
        });
      }
      if (result.files.length < 100) return files;
    }

    return files;
  }

  async collectFailedRun(run: RunSnapshot): Promise<GitHubCollection> {
    const token = await this.getInstallationToken(run.installationId);
    const jobs = await this.listJobs(token, run.repository, run.runId, run.runAttempt);
    const failedJobs: GitHubJobLog[] = [];
    let unavailableLogs = 0;

    for (const job of jobs) {
      if (job.conclusion !== "failure" && job.conclusion !== "timed_out") continue;
      const rawLog = await this.getJobLog(token, run.repository, job.id);
      if (!rawLog) unavailableLogs += 1;

      const excerpt = extractLogExcerpt(rawLog);
      const failedStep =
        job.steps?.find(
          (step) => step.conclusion === "failure" || step.conclusion === "timed_out",
        )?.name ?? null;

      failedJobs.push({
        jobId: job.id.toString(),
        jobName: job.name,
        failedStep,
        logExcerpt: excerpt.excerpt,
        excerptBytes: excerpt.excerptBytes,
        redactionCount: excerpt.redactionCount,
      });
    }

    const baseSha = await this.getBaseSha(token, run);
    const changedFiles = await this.listChangedFiles(token, run, baseSha);
    return { failedJobs, changedFiles, baseSha, unavailableLogs };
  }
}
