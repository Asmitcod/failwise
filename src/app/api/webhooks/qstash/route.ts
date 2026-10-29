import { processTriageMessage } from "@/lib/triage-worker";
import { receiveQStashJob } from "@/lib/qstash-worker";

export async function POST(request: Request): Promise<Response> {
  return receiveQStashJob(request, {
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
    process: processTriageMessage,
    onProcessingError: (message, error) => {
      console.error(
        JSON.stringify({
          deliveryId: message.deliveryId,
          triageJobId: message.triageJobId,
          stage: "triage_worker",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    },
  });
}
