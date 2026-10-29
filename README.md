# Failwise

Failwise is a read-only GitHub Actions failure triage assistant. This first
increment is a responsive dashboard backed by a deterministic rules engine and
a representative demo run. It sanitizes and caps log excerpts, classifies
common failures, ranks changed files, and suggests debugging steps without
calling an AI provider or changing repository state.

## Requirements

- Node.js 22.6 or newer
- npm

## Run locally

```bash
npm install
npm run db:migrate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

When `DATABASE_URL` is configured, the dashboard pages through all persisted
runs in batches of 25 and shows each run's stored triage result, sanitized
failed-job excerpts, and changed files. Search across stored history by
repository, workflow, branch, or run ID; filter by triage state; and select a
run from the stream to open its details. Filters, page, and selection are
reflected in the URL. Without `DATABASE_URL`, the dashboard explicitly labels
its representative demo preview; database errors are shown as an error state
rather than hidden by demo data.

The signed webhook receiver is
available at `POST /api/webhooks/github`; add this URL to a GitHub App webhook
and subscribe to the `workflow_run` event. The signed QStash worker is available
at `POST /api/webhooks/qstash`. Copy `.env.example` to `.env.local` and set
`DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `QSTASH_TOKEN`, both QStash signing keys, and
`QSTASH_WORKER_URL`. Configure a long random `OUTBOX_RECONCILE_SECRET` for
scheduled outbox recovery.

The receiver verifies GitHub's HMAC signature over the untouched request body,
rejects bodies larger than 256 KB, and handles only completed failed or timed
out runs. It persists each accepted delivery, run, triage job, timeline event,
and queue outbox record in one database transaction. A unique repository/run/
attempt key makes duplicate deliveries idempotent. Only after durable storage
does it publish to QStash; queue publication failures return `503` and leave a
retryable outbox record. Raw webhook bodies are not stored.

GitHub App permissions should be limited to Actions: read, Contents: read, and
Pull requests: read. The worker verifies QStash signatures, claims jobs with a
database lease, retrieves failed job logs and changed files, sanitizes excerpts,
and persists a deterministic triage result. Set `QSTASH_WORKER_URL` to the
public HTTPS URL of the deployed worker endpoint.
Published messages also configure a QStash failure callback at
`POST /api/webhooks/qstash/failure`. The callback verifies QStash signatures,
validates the original queue payload and retry exhaustion, and marks the
outbox/job as `dead_letter`/`failed` while recording the QStash DLQ identifier
and response status in the job timeline. Callback retries are idempotent.

> **Live delivery still requires configuration and operational follow-through:**
> apply the database migration, install the GitHub App on a repository, set all
> secrets, and configure QStash/GitHub webhooks. Schedule authenticated
> `POST /api/operations/reconcile-outbox` calls using
> `Authorization: Bearer $OUTBOX_RECONCILE_SECRET` to republish pending or
> expired publication leases. The endpoint processes up to 25 messages per call.
> Authenticated manual replay is available at
> `POST /api/operations/replay-dead-letter/{outboxId}` for entries in the QStash
> dead-letter state. It records the replay in the triage timeline and creates a
> new QStash deduplication generation. Configure external alerting for
> `dead_letter` callbacks; alert delivery is not built into this deployment.

## Validate

```bash
npm test
npm run lint
npm run build
```

`npm run db:migrate` applies the checked-in SQL migrations transactionally,
records their checksums, and requires `DATABASE_URL`.

## Project status

The dashboard uses [`src/lib/demo-run.ts`](./src/lib/demo-run.ts) only when no
database is configured. Persisted dashboard queries live in
[`src/lib/dashboard-data.ts`](./src/lib/dashboard-data.ts). Triage and
log-excerpt processing live in [`src/lib/triage.ts`](./src/lib/triage.ts).

Signed GitHub webhook intake, Postgres persistence, QStash publication and
signature-verified worker handling, GitHub Actions collection, deterministic
triage persistence, and authenticated outbox reconciliation are implemented.
LLM providers, user authentication, notifications, and history UI are not
connected yet.

No secrets or service credentials are needed to run the demo dashboard.
