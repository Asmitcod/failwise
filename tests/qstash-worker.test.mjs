import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  MAX_QSTASH_BODY_BYTES,
  receiveQStashJob,
} from "../src/lib/qstash-worker.ts";

const message = {
  deliveryId: randomUUID(),
  triageJobId: randomUUID(),
  installationId: 123,
  repository: "acme/payments",
  runId: "1842",
  runAttempt: 1,
};

function request(body = JSON.stringify(message), headers = {}) {
  return new Request("https://failwise.test/api/webhooks/qstash", {
    method: "POST",
    headers: { "upstash-signature": "test-signature", ...headers },
    body,
  });
}

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      currentSigningKey: "current",
      nextSigningKey: "next",
      verify: async (input) => {
        calls.push(["verify", input.body, input.url]);
        return true;
      },
      process: async (value) => calls.push(["process", value]),
      ...overrides,
    },
  };
}

test("verifies and processes a valid QStash triage message", async () => {
  const { calls, value } = dependencies();
  const response = await receiveQStashJob(request(), value);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "accepted",
    triageJobId: message.triageJobId,
  });
  assert.deepEqual(calls, [
    [
      "verify",
      JSON.stringify(message),
      "https://failwise.test/api/webhooks/qstash",
    ],
    ["process", message],
  ]);
});

test("rejects a message when QStash signature verification fails", async () => {
  const { calls, value } = dependencies({
    verify: async () => false,
  });
  const response = await receiveQStashJob(request(), value);

  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("rejects malformed queue messages after signature verification", async () => {
  const { calls, value } = dependencies();
  const response = await receiveQStashJob(
    request(JSON.stringify({ ...message, runAttempt: 0 })),
    value,
  );

  assert.equal(response.status, 400);
  assert.equal(calls.length, 1);
});

test("rejects oversized QStash requests before verification", async () => {
  const { calls, value } = dependencies();
  const response = await receiveQStashJob(
    request("{}", { "content-length": String(MAX_QSTASH_BODY_BYTES + 1) }),
    value,
  );

  assert.equal(response.status, 413);
  assert.deepEqual(calls, []);
});

test("returns a retryable response when triage processing fails", async () => {
  const errors = [];
  const { calls, value } = dependencies({
    process: async () => {
      throw new Error("database unavailable");
    },
    onProcessingError: (payload, error) => errors.push([payload, error.message]),
  });
  const response = await receiveQStashJob(request(), value);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.deepEqual(errors, [[message, "database unavailable"]]);
  assert.equal(calls.length, 1);
});
