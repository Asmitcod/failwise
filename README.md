# Failwise

Failwise is a GitHub Actions failure-triage assistant. It listens for
completed failed workflows, collects the relevant job logs and changed files,
sanitizes the evidence, classifies common failure patterns, and presents
actionable debugging guidance in a dashboard.

It is designed to reduce the time developers spend opening long CI logs and
manually finding the first useful error.

## Live links

- **Failwise dashboard:** <https://failwise.vercel.app>
- **Install the GitHub App:** <https://github.com/settings/apps/failwise-triage/installations>
- **GitHub App settings:** <https://github.com/settings/apps/failwise-triage>
- **Project repository:** <https://github.com/Asmitcod/failwise>
- **Vercel project:** <https://vercel.com/asmits-projects-d56bba2b/failwise>
- **Upstash console:** <https://console.upstash.com/qstash>

## How it works

```text
GitHub Actions workflow fails
        |
        v
GitHub workflow_run webhook
        |
        v
Failwise stores the run in Neon Postgres
        |
        v
QStash publishes a durable background job
        |
        v
GitHub App collects failed logs and changed files
        |
        v
Failwise sanitizes and classifies the evidence
        |
        v
The dashboard shows the result
```

Failwise only reads GitHub data and does not modify repositories, rerun
workflows, commit code, or call an LLM provider.

## What users see

For each failed run, the dashboard can show:

- Repository, workflow, branch, commit, and run status
- Failed job and failed step
- Sanitized log evidence
- Failure classification and confidence
- Suspected changed files
- Evidence lines and suggested next steps
- A link back to the original GitHub Actions run
- Processing state such as queued, processing, completed, or failed

Supported rule-based classifications include common type-check, test,
dependency, lint, build, configuration, permission, and timeout failures.
Unknown failures are still stored with their sanitized evidence for manual
investigation.

## How to use the deployed app

### 1. Install the GitHub App

Open the [Failwise GitHub App installation
page](https://github.com/settings/apps/failwise-triage/installations).

Choose the GitHub account or organization where the repository lives, then:

1. Select **Only select repositories** for a controlled installation, or
   choose all repositories if appropriate.
2. Select the repositories to monitor.
3. Approve the requested read-only permissions.
4. Complete the installation.

The app requires:

- **Actions:** Read-only
- **Contents:** Read-only
- **Pull requests:** Read-only

The GitHub App must be installed on every repository whose workflow failures
should be analyzed.

### 2. Run GitHub Actions normally

No local installation is required. After the App is installed, developers
continue pushing code and opening pull requests as usual. When a workflow
finishes with `failure` or `timed_out`, Failwise receives the event
automatically.

Successful workflow runs are ignored.

### 3. Open the dashboard

Visit [https://failwise.vercel.app](https://failwise.vercel.app), select the
repository or run, and open its details. A new run may initially appear as
**Queued** while QStash processes it. Refresh after a few seconds to see the
collected evidence and classification.

## Important security notes

- Failwise uses GitHub App read-only permissions.
- Webhook signatures are verified before processing.
- QStash signatures are verified by the worker and failure callback.
- Log excerpts are size-limited and sanitized before persistence.
- Secrets and common GitHub tokens are redacted from stored evidence.
- Raw GitHub webhook request bodies are not stored.
- Do not share `DATABASE_URL`, private keys, QStash tokens, webhook secrets,
  signing keys, or reconciliation secrets.

## Architecture

- **Next.js:** dashboard and API routes
- **GitHub App:** least-privilege access to Actions, Contents, and pull
  request data
- **Neon Postgres:** durable runs, jobs, logs, results, and outbox records
- **Upstash QStash:** asynchronous delivery, retries, and failure callbacks
- **Deterministic rules engine:** explainable classification without an AI
  provider
- **Vercel:** production deployment

Production endpoints:

```text
POST https://failwise.vercel.app/api/webhooks/github
POST https://failwise.vercel.app/api/webhooks/qstash
POST https://failwise.vercel.app/api/webhooks/qstash/failure
POST https://failwise.vercel.app/api/operations/reconcile-outbox
```

The webhook endpoints are POST-only. Opening them in a browser sends GET and
returns `405 Method Not Allowed`, which is expected.

## Local development

### Requirements

- Node.js 22.6 or newer
- npm
- A Postgres-compatible database for live webhook processing

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env.local` and configure the required values. Then
apply migrations and start the development server:

```bash
npm run db:migrate
npm run dev
```

Open <http://localhost:3000>.

Without `DATABASE_URL`, the dashboard displays a clearly labeled demo
preview. Live webhook processing requires the database and provider settings.

## Production configuration

Configure these variables in the Vercel **Production** environment:

```text
DATABASE_URL
GITHUB_WEBHOOK_SECRET
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
QSTASH_TOKEN
QSTASH_URL
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
QSTASH_WORKER_URL
OUTBOX_RECONCILE_SECRET
```

For the current QStash account, use the US East regional API endpoint:

```text
QSTASH_URL=https://qstash-us-east-1.upstash.io
```

The worker URL must be:

```text
QSTASH_WORKER_URL=https://failwise.vercel.app/api/webhooks/qstash
```

Do not include quotes, `Bearer`, or extra whitespace when entering values in
Vercel.

### GitHub webhook configuration

In the [GitHub App
settings](https://github.com/settings/apps/failwise-triage), configure:

```text
Webhook URL:
https://failwise.vercel.app/api/webhooks/github
```

Use the same value for `GITHUB_WEBHOOK_SECRET` in Vercel. Subscribe to the
**Workflow runs** event. No write permissions or unrelated webhook events are
required.

### QStash configuration

QStash publishes jobs to:

```text
https://failwise.vercel.app/api/webhooks/qstash
```

The failure callback is configured automatically for each published message:

```text
https://failwise.vercel.app/api/webhooks/qstash/failure
```

### Outbox reconciliation

If a webhook is stored but QStash is temporarily unavailable, the run remains
in the database outbox for retry. Schedule an authenticated POST every five
minutes using a cron provider:

```text
URL:
https://failwise.vercel.app/api/operations/reconcile-outbox

Method:
POST

Header:
Authorization: Bearer YOUR_OUTBOX_RECONCILE_SECRET
```

The endpoint processes up to 25 messages per call. A healthy response looks
like:

```json
{
  "scanned": 1,
  "published": 1,
  "skipped": 0,
  "failed": 0
}
```

## Validation

```bash
npm test
npm run lint
npm run build
```

Database migrations are applied with:

```bash
npm run db:migrate
```

## Current scope and future work

Implemented:

- GitHub workflow failure webhooks
- Idempotent persistence
- Durable QStash publication and retries
- QStash dead-letter callbacks
- GitHub job-log and changed-file collection
- Secret sanitization and bounded excerpts
- Deterministic failure classification
- Dashboard search, filters, pagination, and run details
- Authenticated outbox reconciliation

Not currently connected:

- User authentication and multi-tenant access control
- Slack, email, or Teams notifications
- LLM-based explanations
- Automatic issue creation or pull-request comments
- Organization-level analytics and ownership routing

## License and repository

Failwise is maintained in the
[Asmitcod/failwise repository](https://github.com/Asmitcod/failwise).
