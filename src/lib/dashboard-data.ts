import { and, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { analyzeFailure, type TriageResult } from "./triage.ts";
import { getDatabase } from "./db/index.ts";
import {
  changedFiles,
  ciRuns,
  failedJobs,
  repositories,
  triageJobs,
  triageResults,
} from "./db/schema.ts";
import { demoRun } from "./demo-run.ts";

const FAILURE_CATEGORIES = [
  "test",
  "build",
  "lint_type",
  "dependency",
  "infra_timeout",
  "ci_config",
  "unknown",
] as const;
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export interface DashboardRunSummary {
  key: string;
  runId: string;
  attempt: number;
  repository: string;
  workflowName: string;
  branch: string;
  conclusion: string;
  state: string;
  htmlUrl: string;
  createdAt: Date;
}

export interface DashboardRunDetail extends DashboardRunSummary {
  headSha: string;
  failedJob: string;
  analysis: TriageResult;
  changedFiles: {
    path: string;
    changeType: string;
    additions: number;
    deletions: number;
  }[];
}

export interface DashboardFilters {
  search?: string;
  state?: string;
  page?: number;
}

export interface DashboardPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type DashboardData =
  | {
      mode: "live" | "demo";
      runs: DashboardRunSummary[];
      selectedRun: DashboardRunDetail | null;
      pagination: DashboardPagination;
    }
  | { mode: "error"; message: string };

const HISTORY_PAGE_SIZE = 25;

function isFailureCategory(value: string): value is (typeof FAILURE_CATEGORIES)[number] {
  return (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

function isConfidenceLevel(value: string): value is (typeof CONFIDENCE_LEVELS)[number] {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

function matchesFilters(run: DashboardRunSummary, filters: DashboardFilters): boolean {
  const search = filters.search?.trim().toLowerCase();
  const matchesSearch =
    !search ||
    [run.repository, run.workflowName, run.runId, run.branch].some((value) =>
      value.toLowerCase().includes(search),
    );
  const matchesState = !filters.state || filters.state === "all" || run.state === filters.state;
  return matchesSearch && matchesState;
}

function demoDashboardData(filters: DashboardFilters): DashboardData {
  const analysis = analyzeFailure(demoRun.log, demoRun.changedFiles);
  const createdAt = new Date("2026-10-28T15:22:11.410Z");
  const summary: DashboardRunSummary = {
    key: "demo",
    runId: demoRun.runNumber.toString(),
    attempt: 1,
    repository: demoRun.repository,
    workflowName: "Build and test",
    branch: demoRun.branch,
    conclusion: "failure",
    state: "failed",
    htmlUrl: demoRun.runUrl,
    createdAt,
  };

  const runs = matchesFilters(summary, filters) ? [summary] : [];
  return {
    mode: "demo",
    runs,
    selectedRun: runs.length
      ? {
      ...summary,
      headSha: demoRun.commit,
      failedJob: demoRun.failedJob,
      analysis,
      changedFiles: demoRun.changedFiles,
      }
      : null,
    pagination: { page: 1, pageSize: HISTORY_PAGE_SIZE, total: runs.length, totalPages: 1 },
  };
}

export async function getDashboardData(
  selectedKey?: string,
  filters: DashboardFilters = {},
): Promise<DashboardData> {
  if (!process.env.DATABASE_URL) return demoDashboardData(filters);

  try {
    const db = getDatabase();
    const conditions = [];
    const search = filters.search?.trim();
    if (search) {
      const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
      const pattern = `%${escapedSearch}%`;
      conditions.push(
        or(
          ilike(repositories.fullName, pattern),
          ilike(ciRuns.workflowName, pattern),
          ilike(ciRuns.headBranch, pattern),
          sql`${ciRuns.runId}::text ILIKE ${pattern}`,
        ),
      );
    }

    if (filters.state && filters.state !== "all") {
      conditions.push(
        filters.state === "queued"
          ? or(isNull(triageJobs.state), eq(triageJobs.state, "queued"))
          : eq(triageJobs.state, filters.state),
      );
    }

    const whereClause = conditions.length ? and(...conditions) : undefined;
    const countRows = await db
      .select({ total: count() })
      .from(ciRuns)
      .innerJoin(repositories, eq(ciRuns.repositoryId, repositories.id))
      .leftJoin(triageJobs, eq(triageJobs.ciRunId, ciRuns.id))
      .where(whereClause);
    const total = countRows[0]?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
    const page = Math.min(Math.max(1, Math.floor(filters.page ?? 1)), totalPages);
    const rows = await db
      .select({
        key: ciRuns.id,
        runId: ciRuns.runId,
        attempt: ciRuns.runAttempt,
        repository: repositories.fullName,
        workflowName: ciRuns.workflowName,
        branch: ciRuns.headBranch,
        headSha: ciRuns.headSha,
        conclusion: ciRuns.conclusion,
        htmlUrl: ciRuns.htmlUrl,
        createdAt: ciRuns.createdAt,
        jobState: triageJobs.state,
      })
      .from(ciRuns)
      .innerJoin(repositories, eq(ciRuns.repositoryId, repositories.id))
      .leftJoin(triageJobs, eq(triageJobs.ciRunId, ciRuns.id))
      .where(whereClause)
      .orderBy(desc(ciRuns.createdAt))
      .limit(HISTORY_PAGE_SIZE)
      .offset((page - 1) * HISTORY_PAGE_SIZE);

    const pagination = {
      page,
      pageSize: HISTORY_PAGE_SIZE,
      total,
      totalPages,
    };

    const allRuns: DashboardRunSummary[] = rows.map((row) => ({
      key: row.key.toString(),
      runId: row.runId.toString(),
      attempt: row.attempt,
      repository: row.repository,
      workflowName: row.workflowName,
      branch: row.branch,
      conclusion: row.conclusion,
      state: row.jobState ?? "queued",
      htmlUrl: row.htmlUrl,
      createdAt: row.createdAt,
    }));
    const runs = allRuns;

    if (!runs.length) return { mode: "live", runs, selectedRun: null, pagination };
    const summary = runs.find((run) => run.key === selectedKey) ?? runs[0];
    const selectedKeyNumber = Number(summary.key);
    if (!Number.isSafeInteger(selectedKeyNumber) || selectedKeyNumber <= 0) {
      throw new Error("Selected run key is invalid.");
    }
    const selected = rows.find((row) => row.key === selectedKeyNumber);
    if (!selected) throw new Error("Selected run disappeared while loading details.");

    const [storedJobs, storedFiles, storedResults] = await Promise.all([
      db
        .select({
          jobName: failedJobs.jobName,
          failedStep: failedJobs.failedStep,
          logExcerpt: failedJobs.logExcerpt,
        })
        .from(failedJobs)
        .where(eq(failedJobs.ciRunId, selected.key))
        .orderBy(failedJobs.id),
      db
        .select({
          path: changedFiles.path,
          changeType: changedFiles.changeType,
          additions: changedFiles.additions,
          deletions: changedFiles.deletions,
        })
        .from(changedFiles)
        .where(eq(changedFiles.ciRunId, selected.key))
        .orderBy(changedFiles.path),
      db
        .select({
          summary: triageResults.summary,
          category: triageResults.category,
          confidence: triageResults.confidence,
          causes: triageResults.causes,
          suspectFiles: triageResults.suspectFiles,
          nextSteps: triageResults.nextSteps,
          degraded: triageResults.degraded,
          promptVersion: triageResults.promptVersion,
        })
        .from(triageResults)
        .where(eq(triageResults.ciRunId, selected.key))
        .orderBy(desc(triageResults.createdAt))
        .limit(1),
    ]);

    const changedFilesForRun = storedFiles;
    const rawLog = storedJobs
      .map((job) => `Job: ${job.jobName}; failed step: ${job.failedStep ?? "unknown"}\n${job.logExcerpt}`)
      .join("\n\n");
    const derived = analyzeFailure(rawLog, changedFilesForRun);

    let analysis = derived;
    const storedResult = storedResults[0];
    if (storedResult) {
      if (
        !isFailureCategory(storedResult.category) ||
        !isConfidenceLevel(storedResult.confidence)
      ) {
        throw new Error("Stored triage result has invalid or incomplete fields.");
      }

      analysis = {
        ...derived,
        summary: storedResult.summary,
        category: storedResult.category,
        confidence: storedResult.confidence,
        causes: storedResult.causes,
        suspectFiles: storedResult.suspectFiles,
        nextSteps: storedResult.nextSteps,
        degraded: storedResult.degraded,
        promptVersion: storedResult.promptVersion,
      };
    }

    return {
      mode: "live",
      runs,
      selectedRun: {
        ...summary,
        headSha: selected.headSha,
        failedJob: storedJobs.map((job) => job.jobName).join(", ") || "Awaiting job collection",
        analysis,
        changedFiles: changedFilesForRun,
      },
      pagination,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        stage: "dashboard_data",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return {
      mode: "error",
      message: "Unable to load persisted run data. Verify the database connection and apply migrations 0000–0003.",
    };
  }
}
