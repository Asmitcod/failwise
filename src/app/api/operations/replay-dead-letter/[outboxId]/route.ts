import { hasValidBearerSecret } from "@/lib/operations-auth";
import { publishTriageJob } from "@/lib/qstash";
import { replayDeadLetteredJob } from "@/lib/webhook-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ outboxId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const secret = process.env.OUTBOX_RECONCILE_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Outbox operations authentication is not configured." },
      { status: 503 },
    );
  }
  if (!hasValidBearerSecret(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { outboxId } = await context.params;
  if (!UUID_PATTERN.test(outboxId)) {
    return Response.json({ error: "Invalid outbox ID." }, { status: 400 });
  }

  try {
    const pendingJob = await replayDeadLetteredJob(outboxId);
    if (!pendingJob) {
      return Response.json(
        { error: "Outbox entry is not an eligible dead-lettered job." },
        { status: 409 },
      );
    }

    try {
      const published = await publishTriageJob(pendingJob);
      return Response.json(
        {
          status: "replayed",
          publication: published ? "published" : "pending_or_claimed",
          triageJobId: pendingJob.payload.triageJobId,
          replayCount: pendingJob.replayCount,
        },
        { status: 202 },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          outboxId,
          triageJobId: pendingJob.payload.triageJobId,
          stage: "dead_letter_replay_publish",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return Response.json(
        {
          error: "Replay is queued, but QStash publication failed; reconciliation can retry it.",
        },
        { status: 503 },
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        outboxId,
        stage: "dead_letter_replay",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return Response.json({ error: "Unable to replay dead-lettered job." }, { status: 500 });
  }
}
