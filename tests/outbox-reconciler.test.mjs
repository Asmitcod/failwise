import assert from "node:assert/strict";
import test from "node:test";
import { reconcileQueueOutbox } from "../src/lib/outbox-reconciler.ts";

test("publishes claimable outbox entries and counts concurrent claims as skipped", async () => {
  const pending = [
    { outboxId: "outbox-1", payload: { triageJobId: "job-1" } },
    { outboxId: "outbox-2", payload: { triageJobId: "job-2" } },
  ];
  const published = [];
  let requestedLimit;
  const result = await reconcileQueueOutbox(
    {
      list: async (limit) => {
        requestedLimit = limit;
        return pending;
      },
      publish: async (job) => {
        published.push(job.outboxId);
        return job.outboxId === "outbox-1";
      },
    },
    10,
  );

  assert.equal(requestedLimit, 10);
  assert.deepEqual(published, ["outbox-1", "outbox-2"]);
  assert.deepEqual(result, { scanned: 2, published: 1, skipped: 1, failed: 0 });
});

test("continues after individual publication errors and reports failures", async () => {
  const failures = [];
  const result = await reconcileQueueOutbox({
    list: async () => [
      { outboxId: "outbox-bad", payload: {} },
      { outboxId: "outbox-good", payload: {} },
    ],
    publish: async (job) => {
      if (job.outboxId === "outbox-bad") throw new Error("QStash unavailable");
      return true;
    },
    onFailure: (id, error) => failures.push([id, error.message]),
  });

  assert.deepEqual(result, { scanned: 2, published: 1, skipped: 0, failed: 1 });
  assert.deepEqual(failures, [["outbox-bad", "QStash unavailable"]]);
});
