import { Client } from "@upstash/qstash";
import type { PendingTriageJob } from "@/lib/github-webhook";
import { createTriageDeduplicationId } from "@/lib/queue-deduplication";
import {
  claimQueueMessage,
  markQueueMessageFailed,
  markQueueMessagePublished,
} from "@/lib/webhook-store";

function getWorkerUrl(): string {
  const rawUrl = process.env.QSTASH_WORKER_URL;
  if (!rawUrl) {
    throw new Error("QSTASH_WORKER_URL is required before accepting failed-run webhooks.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("QSTASH_WORKER_URL must be an absolute URL.");
  }

  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("QSTASH_WORKER_URL must use HTTPS outside local development.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("QSTASH_WORKER_URL cannot contain credentials or a fragment.");
  }

  return url.toString();
}

export async function publishTriageJob(pendingJob: PendingTriageJob): Promise<boolean> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error("QSTASH_TOKEN is required before accepting failed-run webhooks.");
  }

  const workerUrl = getWorkerUrl();
  if (!(await claimQueueMessage(pendingJob))) return false;

  try {
    const client = new Client({ token, enableTelemetry: false });
    const failureCallbackUrl = new URL(workerUrl);
    failureCallbackUrl.pathname = "/api/webhooks/qstash/failure";
    failureCallbackUrl.search = "";
    failureCallbackUrl.hash = "";
    const response = await client.publishJSON({
      url: workerUrl,
      failureCallback: failureCallbackUrl.toString(),
      body: pendingJob.payload,
      retries: 3,
      deduplicationId: createTriageDeduplicationId(pendingJob),
    });

    return await markQueueMessagePublished(pendingJob, response.messageId);
  } catch (error) {
    await markQueueMessageFailed(pendingJob);
    throw error;
  }
}
