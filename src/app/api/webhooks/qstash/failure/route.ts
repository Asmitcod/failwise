import { recordQStashFailure } from "@/lib/webhook-store";
import { receiveQStashFailure } from "@/lib/qstash-failure";

export async function POST(request: Request): Promise<Response> {
  return receiveQStashFailure(request, {
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
    recordFailure: recordQStashFailure,
    onProcessingError: (callback, error) => {
      console.error(
        JSON.stringify({
          deliveryId: callback.message.deliveryId,
          triageJobId: callback.message.triageJobId,
          dlqId: callback.dlqId,
          stage: "qstash_failure_callback",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    },
  });
}
