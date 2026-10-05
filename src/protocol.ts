export const MAX_HTTP_BODY = 16 * 1024 * 1024;
export const MAX_FRAME_BYTES = 24 * 1024 * 1024;

export type Frame = {
  type: string;
  id?: string;
  tunnelId?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  status?: number;
  error?: string;
};

export function parseFrame(message: string): Frame | null {
  try {
    const value: unknown = JSON.parse(message);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const frame = value as Record<string, unknown>;
    if (typeof frame.type !== "string") return null;
    for (const key of ["id", "tunnelId", "method", "path", "body", "error"]) {
      if (frame[key] !== undefined && typeof frame[key] !== "string")
        return null;
    }
    if (
      frame.status !== undefined &&
      (!Number.isInteger(frame.status) ||
        Number(frame.status) < 200 ||
        Number(frame.status) > 599)
    )
      return null;
    if (
      frame.headers !== undefined &&
      (!frame.headers ||
        typeof frame.headers !== "object" ||
        Array.isArray(frame.headers) ||
        Object.values(frame.headers).some((value) => typeof value !== "string"))
    )
      return null;
    if (
      frame.cookies !== undefined &&
      (!Array.isArray(frame.cookies) ||
        frame.cookies.some((value) => typeof value !== "string"))
    )
      return null;
    return frame as Frame;
  } catch {
    return null;
  }
}

export async function readBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 30_000);
  timer.unref();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new BodyReadTimeout();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export class BodyTooLarge extends Error {
  constructor() {
    super("Body exceeds the configured size limit.");
  }
}

export function proxyHeaders(
  headers: Headers,
  decoded = false,
): Record<string, string> {
  const skip = new Set([
    "host",
    "connection",
    "upgrade",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "content-length",
    "set-cookie",
  ]);
  if (decoded) skip.add("content-encoding");
  for (const name of (headers.get("connection") || "").split(","))
    skip.add(name.trim().toLowerCase());
  return Object.fromEntries([...headers].filter(([key]) => !skip.has(key)));
}

export class BodyReadTimeout extends Error {}
