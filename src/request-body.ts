import { readBody, BodyTooLarge } from "./protocol.ts";

// Reservations cover body parsing and request handling, including multipart copies.
// Limit simultaneous large uploads/MCP bodies and aggregate input reservations.
const memoryBudget = 192 * 1024 * 1024;
let reservedBytes = 0;
let activeRequests = 0;
let largeRequests = 0;
export class BodyBusy extends Error {}
export function reserveBody(limit: number): () => void {
  const large = limit > 1024 * 1024;
  if (
    activeRequests >= 16 ||
    reservedBytes + limit > memoryBudget ||
    (large && largeRequests >= 1)
  )
    throw new BodyBusy();
  reservedBytes += limit;
  activeRequests++;
  if (large) largeRequests++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedBytes -= limit;
    activeRequests--;
    if (large) largeRequests--;
  };
}
export async function bufferRequest(
  request: Request,
  limit: number,
): Promise<Request> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > limit) throw new BodyTooLarge();
  const bytes = await readBody(request.body, limit);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: new Uint8Array(bytes),
  });
}
