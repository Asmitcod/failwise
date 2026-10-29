ALTER TABLE "queue_outbox" ADD COLUMN "lease_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "queue_outbox_reconcile_idx" ON "queue_outbox" USING btree ("status","lease_until","created_at");
