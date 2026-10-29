import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { analyzeFailure } from "./triage";
import { GitHubActionsClient, type GitHubCollection } from "./github-api";
import { getDatabase } from "./db";
import {
  changedFiles,
  ciRuns,
  failedJobs,
  installations,
  repositories,
  triageEvents,
  triageJobs,
  triageResults,
  type TriageQueueMessage,
} from "./db/schema";

const WORKER_LEASE_MS = 75_000;

interface ClaimedRun {
  jobId: string;
  ciRunId: number;
  runId: string;
  runAttempt: number;
  workflowName: string;
  installationId: number;
  repository: string;
  headSha: string;
  headBranch: string;
  baseSha: string | null;
}

async function claimTriageJob(
  message: TriageQueueMessage,
): Promise<ClaimedRun | null> {
  const db = getDatabase();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + WORKER_LEASE_MS);

  return db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .update(triageJobs)
      .set({
        state: "collecting",
        attempts: sql`${triageJobs.attempts} + 1`,
        leaseUntil,
        updatedAt: now,
      })
      .where(
        and(
          eq(triageJobs.id, message.triageJobId),
          or(
            eq(triageJobs.state, "queued"),
            and(
              eq(triageJobs.state, "collecting"),
              or(isNull(triageJobs.leaseUntil), lt(triageJobs.leaseUntil, now)),
            ),
          ),
        ),
      )
      .returning({ id: triageJobs.id, ciRunId: triageJobs.ciRunId });

    if (!claimed) return null;

    const [run] = await transaction
      .select({
        runId: ciRuns.runId,
        runAttempt: ciRuns.runAttempt,
        workflowName: ciRuns.workflowName,
        installationId: installations.id,
        repository: repositories.fullName,
        headSha: ciRuns.headSha,
        headBranch: ciRuns.headBranch,
        baseSha: ciRuns.baseSha,
      })
      .from(ciRuns)
      .innerJoin(repositories, eq(ciRuns.repositoryId, repositories.id))
      .innerJoin(installations, eq(repositories.installationId, installations.id))
      .where(eq(ciRuns.id, claimed.ciRunId))
      .limit(1);

    if (
      !run ||
      run.installationId !== message.installationId ||
      run.repository !== message.repository ||
      run.runId.toString() !== message.runId ||
      run.runAttempt !== message.runAttempt
    ) {
      throw new Error("Queue message does not match the stored GitHub run.");
    }

    await transaction.insert(triageEvents).values({
      triageJobId: claimed.id,
      fromState: "queued",
      toState: "collecting",
      detail: { deliveryId: message.deliveryId, attempt: message.runAttempt },
    });

    return {
      jobId: claimed.id,
      ciRunId: claimed.ciRunId,
      runId: run.runId.toString(),
      runAttempt: run.runAttempt,
      workflowName: run.workflowName,
      installationId: run.installationId,
      repository: run.repository,
      headSha: run.headSha,
      headBranch: run.headBranch,
      baseSha: run.baseSha,
    };
  });
}

function combineExcerpts(collection: GitHubCollection): string {
  return collection.failedJobs
    .map(
      (job) =>
        `Job: ${job.jobName}; failed step: ${job.failedStep ?? "unknown"}\n${job.logExcerpt}`,
    )
    .join("\n\n");
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 100) : "UnknownError";
}

