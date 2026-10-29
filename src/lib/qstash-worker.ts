import { Receiver } from "@upstash/qstash";
import type { TriageQueueMessage } from "./db/schema";

export const MAX_QSTASH_BODY_BYTES = 64 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID_PATTERN = /^[1-9]\d{0,19}$/;

export interface QStashWorkerDependencies {
  currentSigningKey: string | undefined;
  nextSigningKey: string | undefined;
  verify?: (input: {
    signature: string;
    body: string;
    url: string;
    upstashRegion?: string;
  }) => Promise<boolean>;
  process: (message: TriageQueueMessage) => Promise<void>;
  onProcessingError?: (message: TriageQueueMessage, error: unknown) => void;
}

export type QStashSignatureVerifier = (input: {
  signature: string;
  body: string;
  url: string;
  upstashRegion?: string;
}) => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTriageQueueMessage(value: unknown): TriageQueueMessage | null {
  if (
    !isRecord(value) ||
    typeof value.deliveryId !== "string" ||
    !UUID_PATTERN.test(value.deliveryId) ||
    typeof value.triageJobId !== "string" ||
    !UUID_PATTERN.test(value.triageJobId) ||
    typeof value.installationId !== "number" ||
    !Number.isSafeInteger(value.installationId) ||
    value.installationId <= 0 ||
    typeof value.repository !== "string" ||
    !REPOSITORY_PATTERN.test(value.repository) ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    typeof value.runAttempt !== "number" ||
    !Number.isSafeInteger(value.runAttempt) ||
    value.runAttempt <= 0
  ) {
    return null;
  }

  return {
    deliveryId: value.deliveryId,
    triageJobId: value.triageJobId,
    installationId: value.installationId,
    repository: value.repository,
    runId: value.runId,
    runAttempt: value.runAttempt,
  };
}

export async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new RangeError("QStash request body exceeds the allowed size.");
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RangeError("QStash request body exceeds the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("QStash request body is not valid UTF-8.");
  }
}

export async function verifyQStashRequest(
  request: Request,
  body: string,
  currentSigningKey: string,
  nextSigningKey: string,
  verify?: QStashSignatureVerifier,
): Promise<boolean> {
  const signature = request.headers.get("upstash-signature");
  if (!signature) return false;

  try {
    const verifySignature =
      verify ??
      (async (input) =>
        new Receiver({
          currentSigningKey,
          nextSigningKey,
          devMode: false,
        }).verify(input));
    return await verifySignature({
      signature,
      body,
      url: request.url,
      upstashRegion: request.headers.get("upstash-region") ?? undefined,
    });
  } catch {
    return false;
  }
}

export async function receiveQStashJob(
  request: Request,
  dependencies: QStashWorkerDependencies,
): Promise<Response> {
  if (!dependencies.currentSigningKey || !dependencies.nextSigningKey) {
    return Response.json(
      { error: "QStash signature verification is not configured." },
      { status: 503 },
    );
  }

  if (!request.headers.get("upstash-signature")) {
    return Response.json({ error: "Missing QStash signature." }, { status: 401 });
  }

  let body: string;
  try {
    body = await readBoundedBody(request, MAX_QSTASH_BODY_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    return Response.json({ error: "Unable to read QStash request body." }, { status: 400 });
  }

  const validSignature = await verifyQStashRequest(
    request,
    body,
    dependencies.currentSigningKey,
    dependencies.nextSigningKey,
    dependencies.verify,
  );
  if (!validSignature) {
    return Response.json({ error: "Invalid QStash signature." }, { status: 401 });
  }

  let message: TriageQueueMessage | null;
  try {
    message = parseTriageQueueMessage(JSON.parse(body));
  } catch {
    return Response.json({ error: "QStash request body is not valid JSON." }, { status: 400 });
  }
  if (!message) {
    return Response.json({ error: "Invalid triage queue message." }, { status: 400 });
  }

  try {
    await dependencies.process(message);
    return Response.json({ status: "accepted", triageJobId: message.triageJobId });
  } catch (error) {
    dependencies.onProcessingError?.(message, error);
    return Response.json(
      { error: "Triage job failed and will be retried." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
}
