import { createHash } from "node:crypto";
import type { PendingTriageJob } from "./github-webhook.ts";

export function createTriageDeduplicationId(pendingJob: PendingTriageJob): string {
  return createHash("sha256")
    .update(
      `${pendingJob.payload.repository}:${pendingJob.payload.runId}:${pendingJob.payload.runAttempt}:${pendingJob.replayCount}`,
    )
    .digest("hex");
}
