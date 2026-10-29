import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTriageDeduplicationId } from "../src/lib/queue-deduplication.ts";
import { hasValidBearerSecret } from "../src/lib/operations-auth.ts";

const pendingJob = {
  outboxId: randomUUID(),
  replayCount: 0,
  payload: {
    deliveryId: randomUUID(),
    triageJobId: randomUUID(),
    installationId: 123,
    repository: "acme/payments",
    runId: "1842",
    runAttempt: 1,
  },
};

test("manual replay uses a distinct but repeatable QStash deduplication key", () => {
  const originalId = createTriageDeduplicationId(pendingJob);
  assert.equal(createTriageDeduplicationId(pendingJob), originalId);
  assert.notEqual(
    createTriageDeduplicationId({ ...pendingJob, replayCount: 1 }),
    originalId,
  );
});

test("operations endpoints require an exact bearer secret", () => {
  const valid = new Request("https://failwise.test", {
    headers: { authorization: "Bearer operations-secret" },
  });
  const invalid = new Request("https://failwise.test", {
    headers: { authorization: "Bearer operations-secret-extra" },
  });
  const missing = new Request("https://failwise.test");

  assert.equal(hasValidBearerSecret(valid, "operations-secret"), true);
  assert.equal(hasValidBearerSecret(invalid, "operations-secret"), false);
  assert.equal(hasValidBearerSecret(missing, "operations-secret"), false);
});
