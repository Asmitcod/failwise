import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  parseQStashFailureCallback,
  receiveQStashFailure,
} from "../src/lib/qstash-failure.ts";

const message = {
  deliveryId: randomUUID(),
  triageJobId: randomUUID(),
  installationId: 123,
  repository: "acme/payments",
  runId: "1842",
  runAttempt: 1,
};

function failurePayload(overrides = {}) {
  return {
    status: 503,
    retried: 3,
    maxRetries: 3,
    dlqId: "1725323658779-0",
    sourceMessageId: "msg_123",
    sourceBody: Buffer.from(JSON.stringify(message)).toString("base64"),
    ...overrides,
  };
}

function request(body = JSON.stringify(failurePayload()), headers = {}) {
  return new Request("https://failwise.test/api/webhooks/qstash/failure", {
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
        calls.push(["verify", input.body]);
        return true;
      },
      recordFailure: async (callback) => {
        calls.push(["record", callback]);
        return true;
      },
      ...overrides,
    },
  };
}

test("parses a terminal QStash callback and its original triage message", () => {
  const parsed = parseQStashFailureCallback(failurePayload());

  assert.equal(parsed.status, 503);
  assert.equal(parsed.retried, 3);
  assert.equal(parsed.maxRetries, 3);
  assert.equal(parsed.dlqId, "1725323658779-0");
  assert.equal(parsed.sourceMessageId, "msg_123");
  assert.deepEqual(parsed.message, message);
});

test("rejects callbacks before retry exhaustion or with invalid source bodies", () => {
  assert.equal(
    parseQStashFailureCallback(failurePayload({ retried: 2, maxRetries: 3 })),
    null,
  );
  assert.equal(
    parseQStashFailureCallback(failurePayload({ sourceBody: "not-base64!" })),
    null,
  );
});

test("verifies and records a valid QStash terminal failure callback", async () => {
  const { calls, value } = dependencies();
  const response = await receiveQStashFailure(request(), value);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "recorded",
    triageJobId: message.triageJobId,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "verify");
  assert.equal(calls[1][0], "record");
  assert.deepEqual(calls[1][1].message, message);
});

test("rejects invalid signatures without recording a failure", async () => {
  const { calls, value } = dependencies({
    verify: async () => false,
  });
  const response = await receiveQStashFailure(request(), value);

  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("retries callback persistence failures and acknowledges duplicate callbacks", async () => {
  const errors = [];
  const { value } = dependencies({
    recordFailure: async () => {
      throw new Error("database unavailable");
    },
    onProcessingError: (_callback, error) => errors.push(error.message),
  });
  const failedResponse = await receiveQStashFailure(request(), value);
  assert.equal(failedResponse.status, 503);
  assert.deepEqual(errors, ["database unavailable"]);

  const duplicate = await receiveQStashFailure(
    request(),
    dependencies({ recordFailure: async () => false }).value,
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).status, "already_processed_or_unknown");
});
