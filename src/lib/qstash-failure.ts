import type { TriageQueueMessage } from "./db/schema";
import {
  MAX_QSTASH_BODY_BYTES,
  parseTriageQueueMessage,
  readBoundedBody,
  verifyQStashRequest,
  type QStashSignatureVerifier,
} from "./qstash-worker.ts";

export interface QStashFailureCallback {
  status: number;
  retried: number;
  maxRetries: number;
  dlqId: string | null;
  sourceMessageId: string;
  message: TriageQueueMessage;
}

export interface QStashFailureDependencies {
  currentSigningKey: string | undefined;
  nextSigningKey: string | undefined;
  verify?: QStashSignatureVerifier;
  recordFailure: (callback: QStashFailureCallback) => Promise<boolean>;
  onProcessingError?: (callback: QStashFailureCallback, error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQStashFailureCallback(
  value: unknown,
): QStashFailureCallback | null {
  if (
    !isRecord(value) ||
    typeof value.status !== "number" ||
    !Number.isSafeInteger(value.status) ||
    value.status < 100 ||
    value.status > 599 ||
    typeof value.retried !== "number" ||
    !Number.isSafeInteger(value.retried) ||
    value.retried < 0 ||
    typeof value.maxRetries !== "number" ||
    !Number.isSafeInteger(value.maxRetries) ||
    value.maxRetries < 0 ||
    value.retried < value.maxRetries ||
    typeof value.sourceMessageId !== "string" ||
    value.sourceMessageId.length === 0 ||
    value.sourceMessageId.length > 128 ||
    typeof value.sourceBody !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.sourceBody,
    ) ||
    (value.dlqId !== undefined &&
      value.dlqId !== null &&
      (typeof value.dlqId !== "string" || value.dlqId.length > 128))
  ) {
    return null;
  }

  const decoded = Buffer.from(value.sourceBody, "base64");
  if (decoded.toString("base64") !== value.sourceBody) return null;

  let source: unknown;
  try {
    source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    return null;
  }
  const message = parseTriageQueueMessage(source);
  if (!message) return null;

  return {
    status: value.status,
    retried: value.retried,
    maxRetries: value.maxRetries,
    dlqId: typeof value.dlqId === "string" ? value.dlqId : null,
    sourceMessageId: value.sourceMessageId,
    message,
  };
}

export async function receiveQStashFailure(
  request: Request,
  dependencies: QStashFailureDependencies,
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
    return Response.json({ error: "Unable to read QStash callback body." }, { status: 400 });
  }

  if (
    !(await verifyQStashRequest(
      request,
      body,
      dependencies.currentSigningKey,
      dependencies.nextSigningKey,
      dependencies.verify,
    ))
  ) {
    return Response.json({ error: "Invalid QStash signature." }, { status: 401 });
  }

  let callback: QStashFailureCallback | null;
  try {
    callback = parseQStashFailureCallback(JSON.parse(body));
  } catch {
    return Response.json({ error: "QStash callback body is not valid JSON." }, { status: 400 });
  }
  if (!callback) {
    return Response.json({ error: "Invalid QStash failure callback." }, { status: 400 });
  }

  try {
    const recorded = await dependencies.recordFailure(callback);
    return Response.json({
      status: recorded ? "recorded" : "already_processed_or_unknown",
      triageJobId: callback.message.triageJobId,
    });
  } catch (error) {
    dependencies.onProcessingError?.(callback, error);
    return Response.json(
      { error: "Unable to record QStash failure callback." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
}
