import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDatabase } from "@/lib/db";
import {
  ciRuns,
  installations,
  queueOutbox,
  repositories,
  triageEvents,
  triageJobs,
  webhookDeliveries,
  type TriageQueueMessage,
} from "@/lib/db/schema";
import type {
  GitHubWebhook,
  PendingTriageJob,
  PersistedWebhook,
} from "@/lib/github-webhook";
import type { QStashFailureCallback } from "@/lib/qstash-failure";

const OUTBOX_PUBLISH_LEASE_MS = 120_000;

export async function persistGitHubWebhook(
  webhook: GitHubWebhook,
): Promise<PersistedWebhook> {
  const db = getDatabase();

  return db.transaction(async (transaction) => {
    let repositoryId: number | null = null;

    if (webhook.repository && webhook.installation) {
      await transaction
        .insert(installations)
        .values({
          id: webhook.installation.id,
          accountLogin: webhook.installation.accountLogin,
          accountType: webhook.installation.accountType,
        })
        .onConflictDoUpdate({
          target: installations.id,
          set: {
            accountLogin: webhook.installation.accountLogin,
            accountType: webhook.installation.accountType,
            updatedAt: new Date(),
          },
        });

      const [repository] = await transaction
        .insert(repositories)
        .values({
          installationId: webhook.installation.id,
          fullName: webhook.repository.fullName,
          defaultBranch: webhook.repository.defaultBranch,
        })
        .onConflictDoUpdate({
          target: repositories.fullName,
          set: {
            installationId: webhook.installation.id,
            defaultBranch: webhook.repository.defaultBranch,
            updatedAt: new Date(),
          },
        })
        .returning({ id: repositories.id });

      repositoryId = repository.id;
    }

    if (!webhook.shouldTriage || !webhook.repository || !webhook.installation || !webhook.run) {
      const [delivery] = await transaction
        .insert(webhookDeliveries)
        .values({
          deliveryId: webhook.deliveryId,
          event: webhook.event,
          action: webhook.action,
          repoName: webhook.repository?.fullName ?? null,
          runId: null,
          runAttempt: null,
          signatureValid: true,
          outcome: "skipped",
        })
        .onConflictDoNothing()
        .returning({ deliveryId: webhookDeliveries.deliveryId });

      return { outcome: delivery ? "skipped" : "duplicate" };
    }

    if (repositoryId === null) {
      throw new Error("A valid GitHub installation is required to persist a failed run.");
    }

    const runId = BigInt(webhook.run.id);
    const [run] = await transaction
      .insert(ciRuns)
      .values({
        repositoryId,
        runId,
        runAttempt: webhook.run.runAttempt,
        workflowName: webhook.run.workflowName,
        headSha: webhook.run.headSha,
        headBranch: webhook.run.headBranch,
        baseSha: webhook.run.baseSha,
        pullRequestNumber: webhook.run.pullRequestNumber,
        conclusion: webhook.run.conclusion,
        htmlUrl: webhook.run.htmlUrl,
      })
      .onConflictDoUpdate({
        target: [ciRuns.repositoryId, ciRuns.runId, ciRuns.runAttempt],
        set: {
          workflowName: webhook.run.workflowName,
          headSha: webhook.run.headSha,
          headBranch: webhook.run.headBranch,
          baseSha: webhook.run.baseSha,
          pullRequestNumber: webhook.run.pullRequestNumber,
          conclusion: webhook.run.conclusion,
          htmlUrl: webhook.run.htmlUrl,
        },
      })
      .returning({ id: ciRuns.id });

    const [insertedJob] = await transaction
      .insert(triageJobs)
      .values({
        id: randomUUID(),
        ciRunId: run.id,
        state: "queued",
        attempts: 0,
      })
      .onConflictDoNothing()
      .returning({ id: triageJobs.id });

    const [job] = insertedJob
      ? [insertedJob]
      : await transaction
          .select({ id: triageJobs.id })
          .from(triageJobs)
          .where(eq(triageJobs.ciRunId, run.id))
          .limit(1);

    if (!job) {
      throw new Error("Failed to persist the triage job for a GitHub run.");
    }

    if (insertedJob) {
      await transaction.insert(triageEvents).values({
        triageJobId: job.id,
        fromState: "received",
        toState: "queued",
        detail: { deliveryId: webhook.deliveryId },
      });
    }

    const payload: TriageQueueMessage = {
      deliveryId: webhook.deliveryId,
      triageJobId: job.id,
      installationId: webhook.installation.id,
      repository: webhook.repository.fullName,
      runId: webhook.run.id.toString(),
      runAttempt: webhook.run.runAttempt,
    };

    const [insertedOutbox] = await transaction
      .insert(queueOutbox)
      .values({
        id: randomUUID(),
        triageJobId: job.id,
        payload,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({
        id: queueOutbox.id,
        payload: queueOutbox.payload,
        status: queueOutbox.status,
        replayCount: queueOutbox.replayCount,
      });

    const [outbox] = insertedOutbox
      ? [insertedOutbox]
      : await transaction
          .select({
            id: queueOutbox.id,
            payload: queueOutbox.payload,
            status: queueOutbox.status,
            replayCount: queueOutbox.replayCount,
          })
          .from(queueOutbox)
          .where(eq(queueOutbox.triageJobId, job.id))
          .limit(1);

    if (!outbox) {
      throw new Error("Failed to persist the queue outbox record.");
    }

    const [delivery] = await transaction
      .insert(webhookDeliveries)
      .values({
        deliveryId: webhook.deliveryId,
        event: webhook.event,
        action: webhook.action,
        repoName: webhook.repository.fullName,
        runId,
        runAttempt: webhook.run.runAttempt,
        signatureValid: true,
        outcome: insertedJob ? "queued" : "duplicate",
      })
      .onConflictDoNothing()
      .returning({ deliveryId: webhookDeliveries.deliveryId });

    if (!delivery && outbox.status === "published") {
      return { outcome: "duplicate" };
    }

    const pendingJob: PendingTriageJob | null =
      outbox.status === "pending"
        ? {
            outboxId: outbox.id,
            replayCount: outbox.replayCount,
            payload: outbox.payload,
          }
        : null;

    if (pendingJob) {
      return { outcome: "queued", pendingJob };
    }

    return { outcome: "duplicate" };
  });
}

export async function markQueueMessagePublished(
  pendingJob: PendingTriageJob,
  queueMessageId: string,
): Promise<boolean> {
  const db = getDatabase();
  return db.transaction(async (transaction) => {
    const [published] = await transaction
      .update(queueOutbox)
      .set({
        status: "published",
        leaseUntil: null,
        lastError: null,
        queueMessageId,
        publishedAt: new Date(),
      })
      .where(
        and(
          eq(queueOutbox.id, pendingJob.outboxId),
          eq(queueOutbox.status, "publishing"),
        ),
      )
      .returning({ id: queueOutbox.id });

    if (!published) return false;
    await transaction
      .update(triageJobs)
      .set({
        queueMessageId,
        updatedAt: new Date(),
      })
      .where(eq(triageJobs.id, pendingJob.payload.triageJobId));
    return true;
  });
}

export async function claimQueueMessage(
  pendingJob: PendingTriageJob,
): Promise<boolean> {
  const db = getDatabase();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + OUTBOX_PUBLISH_LEASE_MS);
  const [claimed] = await db
    .update(queueOutbox)
    .set({
      status: "publishing",
      leaseUntil,
      attempts: sql`${queueOutbox.attempts} + 1`,
    })
    .where(
      and(
        eq(queueOutbox.id, pendingJob.outboxId),
        or(
          eq(queueOutbox.status, "pending"),
          and(
            eq(queueOutbox.status, "publishing"),
            or(isNull(queueOutbox.leaseUntil), lt(queueOutbox.leaseUntil, now)),
          ),
        ),
      ),
    )
    .returning({ id: queueOutbox.id });
  return Boolean(claimed);
}

export async function listQueueMessagesForReconciliation(
  limit: number,
): Promise<PendingTriageJob[]> {
  const db = getDatabase();
  const now = new Date();
  return db
    .select({
      outboxId: queueOutbox.id,
      payload: queueOutbox.payload,
      replayCount: queueOutbox.replayCount,
    })
    .from(queueOutbox)
    .where(
      or(
        eq(queueOutbox.status, "pending"),
        and(
          eq(queueOutbox.status, "publishing"),
          or(isNull(queueOutbox.leaseUntil), lt(queueOutbox.leaseUntil, now)),
        ),
      ),
    )
    .orderBy(asc(queueOutbox.createdAt))
    .limit(limit);
}

export async function replayDeadLetteredJob(
  outboxId: string,
): Promise<PendingTriageJob | null> {
  const db = getDatabase();
  return db.transaction(async (transaction) => {
    const [deadLetter] = await transaction
      .select({
        id: queueOutbox.id,
        triageJobId: queueOutbox.triageJobId,
        payload: queueOutbox.payload,
        replayCount: queueOutbox.replayCount,
        status: queueOutbox.status,
        jobState: triageJobs.state,
      })
      .from(queueOutbox)
      .innerJoin(triageJobs, eq(queueOutbox.triageJobId, triageJobs.id))
      .where(eq(queueOutbox.id, outboxId))
      .limit(1);

    if (!deadLetter || deadLetter.status !== "dead_letter" || deadLetter.jobState !== "failed") {
      return null;
    }

    const [updatedOutbox] = await transaction
      .update(queueOutbox)
      .set({
        status: "pending",
        replayCount: sql`${queueOutbox.replayCount} + 1`,
        leaseUntil: null,
        lastError: null,
        queueMessageId: null,
        publishedAt: null,
      })
      .where(
        and(
          eq(queueOutbox.id, outboxId),
          eq(queueOutbox.status, "dead_letter"),
        ),
      )
      .returning({ id: queueOutbox.id });
    if (!updatedOutbox) return null;

    const [updatedJob] = await transaction
      .update(triageJobs)
      .set({
        state: "queued",
        leaseUntil: null,
        lastError: null,
        queueMessageId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(triageJobs.id, deadLetter.triageJobId),
          eq(triageJobs.state, "failed"),
        ),
      )
      .returning({ id: triageJobs.id });
    if (!updatedJob) {
      throw new Error("Dead-letter job changed state while being replayed.");
    }

    await transaction.insert(triageEvents).values({
      triageJobId: updatedJob.id,
      fromState: "failed",
      toState: "queued",
      detail: {
        action: "manual_replay",
        outboxId,
        replayCount: deadLetter.replayCount + 1,
      },
    });

    return {
      outboxId,
      replayCount: deadLetter.replayCount + 1,
      payload: deadLetter.payload,
    };
  });
}

export async function markQueueMessageFailed(
  pendingJob: PendingTriageJob,
): Promise<void> {
  const db = getDatabase();
  await db
    .update(queueOutbox)
    .set({
      status: "pending",
      leaseUntil: null,
      lastError: "QStash did not accept the queue message.",
    })
    .where(
      and(
        eq(queueOutbox.id, pendingJob.outboxId),
        eq(queueOutbox.status, "publishing"),
      ),
    );
}

export async function recordQStashFailure(
  callback: QStashFailureCallback,
): Promise<boolean> {
  const db = getDatabase();
  return db.transaction(async (transaction) => {
    const [outbox] = await transaction
      .select({
        id: queueOutbox.id,
        status: queueOutbox.status,
        triageJobId: queueOutbox.triageJobId,
        payload: queueOutbox.payload,
        queueMessageId: queueOutbox.queueMessageId,
        jobState: triageJobs.state,
      })
      .from(queueOutbox)
      .innerJoin(triageJobs, eq(queueOutbox.triageJobId, triageJobs.id))
      .where(eq(queueOutbox.triageJobId, callback.message.triageJobId))
      .limit(1);

    if (
      !outbox ||
      (outbox.status !== "published" && outbox.status !== "publishing") ||
      (outbox.queueMessageId !== null &&
        outbox.queueMessageId !== callback.sourceMessageId) ||
      outbox.payload.deliveryId !== callback.message.deliveryId ||
      outbox.payload.installationId !== callback.message.installationId ||
      outbox.payload.repository !== callback.message.repository ||
      outbox.payload.runId !== callback.message.runId ||
      outbox.payload.runAttempt !== callback.message.runAttempt
    ) {
      return false;
    }

    const [updatedOutbox] = await transaction
      .update(queueOutbox)
      .set({
        status: "dead_letter",
        leaseUntil: null,
        lastError: `QStash delivery exhausted retries with HTTP ${callback.status}.`,
        queueMessageId: callback.sourceMessageId,
      })
      .where(
        and(
          eq(queueOutbox.id, outbox.id),
          or(
            eq(queueOutbox.status, "published"),
            and(
              eq(queueOutbox.status, "publishing"),
              isNull(queueOutbox.queueMessageId),
            ),
          ),
          or(
            eq(queueOutbox.queueMessageId, callback.sourceMessageId),
            isNull(queueOutbox.queueMessageId),
          ),
        ),
      )
      .returning({ id: queueOutbox.id });
    if (!updatedOutbox) return false;

    const [failedJob] = await transaction
      .update(triageJobs)
      .set({
        state: "failed",
        leaseUntil: null,
        lastError: `QStash delivery exhausted retries with HTTP ${callback.status}.`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(triageJobs.id, outbox.triageJobId),
          or(eq(triageJobs.state, "queued"), eq(triageJobs.state, "collecting")),
        ),
      )
      .returning({ id: triageJobs.id });

    if (failedJob) {
      await transaction.insert(triageEvents).values({
        triageJobId: failedJob.id,
        fromState: outbox.jobState,
        toState: "failed",
        detail: {
          status: callback.status,
          retried: callback.retried,
          maxRetries: callback.maxRetries,
          dlqId: callback.dlqId,
          sourceMessageId: callback.sourceMessageId,
        },
      });
    }

    return true;
  });
}
