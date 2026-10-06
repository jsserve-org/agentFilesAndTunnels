import { reserveBody, bufferRequest, BodyBusy } from "./request-body.ts";
import {
  sitesDomain,
  tunnelsDomain,
  tunnelURLMode,
  filesHost,
  filesOrigin,
  validHostname,
} from "./domains.ts";
import { serve } from "@hono/node-server";
import { WebSocket as AgentSocket, WebSocketServer } from "ws";
import { openAsBlob } from "node:fs";
import { createHash, randomInt } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { accountAuth, issueKey, revokeKey } from "./auth.ts";
import {
  db,
  id,
  now,
  type Agent,
  type StoredFile,
  type Tunnel,
  type User,
} from "./db.ts";
import { page } from "./ui.ts";
import {
  createSite,
  updateSite,
  deleteSite,
  serveSite,
  showSite,
  siteLogin,
  SiteError,
  type Site,
} from "./sites.ts";
import {
  defaultLimits,
  limitsFor,
  usageFor,
  parseLimits,
  saveLimits,
} from "./usage.ts";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server as TcpServer, type Socket } from "node:net";
import {
  MAX_HTTP_BODY,
  MAX_FRAME_BYTES,
  parseFrame,
  readBody,
  BodyTooLarge,
  BodyReadTimeout,
  proxyHeaders,
  type Frame as Wire,
} from "./protocol.ts";

const port = Number(process.env.PORT || 3000);
const publicOrigin = (
  process.env.PUBLIC_ORIGIN || `http://localhost:${port}`
).replace(/\/$/, "");
const baseDomain = process.env.BASE_DOMAIN || new URL(publicOrigin).hostname;
function tcpPublicHost(): string {
  return (
    (
      db
        .prepare("SELECT value FROM settings WHERE key='tcp_public_host'")
        .get() as { value: string } | undefined
    )?.value ||
    process.env.TCP_PUBLIC_HOST ||
    baseDomain
  );
}
const tcpStart = Number(process.env.TCP_PORT_START || 20000);
const tcpEnd = Number(process.env.TCP_PORT_END || 20099);
const dataDir = process.env.DATA_DIR || "./data";
const filesDir = join(dataDir, "files");
const maxFile = Number(process.env.MAX_FILE_BYTES || 100 * 1024 * 1024);
const retention =
  Math.max(72, Number(process.env.FILE_RETENTION_HOURS || 72)) * 3600_000;
const maxUserStorage = Number(
  process.env.MAX_USER_STORAGE_BYTES || 1024 * 1024 * 1024,
);
if (
  !Number.isInteger(tcpStart) ||
  !Number.isInteger(tcpEnd) ||
  tcpStart < 1024 ||
  tcpEnd > 65535 ||
  tcpStart > tcpEnd
)
  throw new Error("Invalid TCP port range. Use ports 1024–65535.");
if (
  ![maxFile, retention, maxUserStorage].every(
    (n) => Number.isFinite(n) && n > 0,
  )
)
  throw new Error("Invalid file storage configuration.");
mkdirSync(filesDir, { recursive: true });

type Connection = { agentId: string; userId: string };
type WebSocket = AgentSocket & { data: Connection };
type Principal = User & { agentId?: string };
const connections = new Map<string, WebSocket>();
const pending = new Map<
  string,
  {
    resolve: (value: Wire) => void;
    timer: ReturnType<typeof setTimeout>;
    agentId: string;
    tunnelId: string;
  }
>();
const tcpListeners = new Map<string, TcpServer>();
const tcpSockets = new Map<
  string,
  {
    socket: Socket;
    agentId: string;
    tunnelId: string;
    acknowledgements: number;
  }
>();
const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
const fail = (error: string, status = 400) => json({ error }, status);
const bearer = (request: Request) =>
  request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
