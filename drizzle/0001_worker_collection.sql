ALTER TABLE "ci_runs" ADD COLUMN "base_sha" text;
--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "pull_request_number" integer;
--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD COLUMN "lease_until" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "failed_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ci_run_id" integer NOT NULL,
	"job_id" bigint NOT NULL,
	"job_name" text NOT NULL,
	"failed_step" text,
	"log_excerpt" text NOT NULL,
	"excerpt_bytes" integer NOT NULL,
	"redaction_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changed_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"ci_run_id" integer NOT NULL,
	"path" text NOT NULL,
	"change_type" text NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"base_sha" text,
	"html_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"ci_run_id" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"category" text NOT NULL,
	"confidence" text NOT NULL,
	"summary" text NOT NULL,
	"causes" jsonb NOT NULL,
	"suspect_files" jsonb NOT NULL,
	"next_steps" jsonb NOT NULL,
	"degraded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "failed_jobs" ADD CONSTRAINT "failed_jobs_ci_run_id_ci_runs_id_fk" FOREIGN KEY ("ci_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "changed_files" ADD CONSTRAINT "changed_files_ci_run_id_ci_runs_id_fk" FOREIGN KEY ("ci_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_ci_run_id_ci_runs_id_fk" FOREIGN KEY ("ci_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "failed_jobs_ci_run_job_uidx" ON "failed_jobs" USING btree ("ci_run_id","job_id");
--> statement-breakpoint
CREATE INDEX "failed_jobs_ci_run_idx" ON "failed_jobs" USING btree ("ci_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "changed_files_ci_run_path_uidx" ON "changed_files" USING btree ("ci_run_id","path");
--> statement-breakpoint
CREATE INDEX "changed_files_ci_run_idx" ON "changed_files" USING btree ("ci_run_id");
