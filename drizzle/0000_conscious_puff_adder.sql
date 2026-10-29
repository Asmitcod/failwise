CREATE TABLE "ci_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"run_id" bigint NOT NULL,
	"run_attempt" integer NOT NULL,
	"workflow_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"head_branch" text NOT NULL,
	"conclusion" text NOT NULL,
	"html_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"triage_job_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"queue_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"llm_mode" text DEFAULT 'primary' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"triage_job_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ci_run_id" integer NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"queue_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"repo_name" text,
	"run_id" bigint,
	"run_attempt" integer,
	"signature_valid" boolean NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_triage_job_id_triage_jobs_id_fk" FOREIGN KEY ("triage_job_id") REFERENCES "public"."triage_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_events" ADD CONSTRAINT "triage_events_triage_job_id_triage_jobs_id_fk" FOREIGN KEY ("triage_job_id") REFERENCES "public"."triage_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD CONSTRAINT "triage_jobs_ci_run_id_ci_runs_id_fk" FOREIGN KEY ("ci_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ci_runs_repository_run_attempt_uidx" ON "ci_runs" USING btree ("repository_id","run_id","run_attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_outbox_triage_job_uidx" ON "queue_outbox" USING btree ("triage_job_id");--> statement-breakpoint
CREATE INDEX "queue_outbox_pending_idx" ON "queue_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_full_name_uidx" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "triage_events_job_at_idx" ON "triage_events" USING btree ("triage_job_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "triage_jobs_ci_run_uidx" ON "triage_jobs" USING btree ("ci_run_id");