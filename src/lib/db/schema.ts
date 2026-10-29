import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const installations = pgTable("installations", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repositories = pgTable(
  "repositories",
  {
    id: serial("id").primaryKey(),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    llmMode: text("llm_mode").notNull().default("primary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("repositories_full_name_uidx").on(table.fullName)],
);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  action: text("action"),
  repoName: text("repo_name"),
  runId: bigint("run_id", { mode: "bigint" }),
  runAttempt: integer("run_attempt"),
  signatureValid: boolean("signature_valid").notNull(),
  outcome: text("outcome").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ciRuns = pgTable(
  "ci_runs",
  {
    id: serial("id").primaryKey(),
    repositoryId: integer("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    runId: bigint("run_id", { mode: "bigint" }).notNull(),
    runAttempt: integer("run_attempt").notNull(),
    workflowName: text("workflow_name").notNull(),
    headSha: text("head_sha").notNull(),
    headBranch: text("head_branch").notNull(),
    baseSha: text("base_sha"),
    pullRequestNumber: integer("pull_request_number"),
    conclusion: text("conclusion").notNull(),
    htmlUrl: text("html_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ci_runs_repository_run_attempt_uidx").on(
      table.repositoryId,
      table.runId,
      table.runAttempt,
    ),
  ],
);

export const triageJobs = pgTable(
  "triage_jobs",
  {
    id: uuid("id").primaryKey(),
    ciRunId: integer("ci_run_id")
      .notNull()
      .references(() => ciRuns.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    queueMessageId: text("queue_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("triage_jobs_ci_run_uidx").on(table.ciRunId)],
);

export const failedJobs = pgTable(
  "failed_jobs",
  {
    id: serial("id").primaryKey(),
    ciRunId: integer("ci_run_id")
      .notNull()
      .references(() => ciRuns.id, { onDelete: "cascade" }),
    jobId: bigint("job_id", { mode: "bigint" }).notNull(),
    jobName: text("job_name").notNull(),
    failedStep: text("failed_step"),
    logExcerpt: text("log_excerpt").notNull(),
    excerptBytes: integer("excerpt_bytes").notNull(),
    redactionCount: integer("redaction_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("failed_jobs_ci_run_job_uidx").on(table.ciRunId, table.jobId),
    index("failed_jobs_ci_run_idx").on(table.ciRunId),
  ],
);

export const changedFiles = pgTable(
  "changed_files",
  {
    id: serial("id").primaryKey(),
    ciRunId: integer("ci_run_id")
      .notNull()
      .references(() => ciRuns.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    changeType: text("change_type").notNull(),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    baseSha: text("base_sha"),
    htmlUrl: text("html_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("changed_files_ci_run_path_uidx").on(table.ciRunId, table.path),
    index("changed_files_ci_run_idx").on(table.ciRunId),
  ],
);

export const triageResults = pgTable("triage_results", {
  id: serial("id").primaryKey(),
  ciRunId: integer("ci_run_id")
    .notNull()
    .references(() => ciRuns.id, { onDelete: "cascade" }),
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  category: text("category").notNull(),
  confidence: text("confidence").notNull(),
  summary: text("summary").notNull(),
  causes: jsonb("causes").$type<{ explanation: string; evidence_lines: number[] }[]>().notNull(),
  suspectFiles: jsonb("suspect_files")
    .$type<{ path: string; reason: string; score: number }[]>()
    .notNull(),
  nextSteps: jsonb("next_steps").$type<string[]>().notNull(),
  degraded: boolean("degraded").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const triageEvents = pgTable(
  "triage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    triageJobId: uuid("triage_job_id")
      .notNull()
      .references(() => triageJobs.id, { onDelete: "cascade" }),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  },
  (table) => [index("triage_events_job_at_idx").on(table.triageJobId, table.at)],
);

export interface TriageQueueMessage {
  deliveryId: string;
  triageJobId: string;
  installationId: number;
  repository: string;
  runId: string;
  runAttempt: number;
}

export interface GitHubRunMetadata {
  headSha: string;
  headBranch: string;
  baseSha: string | null;
  pullRequestNumber: number | null;
}

export const queueOutbox = pgTable(
  "queue_outbox",
  {
    id: uuid("id").primaryKey(),
    triageJobId: uuid("triage_job_id")
      .notNull()
      .references(() => triageJobs.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<TriageQueueMessage>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    replayCount: integer("replay_count").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    queueMessageId: text("queue_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("queue_outbox_triage_job_uidx").on(table.triageJobId),
    index("queue_outbox_pending_idx").on(table.status, table.createdAt),
    index("queue_outbox_reconcile_idx").on(table.status, table.leaseUntil, table.createdAt),
  ],
);
