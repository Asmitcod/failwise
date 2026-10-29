import { createHmac, timingSafeEqual } from "node:crypto";
import type { TriageQueueMessage } from "@/lib/db/schema";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const DELIVERY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface GitHubRun {
  id: number;
  runAttempt: number;
  workflowName: string;
  headSha: string;
  headBranch: string;
  pullRequestNumber: number | null;
  baseSha: string | null;
  conclusion: string;
  htmlUrl: string;
}

export interface GitHubRepository {
  fullName: string;
  defaultBranch: string;
}

export interface GitHubInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
}

export interface GitHubWebhook {
  deliveryId: string;
  event: string;
  action: string | null;
  repository: GitHubRepository | null;
  installation: GitHubInstallation | null;
  run: GitHubRun | null;
  shouldTriage: boolean;
}

export interface PendingTriageJob {
  outboxId: string;
  replayCount: number;
  payload: TriageQueueMessage;
}

export type PersistedWebhook =
  | { outcome: "skipped" | "duplicate" }
  | { outcome: "queued"; pendingJob: PendingTriageJob };

export interface GitHubWebhookDependencies {
  secret: string | undefined;
  persist: (webhook: GitHubWebhook) => Promise<PersistedWebhook>;
  publish: (pendingJob: PendingTriageJob) => Promise<void | boolean>;
  onRejectedSignature?: (deliveryId: string) => void;
  onProcessingError?: (deliveryId: string, error: unknown) => void;
}

export class InvalidWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebhookError";
  }
}

export function verifyGitHubSignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature ?? "")) return false;

  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  const actual = Buffer.from(signature!.slice("sha256=".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 500,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new InvalidWebhookError(`Invalid ${label} in GitHub webhook payload.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new InvalidWebhookError(`Invalid ${label} in GitHub webhook payload.`);
  }
  return value;
}

function readRepository(value: unknown): GitHubRepository | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    throw new InvalidWebhookError("Invalid repository in GitHub webhook payload.");
  }

  const fullName = requiredString(value.full_name, "repository name", 255);
  if (!REPOSITORY_NAME_PATTERN.test(fullName)) {
    throw new InvalidWebhookError("Invalid repository name in GitHub webhook payload.");
  }

  const defaultBranch = requiredString(value.default_branch, "default branch", 255);

  return { fullName, defaultBranch };
}

function readInstallation(value: unknown): GitHubInstallation | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    throw new InvalidWebhookError("Invalid installation in GitHub webhook payload.");
  }

  const account = isObject(value.account) ? value.account : null;
  if (!account) {
    throw new InvalidWebhookError("Invalid installation account in GitHub webhook payload.");
  }

  return {
    id: requiredPositiveInteger(value.id, "installation ID"),
    accountLogin: requiredString(account.login, "installation account", 255),
    accountType: requiredString(account.type, "installation account type", 64),
  };
}

function readWorkflowRun(value: unknown): GitHubRun {
  if (!isObject(value)) {
    throw new InvalidWebhookError("Missing workflow run in GitHub webhook payload.");
  }

  const conclusion = requiredString(value.conclusion, "run conclusion", 64);
  const htmlUrl = requiredString(value.html_url, "run URL", 2048);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(htmlUrl);
  } catch {
    throw new InvalidWebhookError("Invalid run URL in GitHub webhook payload.");
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com") {
    throw new InvalidWebhookError("Run URL must point to github.com.");
  }

  const pullRequests = Array.isArray(value.pull_requests)
    ? value.pull_requests
    : [];
  const pullRequest = pullRequests.length > 0 && isObject(pullRequests[0])
    ? pullRequests[0]
    : null;
  const base = pullRequest && isObject(pullRequest.base) ? pullRequest.base : null;
  const baseSha =
    base?.sha === undefined
      ? null
      : requiredString(base.sha, "pull request base SHA", 128);
  const pullRequestNumber =
    pullRequest?.number === undefined
      ? null
      : requiredPositiveInteger(pullRequest.number, "pull request number");

  return {
    id: requiredPositiveInteger(value.id, "run ID"),
    runAttempt: requiredPositiveInteger(value.run_attempt, "run attempt"),
    workflowName: requiredString(value.name, "workflow name", 255),
    headSha: requiredString(value.head_sha, "head SHA", 128),
    headBranch: requiredString(value.head_branch, "head branch", 255),
    pullRequestNumber,
    baseSha,
    conclusion,
    htmlUrl,
  };
}

export function parseGitHubWebhook(
  deliveryId: string,
  event: string,
  payload: unknown,
): GitHubWebhook {
  if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
    throw new InvalidWebhookError("Invalid X-GitHub-Delivery header.");
  }
  if (!/^[a-z_]{1,64}$/.test(event)) {
    throw new InvalidWebhookError("Invalid X-GitHub-Event header.");
  }
  if (!isObject(payload)) {
    throw new InvalidWebhookError("GitHub webhook body must be a JSON object.");
  }

  const action =
    payload.action === undefined
      ? null
      : requiredString(payload.action, "webhook action", 64);
  const repository = readRepository(payload.repository);
  const installation = readInstallation(payload.installation);
  const isCompletedWorkflow = event === "workflow_run" && action === "completed";
  const run = isCompletedWorkflow ? readWorkflowRun(payload.workflow_run) : null;

  if (
    isCompletedWorkflow &&
    (!repository || !installation || !run)
  ) {
    throw new InvalidWebhookError(
      "Completed workflow webhook is missing its repository, installation, or run.",
    );
  }

  const shouldTriage =
    isCompletedWorkflow &&
    (run?.conclusion === "failure" || run?.conclusion === "timed_out");

  return {
    deliveryId,
    event,
    action,
    repository,
    installation,
    run,
    shouldTriage,
  };
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > maxBytes) {
    throw new RangeError("Webhook request body exceeds the allowed size.");
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RangeError("Webhook request body exceeds the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidWebhookError("GitHub webhook body is not valid UTF-8.");
  }
}

export async function receiveGitHubWebhook(
  request: Request,
  dependencies: GitHubWebhookDependencies,
): Promise<Response> {
  if (!dependencies.secret) {
    return Response.json(
      { error: "GitHub webhook signature verification is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) {
    return Response.json({ error: "Missing GitHub webhook signature." }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!event || !deliveryId || deliveryId.length > 64 || event.length > 64) {
    return Response.json(
      { error: "Missing or invalid GitHub webhook headers." },
      { status: 400 },
    );
  }

  let body: string;
  try {
    body = await readBoundedBody(request, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    return Response.json({ error: "Unable to read GitHub webhook body." }, { status: 400 });
  }

  if (!verifyGitHubSignature(body, signature, dependencies.secret)) {
    dependencies.onRejectedSignature?.(deliveryId);
    return Response.json({ error: "Invalid GitHub webhook signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "GitHub webhook body is not valid JSON." }, { status: 400 });
  }

  let webhook: GitHubWebhook;
  try {
    webhook = parseGitHubWebhook(deliveryId, event, payload);
  } catch (error) {
    if (error instanceof InvalidWebhookError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const persisted = await dependencies.persist(webhook);
    if (persisted.outcome === "queued") {
      await dependencies.publish(persisted.pendingJob);
    }

    return Response.json(
      { deliveryId, status: persisted.outcome },
      { status: 202 },
    );
  } catch (error) {
    dependencies.onProcessingError?.(deliveryId, error);
    return Response.json(
      { error: "Webhook was not fully queued; retry or reconcile this delivery." },
      { status: 503 },
    );
  }
}
