import {
  listQueueMessagesForReconciliation,
} from "@/lib/webhook-store";
import { publishTriageJob } from "@/lib/qstash";
import { reconcileQueueOutbox } from "@/lib/outbox-reconciler";
import { hasValidBearerSecret } from "@/lib/operations-auth";

const RECONCILIATION_BATCH_SIZE = 25;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OUTBOX_RECONCILE_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Outbox reconciliation authentication is not configured." },
      { status: 503 },
    );
  }
  if (!hasValidBearerSecret(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await reconcileQueueOutbox(
      {
        list: listQueueMessagesForReconciliation,
        publish: publishTriageJob,
        onFailure: (outboxId, error) => {
          console.error(
            JSON.stringify({
              outboxId,
              stage: "outbox_reconciliation",
              errorName: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        },
      },
      RECONCILIATION_BATCH_SIZE,
    );

    return Response.json(result, { status: result.failed > 0 ? 503 : 200 });
  } catch (error) {
    console.error(
      JSON.stringify({
        stage: "outbox_reconciliation",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return Response.json({ error: "Unable to reconcile the queue outbox." }, { status: 500 });
  }
}