async function saveCompletedTriage(
  run: ClaimedRun,
  collection: GitHubCollection,
  analysis: ReturnType<typeof analyzeFailure>,
): Promise<void> {
  const db = getDatabase();
  const state = analysis.degraded ? "degraded" : "completed";

  await db.transaction(async (transaction) => {
    const [updatedJob] = await transaction
      .update(triageJobs)
      .set({
        state,
        leaseUntil: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(triageJobs.id, run.jobId), eq(triageJobs.state, "collecting")))
      .returning({ id: triageJobs.id });
    if (!updatedJob) return;

    for (const job of collection.failedJobs) {
      await transaction
        .insert(failedJobs)
        .values({
          ciRunId: run.ciRunId,
          jobId: BigInt(job.jobId),
          jobName: job.jobName,
          failedStep: job.failedStep,
          logExcerpt: job.logExcerpt,
          excerptBytes: job.excerptBytes,
          redactionCount: job.redactionCount,
        })
        .onConflictDoUpdate({
          target: [failedJobs.ciRunId, failedJobs.jobId],
          set: {
            jobName: job.jobName,
            failedStep: job.failedStep,
            logExcerpt: job.logExcerpt,
            excerptBytes: job.excerptBytes,
            redactionCount: job.redactionCount,
          },
        });
    }

    await transaction
      .delete(changedFiles)
      .where(eq(changedFiles.ciRunId, run.ciRunId));
    if (collection.changedFiles.length) {
      await transaction.insert(changedFiles).values(
        collection.changedFiles.map((file) => ({
          ciRunId: run.ciRunId,
          path: file.path,
          changeType: file.changeType,
          additions: file.additions,
          deletions: file.deletions,
          baseSha: file.baseSha,
          htmlUrl: file.htmlUrl,
        })),
      );
    }

    await transaction
      .update(ciRuns)
      .set({ baseSha: collection.baseSha })
      .where(eq(ciRuns.id, run.ciRunId));

    await transaction.insert(triageResults).values({
      ciRunId: run.ciRunId,
      promptVersion: analysis.promptVersion,
      model: "rules",
      category: analysis.category,
      confidence: analysis.confidence,
      summary: analysis.summary,
      causes: analysis.causes,
      suspectFiles: analysis.suspectFiles,
      nextSteps: analysis.nextSteps,
      degraded: analysis.degraded,
    });

    await transaction.insert(triageEvents).values({
      triageJobId: run.jobId,
      fromState: "collecting",
      toState: "analyzing",
      detail: {
        failedJobs: collection.failedJobs.length,
        changedFiles: collection.changedFiles.length,
        unavailableLogs: collection.unavailableLogs,
      },
    });
    await transaction.insert(triageEvents).values({
      triageJobId: run.jobId,
      fromState: "analyzing",
      toState: state,
      detail: {
        category: analysis.category,
        degraded: analysis.degraded,
      },
    });
  });
}

async function releaseTriageJobForRetry(
  jobId: string,
  error: unknown,
): Promise<void> {
  const db = getDatabase();
  await db.transaction(async (transaction) => {
    const [releasedJob] = await transaction
      .update(triageJobs)
      .set({
        state: "queued",
        leaseUntil: null,
        lastError: safeErrorName(error),
        updatedAt: new Date(),
      })
      .where(and(eq(triageJobs.id, jobId), eq(triageJobs.state, "collecting")))
      .returning({ id: triageJobs.id });

    if (!releasedJob) return;

    await transaction.insert(triageEvents).values({
      triageJobId: jobId,
      fromState: "collecting",
      toState: "queued",
      detail: { retryable: true, errorName: safeErrorName(error) },
    });
  });
}

export async function processTriageMessage(
  message: TriageQueueMessage,
): Promise<void> {
  const run = await claimTriageJob(message);
  if (!run) return;

  try {
    const client = new GitHubActionsClient({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    });
    const collection = await client.collectFailedRun({
      repository: run.repository,
      installationId: run.installationId,
      runId: run.runId,
      runAttempt: run.runAttempt,
      workflowName: run.workflowName,
      headSha: run.headSha,
      headBranch: run.headBranch,
      baseSha: run.baseSha,
    });
    const rawLog = combineExcerpts(collection);
    const analysis = analyzeFailure(
      rawLog,
      collection.changedFiles.map(({ path, changeType, additions, deletions }) => ({
        path,
        changeType,
        additions,
        deletions,
      })),
    );
    await saveCompletedTriage(run, collection, analysis);
  } catch (error) {
    try {
      await releaseTriageJobForRetry(run.jobId, error);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Triage processing failed and its retry state could not be persisted.",
      );
    }
    throw error;
  }
}
