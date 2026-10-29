import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { GitHubActionsClient } from "../src/lib/github-api.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

test("collects failed job logs and files using least-privilege app credentials", async () => {
  const calls = [];
  const now = Date.UTC(2025, 0, 1);
  const client = new GitHubActionsClient({
    appId: "12345",
    privateKey,
    now: () => now,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.endsWith("/app/installations/123/access_tokens")) {
        return Response.json({
          token: "installation-token",
          expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        });
      }
      if (url.includes("/actions/runs/1842/attempts/2/jobs?")) {
        return Response.json({
          jobs: [
            {
              id: 987,
              name: "test (node 22)",
              conclusion: "failure",
              steps: [
                { name: "Install", conclusion: "success" },
                { name: "Run tests", conclusion: "failure" },
              ],
            },
            {
              id: 988,
              name: "successful job",
              conclusion: "success",
              steps: [],
            },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/987/logs")) {
        const archive = zipSync({
          "1_test.txt": strToU8(
            "Error: test suite failed\nghp_abcdefghijklmnopqrstuvwxyz1234567890\n",
          ),
          "metadata.json": strToU8('{"ignored":true}'),
        });
        return new Response(Buffer.from(archive), { status: 200 });
      }
      if (url.includes("/compare/")) {
        return Response.json({
          files: [
            {
              filename: "src/checkout.ts",
              status: "modified",
              additions: 4,
              deletions: 2,
              blob_url: "https://github.com/acme/payments/blob/head/src/checkout.ts",
            },
          ],
        });
      }

      throw new Error(`Unexpected GitHub request: ${url}`);
    },
  });

  const result = await client.collectFailedRun({
    repository: "acme/payments",
    installationId: 123,
    runId: "1842",
    runAttempt: 2,
    workflowName: "Build and test",
    headSha: "head",
    headBranch: "feature/checkout",
    baseSha: "base",
  });

  assert.equal(result.failedJobs.length, 1);
  assert.equal(result.failedJobs[0].jobId, "987");
  assert.equal(result.failedJobs[0].failedStep, "Run tests");
  assert.match(result.failedJobs[0].logExcerpt, /test suite failed/);
  assert.match(result.failedJobs[0].logExcerpt, /REDACTED_TOKEN/);
  assert.doesNotMatch(result.failedJobs[0].logExcerpt, /ghp_/);
  assert.equal(result.failedJobs[0].redactionCount, 1);
  assert.equal(result.changedFiles[0].path, "src/checkout.ts");
  assert.equal(result.changedFiles[0].baseSha, "base");
  assert.equal(result.baseSha, "base");
  assert.equal(result.unavailableLogs, 0);

  const tokenRequest = calls.find(({ url }) =>
    url.endsWith("/app/installations/123/access_tokens"),
  );
  assert.deepEqual(JSON.parse(tokenRequest.init.body), {
    permissions: { actions: "read", contents: "read", pull_requests: "read" },
  });
  const jwt = tokenRequest.init.headers.Authorization.slice("Bearer ".length);
  const [header, claims] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).iss, "12345");
});

test("selects a previous successful run from the same workflow", async () => {
  const now = Date.UTC(2025, 0, 1);
  const requestedUrls = [];
  const client = new GitHubActionsClient({
    appId: "12345",
    privateKey,
    now: () => now,
    fetcher: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return Response.json({
          token: "installation-token",
          expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        });
      }
      if (url.includes("/actions/runs/1842/attempts/2/jobs?")) {
        return Response.json({ jobs: [] });
      }
      if (url.includes("/actions/runs?")) {
        return Response.json({
          workflow_runs: [
            { name: "Other workflow", head_sha: "other" },
            { name: "Build and test", head_sha: "previous-success" },
          ],
        });
      }
      if (url.includes("/compare/")) return Response.json({ files: [] });
      throw new Error(`Unexpected GitHub request: ${url}`);
    },
  });

  const result = await client.collectFailedRun({
    repository: "acme/payments",
    installationId: 123,
    runId: "1842",
    runAttempt: 2,
    workflowName: "Build and test",
    headSha: "head",
    headBranch: "main",
    baseSha: null,
  });

  assert.equal(result.baseSha, "previous-success");
  assert.ok(requestedUrls.some((url) => url.includes("status=success")));
});
