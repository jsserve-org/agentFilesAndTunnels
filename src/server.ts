import { serve } from "@hono/node-server";
import { WebSocket as AgentSocket, WebSocketServer } from "ws";
import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";
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
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server as TcpServer, type Socket } from "node:net";
import {
  MAX_HTTP_BODY,
  MAX_FRAME_BYTES,
  parseFrame,
  readBody,
  BodyTooLarge,
  proxyHeaders,
  type Frame as Wire,
} from "./protocol.ts";

const port = Number(process.env.PORT || 3000);
const publicOrigin = (
  process.env.PUBLIC_ORIGIN || `http://localhost:${port}`
).replace(/\/$/, "");
const baseDomain = process.env.BASE_DOMAIN || new URL(publicOrigin).hostname;
const tcpHost = process.env.TCP_PUBLIC_HOST || baseDomain;
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
  return `${new URL(publicOrigin).protocol}//${t.id}.${baseDomain}`;
}
function showTunnel(t: Tunnel) {
  return {
    ...t,
    online: connections.has(t.agent_id),
    url: t.kind === "http" ? tunnelUrl(t) : null,
    address: t.kind === "tcp" ? `${tcpHost}:${t.public_port}` : null,
  };
}
function fileUrl(fileId: string) {
  return `${publicOrigin}/f/${fileId}`;
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
async function createTunnel(user: Principal, payload: Record<string, unknown>) {
  const agentId = string(payload.agent_id, 64),
    kind = payload.kind;
  const host = string(payload.local_host || "127.0.0.1", 100);
  const localPort = Number(payload.local_port);
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
  if (count.count >= 100)
    return fail("Account tunnel limit reached (100).", 429);
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
  const t: Tunnel = {
    id: id(),
    user_id: user.id,
    agent_id: agentId,
    kind,
    local_host: host,
    local_port: localPort,
    public_port: publicPort,
    created_at: now(),
    stopped_at: null,
  };
  db.prepare("INSERT INTO tunnels VALUES (?,?,?,?,?,?,?,?,?)").run(
    t.id,
    t.user_id,
    t.agent_id,
    t.kind,
    t.local_host,
    t.local_port,
    t.public_port,
    t.created_at,
    t.stopped_at,
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
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("Attach a file field.");
    filename = file.name;
    type = file.type || "application/octet-stream";
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    filename = request.headers.get("x-file-name") || "file";
    type = contentType || "application/octet-stream";
    bytes = new Uint8Array(await request.arrayBuffer());
  }
  if (!filename || filename.length > 255 || bytes.length > maxFile)
    return fail(`File name is invalid or exceeds ${maxFile} bytes.`, 413);
  const usage = db
    .prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM files WHERE user_id=?")
    .get(user.id) as { bytes: number };
  if (usage.bytes + bytes.length > maxUserStorage)
    return fail("Account file storage limit reached.", 413);
  const fileId = id(),
    created = now(),
    expires = created + retention;
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
      expires_at: expires,
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
          name: "upload_file",
          description: "Upload base64 file content for at least 72 hours",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              content_base64: { type: "string" },
              content_type: { type: "string" },
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
  else if (name === "create_tunnel")
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
          "SELECT * FROM files WHERE user_id=? AND expires_at>? ORDER BY created_at DESC",
        )
        .all(user.id, now()) as StoredFile[]
    ).map((f) => ({ ...f, url: fileUrl(f.id) }));
  else if (name === "upload_file") {
    const nameValue = string(args.name, 255),
      content = string(args.content_base64, maxFile * 2);
    if (!nameValue || !content)
      output = { error: "name and content_base64 are required" };
    else {
      const bytes = Buffer.from(content, "base64");
      output = await (
        await upload(
          new Request(publicOrigin + "/api/files", {
            method: "POST",
            headers: {
              "x-file-name": nameValue,
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
  try {
    const url = new URL(request.url),
      path = url.pathname;
    const host = url.hostname.toLowerCase();
    const controlHost = new URL(publicOrigin).hostname.toLowerCase();
    const suffix = `.${baseDomain.toLowerCase()}`;
    if (host !== controlHost && host.endsWith(suffix)) {
      const tunnelId = host.slice(0, -suffix.length);
      const t = db
        .prepare(
          "SELECT * FROM tunnels WHERE id=? AND kind='http' AND stopped_at IS NULL",
        )
        .get(tunnelId) as Tunnel | null;
      return t ? await proxyHttp(request, t) : fail("Tunnel not found.", 404);
    }
    if (path === "/health") return json({ ok: true });
    if (host !== controlHost) return fail("Unknown host.", 421);
    const origin = request.headers.get("origin");
    if (
      origin &&
      origin !== publicOrigin &&
      !["GET", "HEAD"].includes(request.method)
    )
      return fail("Cross-origin request blocked.", 403);
    if (path === "/")
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
      "/style.css": "../public/style.css",
    };
    if (assets[path] && request.method === "GET")
      return new Response(
        await openAsBlob(new URL(assets[path], import.meta.url)),
        {
          headers: {
            "content-type": path.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "application/javascript; charset=utf-8",
          },
        },
      );
    if (path.startsWith("/f/") && request.method === "GET") {
      const f = db
        .prepare("SELECT * FROM files WHERE id=? AND expires_at>?")
        .get(path.slice(3), now()) as StoredFile | null;
      if (!f) return fail("File not found or expired.", 404);
      const file = await openAsBlob(join(filesDir, f.id)).catch(() => null);
      if (!file) return fail("File unavailable.", 404);
      return new Response(file, {
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
        max_file_bytes: maxFile,
        retention_hours: retention / 3600_000,
      });
    if (path.startsWith("/api/auth/")) {
      if (path.startsWith("/api/auth/api-key/"))
        return fail("Use /api/keys or /api/agents to manage credentials.", 404);
      return accountAuth.handler(request);
    }
    if (path.startsWith("/api/") || path === "/mcp") {
      if (path === "/api/agent/connect") {
        const agentId = url.searchParams.get("agent") || "";
        const agent = await agentAuth(request, agentId);
        if (!agent) return fail("Invalid agent credentials.", 401);
        return fail("WebSocket upgrade required.", 426);
      }
      const user = await auth(request);
      if (!user) return fail("Authentication required.", 401);
      if (path === "/mcp" && request.method === "POST")
        return mcp(request, user);
      if (path === "/mcp")
        return new Response(null, {
          status: 405,
          headers: { allow: "POST" },
        });
      if (path === "/api/me" && request.method === "GET")
        return json({
          user,
          admin:
            (
              db
                .prepare("SELECT value FROM settings WHERE key='admin_user_id'")
                .get() as { value: string } | null
            )?.value === user.id,
        });
      if (path === "/api/admin/settings" && request.method === "PATCH") {
        if (user.agentId)
          return fail("Agent token cannot change settings.", 403);
        const admin = db
          .prepare("SELECT value FROM settings WHERE key='admin_user_id'")
          .get() as { value: string } | null;
        if (admin?.value !== user.id) return fail("Admin only.", 403);
        const data = await body(request);
        if (typeof data.registration_enabled !== "boolean")
          return fail("registration_enabled must be boolean");
        db.prepare(
          "UPDATE settings SET value=? WHERE key='registration_enabled'",
        ).run(String(data.registration_enabled));
        return json({ registration_enabled: data.registration_enabled });
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
          db
            .prepare(
              "SELECT id,label,created_at FROM agents WHERE user_id=? ORDER BY created_at DESC",
            )
            .all(user.id),
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
        await revokeKey(user.id, previous.key_id);
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
        return createTunnel(user, await body(request));
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
                "SELECT * FROM files WHERE user_id=? AND expires_at>? ORDER BY created_at DESC",
              )
              .all(user.id, now()) as StoredFile[]
          ).map((f) => ({ ...f, url: fileUrl(f.id) })),
        );
      if (path === "/api/files" && request.method === "POST")
        return upload(request, user);
      return fail("Endpoint not found.", 404);
    }
    return fail("Not found.", 404);
  } catch (error) {
    if (error instanceof BodyTooLarge) return fail(error.message, 413);
    console.error(error);
    return fail("Internal server error.", 500);
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
      if (!["GET", "HEAD"].includes(request.method)) {
        const bytes = await readBody(request.body, maxFile + 1024 * 1024);
        request = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: new Uint8Array(bytes),
        });
      }
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
    .prepare("SELECT id FROM files WHERE expires_at<=?")
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
