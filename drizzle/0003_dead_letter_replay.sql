ALTER TABLE "queue_outbox" ADD COLUMN "replay_count" integer DEFAULT 0 NOT NULL;