async function auth(request: Request): Promise<Principal | null> {
  const token = bearer(request);
  if (!token) {
    const session = await accountAuth.api.getSession({
      headers: request.headers,
    });
    return session ? { id: session.user.id, email: session.user.email } : null;
  }
  const session = await accountAuth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  if (session) {
    const agent = db
      .prepare("SELECT id FROM agents WHERE user_id=? AND key_id=?")
      .get(session.user.id, `oauth:${session.session.id}`) as
      { id: string } | undefined;
    if (agent)
      return {
        id: session.user.id,
        email: session.user.email,
        agentId: agent.id,
      };
  }
  const verified = await accountAuth.api.verifyApiKey({ body: { key: token } });
  if (!verified.valid || !verified.key) return null;
  const user = db
    .prepare("SELECT id,email FROM users WHERE id=?")
    .get(verified.key.referenceId) as User | null;
  if (!user) return null;
  const agent = db
    .prepare("SELECT id FROM agents WHERE key_id=? AND user_id=?")
    .get(verified.key.id, user.id) as { id: string } | null;
  if (agent) return { ...user, agentId: agent.id };
  return db
    .prepare("SELECT id FROM account_keys WHERE id=? AND user_id=?")
    .get(verified.key.id, user.id)
    ? user
    : null;
}
async function agentAuth(
  request: Request,
  agentId: string,
): Promise<Agent | null> {
  const principal = await auth(request);
  if (principal?.agentId !== agentId) return null;
  return db
    .prepare("SELECT * FROM agents WHERE id=? AND user_id=?")
    .get(agentId, principal.id) as Agent | null;
}
async function revokeAgentCredential(agent: Agent) {
  if (!agent.key_id.startsWith("oauth:"))
    return revokeKey(agent.user_id, agent.key_id);
  const sessionId = agent.key_id.slice(6);
  const session = db
    .prepare("SELECT token FROM session WHERE id=?")
    .get(sessionId) as { token: string } | undefined;
  if (session)
    await (
      await accountAuth.$context
    ).internalAdapter.deleteSession(session.token);
  db.prepare("DELETE FROM settings WHERE key=?").run(
    `device_session:${sessionId}`,
  );
}
async function removeAgent(agent: Agent) {
  await revokeAgentCredential(agent);
  const tunnels = db
    .prepare("SELECT * FROM tunnels WHERE agent_id=? AND stopped_at IS NULL")
    .all(agent.id) as Tunnel[];
  for (const tunnel of tunnels) stopTunnel(tunnel);
  const ws = connections.get(agent.id);
  closeAgent(agent.id);
  ws?.close(4001, "Agent revoked");
  db.prepare("DELETE FROM agents WHERE id=?").run(agent.id);
}
function removeFile(fileId: string) {
  try {
    unlinkSync(join(filesDir, fileId));
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  db.prepare("DELETE FROM files WHERE id=?").run(fileId);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function string(value: unknown, max = 200) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max
    ? value.trim()
    : null;
}
function isLocalHost(host: string) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
function tunnelUrl(t: Tunnel) {
  return `${new URL(publicOrigin).protocol}//${t.public_slug || t.id}.${tunnelsDomain()}`;
}
function showTunnel(t: Tunnel) {
  return {
    ...t,
    online: connections.has(t.agent_id),
    url: t.kind === "http" ? tunnelUrl(t) : null,
    address: t.kind === "tcp" ? `${tcpPublicHost()}:${t.public_port}` : null,
  };
}
function showFile(file: StoredFile) {
  return {
    ...file,
    expires_at: file.expires_at === 0 ? null : file.expires_at,
    permanent: file.expires_at === 0,
    url: fileUrl(file.id),
  };
}
function fileUrl(fileId: string) {
  return `${filesOrigin()}/f/${fileId}`;
}
function send(ws: WebSocket, value: Wire) {
  try {
    if (ws.readyState !== AgentSocket.OPEN) return;
    if (ws.bufferedAmount > 32 * 1024 * 1024) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(value));
  } catch {
    /* connection cleanup handles this */
  }
}
function closeAgent(agentId: string) {
  connections.delete(agentId);
  for (const [key, value] of tcpSockets)
    if (value.agentId === agentId) {
      value.socket.destroy();
      tcpSockets.delete(key);
    }
  for (const [key, value] of pending)
    if (value.agentId === agentId) {
      clearTimeout(value.timer);
      pending.delete(key);
      value.resolve({
        type: "http_response",
        status: 503,
        error: "Laptop disconnected. Reconnect and try again.",
      });
    }
}
async function listenTcp(t: Tunnel) {
  if (t.kind !== "tcp" || !t.public_port || tcpListeners.has(t.id)) return;
  const listener = createServer({ allowHalfOpen: true }, (socket) => {
    const ws = connections.get(t.agent_id);
    if (
      !ws ||
      [...tcpSockets.values()].filter((s) => s.agentId === t.agent_id).length >=
        128
    ) {
      socket.destroy();
      return;
    }
    socket.pause();
    const streamId = id();
    const stream = {
      socket,
      agentId: t.agent_id,
      tunnelId: t.id,
      acknowledgements: 0,
    };
    tcpSockets.set(streamId, stream);
    send(ws, { type: "tcp_open", id: streamId, tunnelId: t.id });
    socket.on("data", (data) => {
      const chunk = Buffer.from(data);
      socket.pause();
      for (let offset = 0; offset < chunk.length; offset += 48 * 1024) {
        stream.acknowledgements++;
        send(ws, {
          type: "tcp_data",
          id: streamId,
          body: chunk.subarray(offset, offset + 48 * 1024).toString("base64"),
        });
      }
    });
    socket.on("end", () => send(ws, { type: "tcp_end", id: streamId }));
    socket.on("close", () => {
      tcpSockets.delete(streamId);
      send(ws, { type: "tcp_close", id: streamId });
    });
    socket.on("error", () => socket.destroy());
    socket.setTimeout(300_000, () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(
      t.public_port!,
      process.env.TCP_BIND_ADDRESS || "0.0.0.0",
      () => {
        listener.removeListener("error", reject);
        resolve();
      },
    );
  });
  listener.on("error", (error) =>
    console.error(`TCP listener ${t.public_port}:`, error.message),
  );
  tcpListeners.set(t.id, listener);
}
for (const t of db
  .prepare("SELECT * FROM tunnels WHERE kind='tcp' AND stopped_at IS NULL")
  .all() as Tunnel[])
  await listenTcp(t);
function stopTunnel(t: Tunnel) {
  db.prepare("UPDATE tunnels SET stopped_at=? WHERE id=?").run(now(), t.id);
  tcpListeners.get(t.id)?.close();
  tcpListeners.delete(t.id);
  for (const stream of tcpSockets.values())
    if (stream.tunnelId === t.id) stream.socket.destroy();
  for (const [key, value] of pending)
    if (value.tunnelId === t.id) {
      clearTimeout(value.timer);
      pending.delete(key);
      value.resolve({
        type: "http_response",
        status: 410,
        error: "Tunnel stopped.",
      });
    }
}
function allocateTunnelSlug(name: string, tunnelId: string): string {
  if (tunnelURLMode() === "uuid") return tunnelId;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = Array.from(
      { length: 8 },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
    const slug = tunnelURLMode() === "named" ? `${name}-${suffix}` : suffix;
    if (
      !db
        .prepare("SELECT id FROM tunnels WHERE public_slug=? OR id=?")
        .get(slug, slug)
    )
      return slug;
  }
  throw Error("Could not allocate a unique tunnel URL.");
}
async function createTunnel(user: Principal, payload: Record<string, unknown>) {
  const agentId = string(payload.agent_id, 64),
    kind = payload.kind;
  const host = string(payload.local_host || "127.0.0.1", 100);
  const localPort = Number(payload.local_port);
  const tunnelName =
    payload.name === undefined || payload.name === "" ? "tunnel" : payload.name;
  if (
    typeof tunnelName !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(tunnelName)
  )
    return fail(
      "Tunnel name must be 1–40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
    );
  if (
    !agentId ||
    !host ||
    !isLocalHost(host) ||
    !Number.isInteger(localPort) ||
    localPort < 1 ||
    localPort > 65535 ||
    (kind !== "http" && kind !== "tcp")
  )
    return fail(
      "Use a valid agent_id, kind (http or tcp), loopback local_host, and local_port (1–65535).",
    );
  if (user.agentId && user.agentId !== agentId)
    return fail("Agent token cannot manage another agent.", 403);
  const agent = db
    .prepare("SELECT id FROM agents WHERE id=? AND user_id=?")
    .get(agentId, user.id);
  if (!agent) return fail("Agent not found.", 404);
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count FROM tunnels WHERE user_id=? AND stopped_at IS NULL",
    )
    .get(user.id) as { count: number };
  if (count.count >= limitsFor(user.id).tunnels)
    return fail(
      "Account tunnel limit reached. Stop a tunnel or contact your administrator.",
      429,
    );
  let publicPort: number | null = null;
  if (kind === "tcp") {
    if (tcpStart < 1024 || tcpEnd > 65535 || tcpEnd < tcpStart)
      return fail("Server TCP port range is invalid.", 500);
    const used = new Set(
      (
        db
          .prepare(
            "SELECT public_port FROM tunnels WHERE kind='tcp' AND stopped_at IS NULL",
          )
          .all() as { public_port: number }[]
      ).map((x) => x.public_port),
    );
    for (let n = tcpStart; n <= tcpEnd; n++)
      if (!used.has(n)) {
        publicPort = n;
        break;
      }
    if (!publicPort) return fail("No public TCP ports available.", 503);
  }
  const tunnelId = id();
  const t: Tunnel = {
    id: tunnelId,
    public_slug:
      kind === "http" ? allocateTunnelSlug(tunnelName, tunnelId) : null,
    user_id: user.id,
    agent_id: agentId,
    kind,
    local_host: host,
    local_port: localPort,
    public_port: publicPort,
    created_at: now(),
    stopped_at: null,
  };
  db.prepare(
    "INSERT INTO tunnels (id,user_id,agent_id,kind,local_host,local_port,public_port,created_at,stopped_at,public_slug) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(
    t.id,
    t.user_id,
    t.agent_id,
    t.kind,
    t.local_host,
    t.local_port,
    t.public_port,
    t.created_at,
    t.stopped_at,
    t.public_slug,
  );
  try {
    await listenTcp(t);
  } catch {
    db.prepare("DELETE FROM tunnels WHERE id=?").run(t.id);
    return fail(
      "Public TCP port could not be opened. Check for a conflicting listener.",
      503,
    );
  }
  return json(showTunnel(t), 201);
}
async function upload(request: Request, user: User) {
  const contentType = request.headers.get("content-type") || "";
  let filename: string, bytes: Uint8Array, type: string;
  let permanent = false;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const keep = form.get("permanent");
    if (keep !== null && keep !== "true" && keep !== "false")
      return fail("permanent must be true or false.");
    permanent = keep === "true";
    const file = form.get("file");
    if (!(file instanceof File)) return fail("Attach a file field.");
    filename = file.name;
    type = file.type || "application/octet-stream";
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    const keep = request.headers.get("x-file-permanent");
    if (keep !== null && keep !== "true" && keep !== "false")
      return fail("x-file-permanent must be true or false.");
    permanent = keep === "true";
    filename = request.headers.get("x-file-name") || "file";
    type = contentType || "application/octet-stream";
    bytes = new Uint8Array(await request.arrayBuffer());
  }
  if (!filename || filename.length > 255 || bytes.length > maxFile)
    return fail(`File name is invalid or exceeds ${maxFile} bytes.`, 413);
  if (
    usageFor(user.id).storage_bytes + bytes.length >
    limitsFor(user.id).storage_bytes
  )
    return fail("Account file storage limit reached.", 413);
  const fileId = id(),
    created = now(),
    expires = permanent ? 0 : created + retention;
  db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?)").run(
    fileId,
    user.id,
    filename,
    bytes.length,
    type,
    created,
    expires,
  );
  try {
    await writeFile(join(filesDir, fileId), bytes);
  } catch (error) {
    db.prepare("DELETE FROM files WHERE id=?").run(fileId);
    throw error;
  }
  return json(
    {
      id: fileId,
      name: filename,
      size: bytes.length,
      url: fileUrl(fileId),
      expires_at: permanent ? null : expires,
      permanent,
    },
    201,
  );
}
function offlinePage() {
  return new Response(
    '<!doctype html><title>Host offline</title><meta name="viewport" content="width=device-width"><style>body{font:18px system-ui;background:#081827;color:#d9e9f5;max-width:620px;margin:12vh auto;padding:24px}h1{font-size:44px;letter-spacing:-.04em}p{line-height:1.5;color:#9fb9cc}</style><h1>This host is offline.</h1><p>The link is still reserved. Turn on the laptop and reconnect the agent, then refresh this page.</p>',
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "10",
      },
    },
  );
}
async function proxyHttp(request: Request, t: Tunnel) {
  const ws = connections.get(t.agent_id);
  if (!ws) return offlinePage();
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
    return fail("Use a TCP tunnel for WebSocket services.", 501);
  if (
    [...pending.values()].filter((p) => p.agentId === t.agent_id).length >= 64
  )
    return fail("Agent request limit reached.", 429);
  const bytes = await readBody(request.body, MAX_HTTP_BODY);
  const requestId = id();
  const result = new Promise<Wire>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        type: "http_response",
        status: 504,
        error: "Local service timed out.",
      });
    }, 30000);
    pending.set(requestId, {
      resolve,
      timer,
      agentId: t.agent_id,
      tunnelId: t.id,
    });
  });
  const headers = proxyHeaders(request.headers);
  headers["x-forwarded-host"] = new URL(tunnelUrl(t)).host;
  headers["x-forwarded-proto"] = new URL(publicOrigin).protocol.slice(0, -1);
  send(ws, {
    type: "http_request",
    id: requestId,
    tunnelId: t.id,
    method: request.method,
    path: new URL(request.url).pathname + new URL(request.url).search,
    headers,
    body: Buffer.from(bytes).toString("base64"),
  });
  const response = await result;
  if (response.error) return fail(response.error, response.status || 502);
  const responseHeaders = new Headers(response.headers);
  for (const key of [
    "connection",
    "transfer-encoding",
    "content-length",
    "content-encoding",
  ])
    responseHeaders.delete(key);
  for (const cookie of response.cookies || [])
    responseHeaders.append("set-cookie", cookie);
  const reply = response.body ? Buffer.from(response.body, "base64") : null;
  if (reply && reply.length > MAX_HTTP_BODY)
    return fail("Tunnel response exceeds 16 MB.", 502);
  return new Response(
    request.method === "HEAD" || [204, 205, 304].includes(response.status || 0)
      ? null
      : reply,
    { status: response.status || 502, headers: responseHeaders },
  );
}
async function mcp(request: Request, user: Principal) {
  const rpc = await body(request),
    method = rpc.method,
    params =
      rpc.params && typeof rpc.params === "object"
        ? (rpc.params as Record<string, unknown>)
        : {};
  if (rpc.jsonrpc !== "2.0" || typeof method !== "string")
    return json(
      {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      },
      400,
    );
  const result = (value: unknown) =>
    json({ jsonrpc: "2.0", id: rpc.id ?? null, result: value });
  if (method === "initialize")
    return result({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "relay-desk", version: "1.0.0" },
    });
  if (method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (method === "ping") return result({});
  if (method === "tools/list")
    return result({
      tools: [
        {
          name: "list_tunnels",
          description: "List your reserved tunnels and online status",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "create_tunnel",
          description: "Expose a local HTTP or TCP service through an agent",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              kind: { type: "string", enum: ["http", "tcp"] },
              local_port: { type: "integer" },
              local_host: { type: "string" },
              name: {
                type: "string",
                description: "URL name prefix for named mode (default tunnel)",
              },
            },
            required: ["agent_id", "kind", "local_port"],
          },
        },
        {
          name: "stop_tunnel",
          description: "Stop a tunnel and release its TCP port",
          inputSchema: {
            type: "object",
            properties: { tunnel_id: { type: "string" } },
            required: ["tunnel_id"],
          },
        },
        {
          name: "list_files",
          description: "List files and download links",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "list_sites",
          description: "List persistent hosted sites and access settings",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "deploy_site",
          description:
            "Deploy a static website ZIP with index.html at the root",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              content_base64: { type: "string" },
              visibility: { type: "string", enum: ["public", "login"] },
            },
            required: ["name", "content_base64"],
          },
        },
        {
          name: "update_site",
          description: "Replace the files for an existing hosted site without changing its URL",
          inputSchema: {
            type: "object",
            properties: {
              site_id: { type: "string" },
              name: { type: "string" },
              content_base64: { type: "string" },
              visibility: { type: "string", enum: ["public", "login"] },
            },
            required: ["site_id", "content_base64"],
          },
        },
        {
          name: "delete_site",
          description: "Permanently delete a hosted site and its files",
          inputSchema: {
            type: "object",
            properties: { site_id: { type: "string" } },
            required: ["site_id"],
          },
        },
        {
          name: "upload_file",
          description:
            "Upload base64 file content; keep at least 72 hours or until deleted",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              content_base64: { type: "string" },
              content_type: { type: "string" },
              permanent: {
                type: "boolean",
                description: "Keep until deleted (default false)",
              },
            },
            required: ["name", "content_base64"],
          },
        },
      ],
    });
  if (method !== "tools/call")
    return json(
      {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32601, message: "Method not found" },
      },
      404,
    );
  const name = params.name,
    args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
  let output: unknown;
  if (name === "list_tunnels")
    output = (
      db
        .prepare(
          "SELECT * FROM tunnels WHERE user_id=? AND stopped_at IS NULL ORDER BY created_at DESC",
        )
        .all(user.id) as Tunnel[]
    )
      .filter((t) => !user.agentId || t.agent_id === user.agentId)
      .map(showTunnel);
  else if (name === "list_sites")
    output = (
      db
        .prepare("SELECT * FROM sites WHERE user_id=? ORDER BY created_at DESC")
        .all(user.id) as Site[]
    ).map(showSite);
  else if (name === "delete_site") {
    const site = db
      .prepare("SELECT * FROM sites WHERE id=? AND user_id=?")
      .get(String(args.site_id || ""), user.id) as Site | undefined;
    if (!site) output = { error: "Site not found." };
    else {
      await deleteSite(site);
      output = { deleted: true };
    }
  } else if (name === "deploy_site") {
    const encoded =
      typeof args.content_base64 === "string" ? args.content_base64 : "";
    if (!encoded || encoded.length > Math.ceil((100 * 1024 ** 2 * 4) / 3))
      output = { error: "Provide base64 ZIP content below 100 MB." };
    else {
      const form = new FormData();
      form.set("name", String(args.name || ""));
      form.set("visibility", String(args.visibility || "login"));
      form.set("file", new Blob([Buffer.from(encoded, "base64")]), "site.zip");
      try {
        output = await createSite(
          new Request(publicOrigin + "/api/sites", {
            method: "POST",
            body: form,
          }),
          user,
        );
      } catch (error) {
        if (error instanceof SiteError) output = { error: error.message };
        else throw error;
      }
    }
  } else if (name === "update_site") {
    const siteId = String(args.site_id || "");
    const site = db
      .prepare("SELECT * FROM sites WHERE id=? AND user_id=?")
      .get(siteId, user.id) as Site | undefined;
    const encoded = typeof args.content_base64 === "string" ? args.content_base64 : "";
    if (!site) output = { error: "Site not found." };
    else if (!encoded || encoded.length > Math.ceil((100 * 1024 ** 2 * 4) / 3))
      output = { error: "Provide base64 ZIP content below 100 MB." };
    else {
      const form = new FormData();
      form.set("file", new Blob([Buffer.from(encoded, "base64")]), "site.zip");
      if (typeof args.name === "string") form.set("name", args.name);
      if (typeof args.visibility === "string") form.set("visibility", args.visibility);
      try {
        output = await updateSite(
          new Request(publicOrigin + `/api/sites/${siteId}`, { method: "PUT", body: form }),
          site,
          user,
        );
      } catch (error) {
        if (error instanceof SiteError) output = { error: error.message };
        else throw error;
      }
    }
  } else if (name === "create_tunnel")
    output = await (await createTunnel(user, args)).json();
  else if (name === "stop_tunnel") {
    const t = db
      .prepare(
        "SELECT * FROM tunnels WHERE id=? AND user_id=? AND stopped_at IS NULL",
      )
      .get(string(args.tunnel_id, 64), user.id) as Tunnel | null;
    if (t && (!user.agentId || t.agent_id === user.agentId)) stopTunnel(t);
    output = { stopped: !!t && (!user.agentId || t.agent_id === user.agentId) };
  } else if (name === "list_files")
    output = (
      db
        .prepare(
          "SELECT * FROM files WHERE user_id=? AND (expires_at=0 OR expires_at>?) ORDER BY created_at DESC",
        )
        .all(user.id, now()) as StoredFile[]
    ).map(showFile);
  else if (name === "upload_file") {
    const nameValue = string(args.name, 255),
      content = string(args.content_base64, maxFile * 2);
    if (args.permanent !== undefined && typeof args.permanent !== "boolean")
      output = { error: "permanent must be boolean" };
    else if (!nameValue || !content)
      output = { error: "name and content_base64 are required" };
    else {
      const bytes = Buffer.from(content, "base64");
      output = await (
        await upload(
          new Request(publicOrigin + "/api/files", {
            method: "POST",
            headers: {
              "x-file-name": nameValue,
              "x-file-permanent": String(args.permanent === true),
              "content-type":
                string(args.content_type, 100) || "application/octet-stream",
            },
            body: bytes,
          }),
          user,
        )
      ).json();
    }
  } else
    return json(
      {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32601, message: "Tool not found" },
      },
      404,
    );
  return result({
    content: [{ type: "text", text: JSON.stringify(output) }],
    isError:
      !!output &&
      typeof output === "object" &&
      ("error" in output || ("stopped" in output && output.stopped === false)),
  });
}
async function handleRequest(request: Request): Promise<Response> {
  let releaseBody: (() => void) | undefined;
  const buffer = async (limit: number) => {
    if (["GET", "HEAD"].includes(request.method)) return;
    releaseBody = reserveBody(limit);
    request = await bufferRequest(request, limit);
  };
  try {
    const url = new URL(request.url),
      path = url.pathname;
    const host = url.hostname.toLowerCase();
    const controlHost = new URL(publicOrigin).hostname.toLowerCase();
    const suffix = `.${tunnelsDomain()}`;
    const siteSuffix = `.${sitesDomain()}`;
    if (host !== controlHost && host.endsWith(siteSuffix)) {
      const siteId = host.slice(0, -siteSuffix.length);
      const site = /^s-[a-f0-9]{32}$/.test(siteId)
        ? (db.prepare("SELECT * FROM sites WHERE id=?").get(siteId.slice(2)) as
            Site | undefined)
        : undefined;
      if (
        site ||
        sitesDomain() !== tunnelsDomain() ||
        /^s-[a-f0-9]{32}$/.test(siteId)
      )
        return site
          ? await serveSite(request, site)
          : fail("Site not found.", 404);
    }
    if (host !== controlHost && host.endsWith(suffix)) {
      const tunnelId = host.slice(0, -suffix.length);
      const t = db
        .prepare(
          "SELECT * FROM tunnels WHERE (public_slug=? OR id=?) AND kind='http' AND stopped_at IS NULL",
        )
        .get(tunnelId, tunnelId) as Tunnel | null;
      if (!t) return fail("Tunnel not found.", 404);
      if (!connections.has(t.agent_id)) return offlinePage();
      await buffer(MAX_HTTP_BODY);
      return await proxyHttp(request, t);
    }
    if (path === "/health") return json({ ok: true });
    if (host !== controlHost && host !== filesHost())
      return fail("Unknown host.", 421);
    if (
      host !== controlHost &&
      !(path.startsWith("/f/") && ["GET", "HEAD"].includes(request.method))
    )
      return fail("File downloads only.", 404);
    const origin = request.headers.get("origin");
    if (
      origin &&
      origin !== publicOrigin &&
      !["GET", "HEAD"].includes(request.method)
    )
      return fail("Cross-origin request blocked.", 403);
    if (
      request.method === "GET" &&
      (path === "/" ||
        /^\/dashboard(?:\/(?:tunnels|files|agents|keys|account|users|resources|settings|sites))?$/.test(
          path,
        ))
    )
      return new Response(page(publicOrigin), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      });
    const assets: Record<string, string> = {
      "/cli.js": "../dist/relay.cjs",
      "/cli.cjs": "../dist/relay.cjs",
      "/panel.js": "../dist/panel.js",
      "/style.css": "../dist/panel.css",
      "/AGENTS.md": "../public/AGENTS.md",
      "/install.sh": "../public/install.sh",
    };
    if (assets[path] && request.method === "GET")
      return new Response(
        path === "/install.sh"
          ? (
              await readFile(new URL(assets[path], import.meta.url), "utf8")
            ).replaceAll("{{ORIGIN}}", publicOrigin)
          : await openAsBlob(new URL(assets[path], import.meta.url)),
        {
          headers: {
            "content-type": path.endsWith(".sh")
              ? "text/x-shellscript; charset=utf-8"
              : path.endsWith(".md")
                ? "text/markdown; charset=utf-8"
                : path.endsWith(".css")
                  ? "text/css; charset=utf-8"
                  : "application/javascript; charset=utf-8",
          },
        },
      );
    if (path.startsWith("/f/") && ["GET", "HEAD"].includes(request.method)) {
      const f = db
        .prepare(
          "SELECT * FROM files WHERE id=? AND (expires_at=0 OR expires_at>?)",
        )
        .get(path.slice(3), now()) as StoredFile | null;
      if (!f) return fail("File not found or expired.", 404);
      const file = await openAsBlob(join(filesDir, f.id)).catch(() => null);
      if (!file) return fail("File unavailable.", 404);
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "content-type": f.content_type,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (path === "/api/config" && request.method === "GET")
      return json({
        registration_enabled:
          (
            db
              .prepare(
                "SELECT value FROM settings WHERE key='registration_enabled'",
              )
              .get() as { value: string }
          ).value === "true",
        tcp_public_host: tcpPublicHost(),
        tunnels_base_domain: tunnelsDomain(),
        tunnel_url_mode: tunnelURLMode(),
        sites_base_domain: sitesDomain(),
        files_public_host: filesHost(),
        tcp_port_start: tcpStart,
        tcp_port_end: tcpEnd,
        max_file_bytes: maxFile,
        retention_hours: retention / 3600_000,
      });
    if (path.startsWith("/api/auth/")) {
      if (
        bearer(request) &&
        !["/api/auth/device/code", "/api/auth/device/token"].includes(path)
      )
        return fail("Use your browser session for account management.", 403);
      if (path.startsWith("/api/auth/admin/"))
        return fail("Use /api/admin/users to manage users.", 404);
      if (path.startsWith("/api/auth/one-time-token/"))
        return fail("Use the site's login link.", 404);
      if (path.startsWith("/api/auth/api-key/"))
        return fail("Use /api/keys or /api/agents to manage credentials.", 404);
      await buffer(64 * 1024);
      const response = await accountAuth.handler(request);
      if (path === "/api/auth/device/token" && response.ok) {
        const granted = (await response.clone().json()) as {
          access_token: string;
        };
        const headers = new Headers({
          authorization: `Bearer ${granted.access_token}`,
        });
        const session = await accountAuth.api.getSession({ headers });
        if (!session) return fail("Device authorization failed.", 500);
        db.prepare("INSERT OR IGNORE INTO settings VALUES(?,?)").run(
          `device_session:${session.session.id}`,
          "true",
        );
      }
      return response;
    }
    if (path.startsWith("/api/") || path === "/mcp") {
      if (path === "/api/agents/oauth" && request.method === "POST") {
        if (!bearer(request)) return fail("Device access token required.", 401);
        const session = await accountAuth.api.getSession({
          headers: new Headers({
            authorization: request.headers.get("authorization")!,
          }),
        });
        if (!session)
          return fail("Invalid or expired device access token.", 401);
        // Only sessions minted by the device flow may be exchanged. Browser
        // sessions must not become agent credentials by copying their cookies.
        const deviceSession = db
          .prepare("SELECT value FROM settings WHERE key=?")
          .get(`device_session:${session.session.id}`);
        if (!deviceSession)
          return fail("Complete device authorization first.", 403);
        await buffer(64 * 1024);
        const label = string((await body(request)).label, 100);
        if (!label) return fail("Agent name required.");
        const existing = db
          .prepare("SELECT id FROM agents WHERE key_id=? AND user_id=?")
          .get(`oauth:${session.session.id}`, session.user.id) as
          { id: string } | undefined;
        if (existing) return json({ id: existing.id });
        const agentId = id();
        db.prepare("INSERT INTO agents VALUES(?,?,?,?,?)").run(
          agentId,
          session.user.id,
          `oauth:${session.session.id}`,
          label,
          now(),
        );
        return json({ id: agentId }, 201);
      }
      if (path === "/api/agent/connect") {
        const agentId = url.searchParams.get("agent") || "";
        const agent = await agentAuth(request, agentId);
        if (!agent) return fail("Invalid agent credentials.", 401);
        return fail("WebSocket upgrade required.", 426);
      }
      const user = await auth(request);
      if (!user) return fail("Authentication required.", 401);
      await buffer(
        path === "/api/files" || path === "/api/sites"
          ? maxFile + 1024 * 1024
          : path === "/mcp"
            ? Math.ceil((maxFile * 4) / 3) + 64 * 1024
            : 64 * 1024,
      );
      if (path === "/mcp" && request.method === "POST")
        return await mcp(request, user);
      if (path === "/mcp")
        return new Response(null, {
          status: 405,
          headers: { allow: "POST" },
        });
      if (path === "/api/me" && request.method === "GET")
        return json({
          user: {
            ...user,
            avatar_url: `https://www.gravatar.com/avatar/${createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex")}?d=identicon&s=80`,
          },
          admin:
            !user.agentId &&
            (
              db
                .prepare("SELECT value FROM settings WHERE key='admin_user_id'")
                .get() as { value: string } | null
            )?.value === user.id,
        });
      if (path === "/api/usage" && request.method === "GET")
        return json({ usage: usageFor(user.id), limits: limitsFor(user.id) });
      if (path === "/api/sites" && request.method === "GET")
        return json(
          (
            db
              .prepare(
                "SELECT * FROM sites WHERE user_id=? ORDER BY created_at DESC",
              )
              .all(user.id) as Site[]
          ).map(showSite),
        );
      if (path === "/api/sites" && request.method === "POST")
        return json(await createSite(request, user), 201);
      const siteRoute = path.match(
        /^\/api\/sites\/([a-f0-9]{32})(?:\/(login))?$/,
      );
      if (siteRoute) {
        const site = db
          .prepare("SELECT * FROM sites WHERE id=?")
          .get(siteRoute[1]) as Site | undefined;
        if (!site) return fail("Site not found.", 404);
        if (request.method === "GET")
          return json({
            id: site.id,
            name: site.name,
            visibility: site.visibility,
            url: showSite(site).url,
          });
        if (siteRoute[2] === "login" && request.method === "POST")
          return json(
            await siteLogin(request, site, (await body(request)).return_path),
          );
        if (site.user_id !== user.id) return fail("Site not found.", 404);
        if (request.method === "PUT")
          return json(await updateSite(request, site, user));
        if (request.method === "DELETE") {
          await deleteSite(site);
          return json({ ok: true });
        }
        if (request.method === "PATCH") {
          const visibility = (await body(request)).visibility;
          if (visibility !== "public" && visibility !== "login")
            return fail("visibility must be public or login.");
          db.prepare("UPDATE sites SET visibility=? WHERE id=?").run(
            visibility,
            site.id,
          );
          return json(showSite({ ...site, visibility }));
        }
      }
      if (path.startsWith("/api/admin/")) {
        const administrator = db
          .prepare("SELECT value FROM settings WHERE key='admin_user_id'")
          .get() as { value: string } | undefined;
        if (user.agentId || administrator?.value !== user.id)
          return fail("Admin only.", 403);
        if (path === "/api/admin/users" && request.method === "GET") {
          const users = db
            .prepare(
              "SELECT id,email,created_at FROM users ORDER BY created_at DESC",
            )
            .all() as (User & { created_at: number })[];
          return json({
            users: users.map((account) => ({
              ...account,
              admin: account.id === administrator.value,
              limits: limitsFor(account.id),
              usage: usageFor(account.id),
            })),
            defaults: defaultLimits,
          });
        }
        if (path === "/api/admin/resources" && request.method === "GET") {
          return json({
            sites: (
              db
                .prepare(
                  "SELECT sites.*,users.email FROM sites JOIN users ON users.id=sites.user_id ORDER BY sites.created_at DESC",
                )
                .all() as Site[]
            ).map(showSite),
            tunnels: (
              db
                .prepare(
                  "SELECT tunnels.*,users.email FROM tunnels JOIN users ON users.id=tunnels.user_id WHERE stopped_at IS NULL ORDER BY created_at DESC",
                )
                .all() as (Tunnel & { email: string })[]
            ).map(showTunnel),
            files: (
              db
                .prepare(
                  "SELECT files.*,users.email FROM files JOIN users ON users.id=files.user_id ORDER BY created_at DESC",
                )
                .all() as (StoredFile & { email: string })[]
            ).map(showFile),
            agents: db
              .prepare(
                "SELECT agents.id,agents.label,agents.user_id,users.email FROM agents JOIN users ON users.id=agents.user_id ORDER BY agents.created_at DESC",
              )
              .all(),
            keys: db
              .prepare(
                "SELECT account_keys.id,account_keys.label,account_keys.user_id,users.email FROM account_keys JOIN users ON users.id=account_keys.user_id ORDER BY account_keys.created_at DESC",
              )
              .all(),
          });
        }
        const resource = path.match(
          /^\/api\/admin\/(tunnels|files|agents|keys|sites)\/([^/]+)$/,
        );
        if (resource && request.method === "DELETE") {
          const [, kind, resourceId] = resource;
          if (kind === "sites") {
            const site = db
              .prepare("SELECT * FROM sites WHERE id=?")
              .get(resourceId) as Site | undefined;
            if (!site) return fail("Site not found.", 404);
            await deleteSite(site);
          } else if (kind === "tunnels") {
            const tunnel = db
              .prepare(
                "SELECT * FROM tunnels WHERE id=? AND stopped_at IS NULL",
              )
              .get(resourceId) as Tunnel | undefined;
            if (!tunnel) return fail("Tunnel not found.", 404);
            stopTunnel(tunnel);
          } else if (kind === "files") {
            if (!db.prepare("SELECT id FROM files WHERE id=?").get(resourceId))
              return fail("File not found.", 404);
            removeFile(resourceId);
          } else if (kind === "keys") {
            const key = db
              .prepare("SELECT user_id FROM account_keys WHERE id=?")
              .get(resourceId) as { user_id: string } | undefined;
            if (!key) return fail("Key not found.", 404);
            await revokeKey(key.user_id, resourceId);
            db.prepare("DELETE FROM account_keys WHERE id=?").run(resourceId);
          } else {
            const agent = db
              .prepare("SELECT * FROM agents WHERE id=?")
              .get(resourceId) as Agent | undefined;
            if (!agent) return fail("Agent not found.", 404);
            await removeAgent(agent);
          }
          return json({ ok: true });
        }
        if (path === "/api/admin/users" && request.method === "POST") {
          const data = await body(request);
          const email = string(data.email, 254),
            name = string(data.name, 100);
          const password =
            typeof data.password === "string" ? data.password : "";
          const limits = parseLimits(data.limits ?? defaultLimits);
          if (
            !email ||
            !name ||
            password.length < 12 ||
            password.length > 200 ||
            !limits
          )
            return fail(
              "Provide a name, email, password (12–200 characters), and nonnegative integer limits.",
            );
          try {
            const created = await accountAuth.api.createUser({
              body: { email, name, password, role: "user" },
            });
            saveLimits(created.user.id, limits);
            return json(
              {
                user: { id: created.user.id, email: created.user.email },
                limits,
              },
              201,
            );
          } catch (error) {
            if (
              error instanceof Error &&
              "statusCode" in error &&
              typeof error.statusCode === "number" &&
              error.statusCode < 500
            )
              return fail(error.message, error.statusCode);
            throw error;
          }
        }
        const match = path.match(/^\/api\/admin\/users\/([^/]+)\/limits$/);
        if (match && request.method === "PATCH") {
          if (!db.prepare("SELECT id FROM users WHERE id=?").get(match[1]))
            return fail("User not found.", 404);
          const limits = parseLimits(await body(request));
          if (!limits)
            return fail("All limits must be nonnegative safe integers.");
          saveLimits(match[1], limits);
          return json({ limits, usage: usageFor(match[1]) });
        }
      }
      if (
        path === "/api/admin/settings" &&
        ["GET", "PATCH"].includes(request.method)
      ) {
        if (user.agentId)
          return fail("Agent token cannot change settings.", 403);
        const admin = db
          .prepare("SELECT value FROM settings WHERE key='admin_user_id'")
          .get() as { value: string } | null;
        if (admin?.value !== user.id) return fail("Admin only.", 403);
        const current = () => ({
          registration_enabled:
            (
              db
                .prepare(
                  "SELECT value FROM settings WHERE key='registration_enabled'",
                )
                .get() as { value: string }
            ).value === "true",
          tcp_public_host: tcpPublicHost(),
          tunnels_base_domain: tunnelsDomain(),
          tunnel_url_mode: tunnelURLMode(),
          sites_base_domain: sitesDomain(),
          files_public_host: filesHost(),
          tcp_port_start: tcpStart,
          tcp_port_end: tcpEnd,
        });
        if (request.method === "GET") return json(current());
        const data = await body(request);
        if (
          data.registration_enabled !== undefined &&
          typeof data.registration_enabled !== "boolean"
        )
          return fail("registration_enabled must be boolean");
        for (const key of [
          "tcp_public_host",
          "tunnels_base_domain",
          "sites_base_domain",
          "files_public_host",
        ]) {
          if (data[key] !== undefined && !validHostname(data[key]))
            return fail(
              `${key} must be a hostname without a scheme, wildcard or port.`,
            );
        }
        if (
          data.tunnel_url_mode !== undefined &&
          !["named", "random", "uuid"].includes(String(data.tunnel_url_mode))
        )
          return fail("tunnel_url_mode must be named, random or uuid.");
        db.transaction(() => {
          if (data.tunnel_url_mode !== undefined)
            db.prepare(
              "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ).run("tunnel_url_mode", data.tunnel_url_mode);
          if (data.registration_enabled !== undefined)
            db.prepare(
              "UPDATE settings SET value=? WHERE key='registration_enabled'",
            ).run(String(data.registration_enabled));
          for (const key of [
            "tcp_public_host",
            "tunnels_base_domain",
            "sites_base_domain",
            "files_public_host",
          ]) {
            if (data[key] !== undefined)
              db.prepare(
                "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              ).run(key, String(data[key]).toLowerCase());
          }
        })();
        return json(current());
      }
      if (
        (path === "/api/keys" ||
          path.startsWith("/api/keys/") ||
          path === "/api/agents" ||
          path.startsWith("/api/agents/")) &&
        user.agentId
      )
        return fail("Agent token cannot manage credentials.", 403);
      if (path === "/api/keys" && request.method === "GET")
        return json(
          db
            .prepare(
              "SELECT id,label,created_at FROM account_keys WHERE user_id=? ORDER BY created_at DESC",
            )
            .all(user.id),
        );
      if (path === "/api/keys" && request.method === "POST") {
        const label = string((await body(request)).label, 100);
        if (!label) return fail("Key name required");
        const key = await issueKey(user.id, label);
        db.prepare("INSERT INTO account_keys VALUES (?,?,?,?)").run(
          key.id,
          user.id,
          label,
          now(),
        );
        return json({ id: key.id, token: key.key }, 201);
      }
      if (path.startsWith("/api/keys/") && request.method === "DELETE") {
        const keyId = path.slice(10);
        if (
          !db
            .prepare("SELECT id FROM account_keys WHERE id=? AND user_id=?")
            .get(keyId, user.id)
        )
          return fail("Key not found.", 404);
        await revokeKey(user.id, keyId);
        db.prepare("DELETE FROM account_keys WHERE id=? AND user_id=?").run(
          keyId,
          user.id,
        );
        return json({ ok: true });
      }
      if (path === "/api/agents" && request.method === "GET")
        return json(
          (
            db
              .prepare(
                "SELECT id,label,created_at FROM agents WHERE user_id=? ORDER BY created_at DESC",
              )
              .all(user.id) as {
              id: string;
              label: string;
              created_at: number;
            }[]
          ).map((agent) => ({ ...agent, online: connections.has(agent.id) })),
        );
      if (path === "/api/agents" && request.method === "POST") {
        const label = string((await body(request)).label, 100);
        if (!label) return fail("Agent name required");
        const key = await issueKey(user.id, label),
          agentId = id();
        db.prepare("INSERT INTO agents VALUES (?,?,?,?,?)").run(
          agentId,
          user.id,
          key.id,
          label,
          now(),
        );
        return json({ id: agentId, token: key.key }, 201);
      }
      const rotate = path.match(/^\/api\/agents\/([a-f0-9]{32})\/rotate$/);
      const deleteAgent = path.match(/^\/api\/agents\/([a-f0-9]{32})$/);
      if (deleteAgent && request.method === "DELETE") {
        const agent = db
          .prepare("SELECT * FROM agents WHERE id=? AND user_id=?")
          .get(deleteAgent[1], user.id) as Agent | undefined;
        if (!agent) return fail("Agent not found.", 404);
        await removeAgent(agent);
        return json({ ok: true });
      }
      if (rotate && request.method === "POST") {
        const agentId = rotate[1];
        if (
          !db
            .prepare("SELECT id FROM agents WHERE id=? AND user_id=?")
            .get(agentId, user.id)
        )
          return fail("Agent not found.", 404);
        const previous = db
          .prepare("SELECT * FROM agents WHERE id=? AND user_id=?")
          .get(agentId, user.id) as Agent;
        const key = await issueKey(user.id, previous.label);
        await revokeAgentCredential(previous);
        db.prepare("UPDATE agents SET key_id=? WHERE id=?").run(
          key.id,
          agentId,
        );
        const ws = connections.get(agentId);
        closeAgent(agentId);
        ws?.close(4001, "Credentials rotated");
        return json({ id: agentId, token: key.key });
      }
      if (path === "/api/tunnels" && request.method === "GET")
        return json(
          (
            db
              .prepare(
                "SELECT * FROM tunnels WHERE user_id=? AND stopped_at IS NULL ORDER BY created_at DESC",
              )
              .all(user.id) as Tunnel[]
          )
            .filter((t) => !user.agentId || t.agent_id === user.agentId)
            .map(showTunnel),
        );
      if (path === "/api/tunnels" && request.method === "POST")
        return await createTunnel(user, await body(request));
      if (path.startsWith("/api/tunnels/") && request.method === "DELETE") {
        const t = db
          .prepare(
            "SELECT * FROM tunnels WHERE id=? AND user_id=? AND stopped_at IS NULL",
          )
          .get(path.slice(13), user.id) as Tunnel | null;
        if (!t || (user.agentId && t.agent_id !== user.agentId))
          return fail("Tunnel not found.", 404);
        stopTunnel(t);
        return json({ ok: true });
      }
      if (path === "/api/files" && request.method === "GET")
        return json(
          (
            db
              .prepare(
                "SELECT * FROM files WHERE user_id=? AND (expires_at=0 OR expires_at>?) ORDER BY created_at DESC",
              )
              .all(user.id, now()) as StoredFile[]
          ).map(showFile),
        );
      if (path === "/api/files" && request.method === "POST")
        return await upload(request, user);
      const deleteFile = path.match(/^\/api\/files\/([a-f0-9]{32})$/);
      if (deleteFile && request.method === "DELETE") {
        if (user.agentId)
          return fail("Agent token cannot delete shared files.", 403);
        if (
          !db
            .prepare("SELECT id FROM files WHERE id=? AND user_id=?")
            .get(deleteFile[1], user.id)
        )
          return fail("File not found.", 404);
        removeFile(deleteFile[1]);
        return json({ ok: true });
      }
      return fail("Endpoint not found.", 404);
    }
    return fail("Not found.", 404);
  } catch (error) {
    if (error instanceof BodyReadTimeout)
      return fail("Request body timed out.", 408);
    if (error instanceof BodyBusy)
      return fail("Server request capacity reached. Retry shortly.", 429);
    if (error instanceof SiteError) return fail(error.message, error.status);
    if (error instanceof BodyTooLarge) return fail(error.message, 413);
    console.error(error);
    return fail("Internal server error.", 500);
  } finally {
    releaseBody?.();
  }
}
const socketHandlers = {
  open(ws: WebSocket) {
    const old = connections.get(ws.data.agentId);
    if (old && old !== ws) {
      closeAgent(ws.data.agentId);
      old.close(4000, "Replaced by new connection");
    }
    connections.set(ws.data.agentId, ws);
  },
  message(ws: WebSocket, message: string) {
    if (connections.get(ws.data.agentId) !== ws) return;
    const data = parseFrame(String(message));
    if (!data) {
      ws.close(1008, "Invalid frame");
      return;
    }
    if (data.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }
    if (data.type === "http_response" && data.id) {
      const item = pending.get(data.id);
      if (item && item.agentId === ws.data.agentId) {
        clearTimeout(item.timer);
        pending.delete(data.id);
        item.resolve(data);
      }
      return;
    }
    if (!data.id) return;
    const stream = tcpSockets.get(data.id);
    if (stream?.agentId !== ws.data.agentId) return;
    if (data.type === "tcp_ready") stream.socket.resume();
    if (
      data.type === "tcp_ack" &&
      stream.acknowledgements > 0 &&
      --stream.acknowledgements === 0
    )
      stream.socket.resume();
    if (data.type === "tcp_data" && data.body) {
      if (data.body.length > 128 * 1024) {
        stream.socket.destroy();
        return;
      }
      stream.socket.write(Buffer.from(data.body, "base64"), () =>
        send(ws, { type: "tcp_ack", id: data.id }),
      );
    }
    if (data.type === "tcp_end") stream.socket.end();
    if (data.type === "tcp_close") stream.socket.destroy();
  },
  close(ws: WebSocket) {
    if (connections.get(ws.data.agentId) === ws) closeAgent(ws.data.agentId);
  },
};

const server = serve({
  port,
  hostname: "0.0.0.0",
  fetch: async (request, env) => {
    try {
      request.headers.set(
        "x-relay-client-ip",
        env.incoming.socket.remoteAddress || "127.0.0.1",
      );
      return await handleRequest(request);
    } catch (error) {
      if (error instanceof BodyTooLarge) return fail(error.message, 413);
      console.error(error);
      return fail("Internal server error.", 500);
    }
  },
});
const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_FRAME_BYTES,
  perMessageDeflate: false,
});
server.on("upgrade", (incoming, socket, head) => {
  const reject = (status: number) => {
    socket.end("HTTP/1.1 " + status + " Rejected\r\nConnection: close\r\n\r\n");
  };
  (async () => {
    const url = new URL(incoming.url || "/", "http://" + incoming.headers.host);
    if (
      url.hostname !== new URL(publicOrigin).hostname ||
      url.pathname !== "/api/agent/connect"
    ) {
      reject(404);
      return;
    }
    if (incoming.headers.origin && incoming.headers.origin !== publicOrigin) {
      reject(403);
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    const agent = await agentAuth(
      new Request(url, { headers }),
      url.searchParams.get("agent") || "",
    );
    if (!agent) {
      reject(401);
      return;
    }
    sockets.handleUpgrade(incoming, socket, head, (raw) => {
      const ws = Object.assign(raw, {
        data: { agentId: agent.id, userId: agent.user_id },
      });
      let lastSeen = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastSeen > 90_000) ws.terminate();
        if (agent.key_id.startsWith("oauth:")) {
          const session = db
            .prepare("SELECT expiresAt FROM session WHERE id=?")
            .get(agent.key_id.slice(6)) as
            { expiresAt: string | number } | undefined;
          if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
            closeAgent(agent.id);
            ws.close(4001, "Authorization expired or revoked; run relay login");
          }
        }
      }, 30_000);
      heartbeat.unref();
      ws.on("error", () => ws.terminate());
      ws.on("message", (message) => {
        lastSeen = Date.now();
        socketHandlers.message(ws, message.toString());
      });
      ws.on("close", () => {
        clearInterval(heartbeat);
        socketHandlers.close(ws);
      });
      socketHandlers.open(ws);
    });
  })().catch((error) => {
    console.error(error);
    reject(500);
  });
});

setInterval(() => {
  const expired = db
    .prepare("SELECT id FROM files WHERE expires_at<>0 AND expires_at<=?")
    .all(now()) as { id: string }[];
  for (const file of expired) {
    try {
      unlinkSync(join(filesDir, file.id));
    } catch {}
    db.prepare("DELETE FROM files WHERE id=?").run(file.id);
  }
}, 3600_000).unref();
server.on("listening", () =>
  console.log(`Relay desk listening on port ${port}`),
);
