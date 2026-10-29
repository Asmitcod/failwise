import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import {
  MAX_WEBHOOK_BODY_BYTES,
  parseGitHubWebhook,
  receiveGitHubWebhook,
  verifyGitHubSignature,
} from "../src/lib/github-webhook.ts";

const secret = "local-test-webhook-secret";

function failurePayload(overrides = {}) {
  return {
    action: "completed",
    installation: {
      id: 123,
      account: { login: "acme", type: "Organization" },
    },
    repository: {
      full_name: "acme/payments",
      default_branch: "main",
    },
    workflow_run: {
      id: 1842,
      run_attempt: 1,
      name: "Build and test",
      head_sha: "a81f2c9",
      head_branch: "feature/checkout-summary",
      conclusion: "failure",
      html_url: "https://github.com/acme/payments/actions/runs/1842",
    },
    ...overrides,
  };
}

function signedRequest({
  payload = failurePayload(),
  event = "workflow_run",
  deliveryId = randomUUID(),
  signatureSecret = secret,
} = {}) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", signatureSecret).update(body).digest("hex");
  return new Request("https://failwise.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

function mockDependencies(overrides = {}) {
  const calls = [];
  const dependencies = {
    secret,
    persist: async (webhook) => {
      calls.push(["persist", webhook.shouldTriage]);
      return { outcome: "queued", pendingJob: { outboxId: "pending-1", payload: {} } };
    },
    publish: async () => calls.push(["publish"]),
    onRejectedSignature: (deliveryId) => calls.push(["signature-rejected", deliveryId]),
    onProcessingError: () => calls.push(["processing-error"]),
    ...overrides,
  };
  return { dependencies, calls };
}

test("validates GitHub HMAC signatures against the exact raw body", () => {
  const body = '{"action":"completed"}';
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(verifyGitHubSignature(body, `sha256=${signature}`, secret), true);
  assert.equal(verifyGitHubSignature(`${body} `, `sha256=${signature}`, secret), false);
  assert.equal(verifyGitHubSignature(body, `sha256=${signature}`, "wrong-secret"), false);
  assert.equal(verifyGitHubSignature(body, "sha1=deadbeef", secret), false);
});

test("parses a failed workflow run for triage", () => {
  const webhook = parseGitHubWebhook(randomUUID(), "workflow_run", failurePayload());

  assert.equal(webhook.shouldTriage, true);
  assert.equal(webhook.repository.fullName, "acme/payments");
  assert.equal(webhook.run.conclusion, "failure");
});

test("persists then publishes signed failed runs before acknowledging", async () => {
  const deliveryId = randomUUID();
  const { dependencies, calls } = mockDependencies();
  const response = await receiveGitHubWebhook(
    signedRequest({ deliveryId }),
    dependencies,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(calls, [["persist", true], ["publish"]]);
  assert.deepEqual(await response.json(), { deliveryId, status: "queued" });
});

test("rejects bad signatures without persisting or publishing", async () => {
  const deliveryId = randomUUID();
  const { dependencies, calls } = mockDependencies();
  const response = await receiveGitHubWebhook(
    signedRequest({ deliveryId, signatureSecret: "attacker-secret" }),
    dependencies,
  );

  assert.equal(response.status, 401);
  assert.deepEqual(calls, [["signature-rejected", deliveryId]]);
});

test("records successful workflow completions as skipped", async () => {
  const { dependencies, calls } = mockDependencies({
    persist: async (webhook) => {
      calls.push(["persist", webhook.shouldTriage]);
      return { outcome: "skipped" };
    },
  });
  const payload = failurePayload({
    workflow_run: {
      ...failurePayload().workflow_run,
      conclusion: "success",
    },
  });
  const response = await receiveGitHubWebhook(
    signedRequest({ payload }),
    dependencies,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(calls, [["persist", false]]);
});

test("acknowledges a persisted duplicate without enqueuing a second job", async () => {
  const { dependencies, calls } = mockDependencies({
    persist: async () => {
      calls.push(["persist"]);
      return { outcome: "duplicate" };
    },
  });
  const response = await receiveGitHubWebhook(signedRequest(), dependencies);

  assert.equal(response.status, 202);
  assert.deepEqual(calls, [["persist"]]);
});

test("returns a retryable error when the durable queue handoff fails", async () => {
  const { dependencies, calls } = mockDependencies({
    publish: async () => {
      calls.push(["publish"]);
      throw new Error("QStash unavailable");
    },
  });
  const response = await receiveGitHubWebhook(signedRequest(), dependencies);

  assert.equal(response.status, 503);
  assert.deepEqual(calls, [
    ["persist", true],
    ["publish"],
    ["processing-error"],
  ]);
});

test("does not accept webhook requests when signature verification is unconfigured", async () => {
  const { dependencies, calls } = mockDependencies({ secret: undefined });
  const response = await receiveGitHubWebhook(signedRequest(), dependencies);

  assert.equal(response.status, 503);
  assert.deepEqual(calls, []);
});

test("rejects oversized webhook bodies before parsing", async () => {
  const response = await receiveGitHubWebhook(
    new Request("https://failwise.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
        "x-github-delivery": randomUUID(),
        "x-github-event": "workflow_run",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      },
      body: "{}",
    }),
    mockDependencies().dependencies,
  );

  assert.equal(response.status, 413);
});

test("rejects malformed completed workflow runs with a client error", async () => {
  const { dependencies, calls } = mockDependencies();
  const response = await receiveGitHubWebhook(
    signedRequest({ payload: { action: "completed" } }),
    dependencies,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});
