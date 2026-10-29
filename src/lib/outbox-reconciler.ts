import type { PendingTriageJob } from "./github-webhook";

export interface OutboxReconciliationDependencies {
  list: (limit: number) => Promise<PendingTriageJob[]>;
  publish: (pendingJob: PendingTriageJob) => Promise<boolean>;
  onFailure?: (outboxId: string, error: unknown) => void;
}

export async function reconcileQueueOutbox(
  dependencies: OutboxReconciliationDependencies,
  limit = 25,
): Promise<{ scanned: number; published: number; skipped: number; failed: number }> {
  const pendingJobs = await dependencies.list(limit);
  let published = 0;
  let skipped = 0;
  let failed = 0;

  for (const pendingJob of pendingJobs) {
    try {
      if (await dependencies.publish(pendingJob)) published += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      dependencies.onFailure?.(pendingJob.outboxId, error);
    }
  }

  return { scanned: pendingJobs.length, published, skipped, failed };
}
