import { persistGitHubWebhook } from "@/lib/webhook-store";
import { publishTriageJob } from "@/lib/qstash";
import { receiveGitHubWebhook } from "@/lib/github-webhook";

export async function POST(request: Request): Promise<Response> {
  return receiveGitHubWebhook(request, {
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    persist: persistGitHubWebhook,
    publish: publishTriageJob,
    onRejectedSignature: (deliveryId) => {
      console.warn(
        JSON.stringify({
          deliveryId,
          stage: "signature_rejected",
        }),
      );
    },
    onProcessingError: (deliveryId, error) => {
      console.error(
        JSON.stringify({
          deliveryId,
          stage: "persist_or_enqueue",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    },
  });
}
