import { connect as tcpConnect, type Socket } from "node:net";
import {
  MAX_HTTP_BODY,
  parseFrame,
  proxyHeaders,
  readBody,
  type Frame,
} from "./protocol.ts";

type Tunnel = {
  id: string;
  kind: "http" | "tcp";
  local_host: string;
  local_port: number;
  url: string | null;
  address: string | null;
};
const args = process.argv.slice(2);
const command = args[0];
function opt(name: string, fallback?: string) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
const server = (opt("server", process.env.RELAY_SERVER) || "").replace(
  /\/$/,
  "",
);
const agent = opt("agent", process.env.RELAY_AGENT) || "";
const token = opt("token", process.env.RELAY_TOKEN) || "";
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${server}/api${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof value === "object" && value !== null && "error" in value
        ? String(value.error)
        : `HTTP ${response.status}`,
      response.status,
    );
  return value;
}
async function tunnels() {
  return (await api("/tunnels")) as Tunnel[];
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(`Relay desk CLI

Commands:
  connect                          Keep this laptop connected; reconnect automatically
  create http|tcp --local-port PORT Create a tunnel for the selected agent
  list                             List active tunnel reservations
  stop TUNNEL_ID                   Close a tunnel and all its connections
  upload FILE_PATH                 Upload a file and print its download link

Credentials: --server URL --agent ID --token TOKEN
Environment: RELAY_SERVER, RELAY_AGENT, RELAY_TOKEN
The agent ID is needed for connect and create. An account API key can list,
stop and upload; an agent token can manage only its own tunnels.`);
    return;
  }
  if (!server || !token)
    throw new Error(
      "Set RELAY_SERVER and RELAY_TOKEN, or pass --server and --token.",
    );
  const origin = new URL(server);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password
  )
    throw new Error(
      "Server must be an HTTP(S) origin, such as https://relay.example.com.",
    );
  if (["connect", "create"].includes(command) && !agent)
    throw new Error("Set RELAY_AGENT or pass --agent ID.");
  if (command === "list") {
    console.log(JSON.stringify(await tunnels(), null, 2));
    return;
  }
  if (command === "create") {
    const kind = args[1],
      localPort = Number(opt("local-port")),
      localHost = opt("local-host", "127.0.0.1");
    if (
      (kind !== "http" && kind !== "tcp") ||
      !Number.isInteger(localPort) ||
      localPort < 1 ||
      localPort > 65535
    )
      throw new Error("Usage: create http|tcp --local-port PORT (1–65535)");
    const result = await api("/tunnels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: agent,
        kind,
        local_port: localPort,
        local_host: localHost,
      }),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "stop") {
    const tunnelId = args[1];
    if (!tunnelId || !/^[a-f0-9]{32}$/.test(tunnelId))
      throw new Error("Usage: stop TUNNEL_ID");
    await api(`/tunnels/${tunnelId}`, { method: "DELETE" });
    console.log("Tunnel stopped.");
    return;
  }
  if (command === "upload") {
    const path = args[1];
    if (!path) throw new Error("Usage: upload FILE_PATH");
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error("File does not exist.");
    const form = new FormData();
    form.set("file", file, path.split(/[\\/]/).pop() || "file");
    console.log(
      JSON.stringify(
        await api("/files", { method: "POST", body: form }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "connect") {
    await connectLoop();
    return;
  }
  throw new Error("Unknown command. Run with --help.");
}

async function connectLoop() {
  let delay = 1000;
  let replaced = false;
  while (!replaced) {
    try {
      // Fetch before opening the socket so handlers are installed before any frames arrive.
      const cache = new Map((await tunnels()).map((t) => [t.id, t]));
      const streams = new Map<string, Socket>();
      const acknowledgements = new Map<string, number>();
      const wsUrl = new URL(`${server}/api/agent/connect`);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.searchParams.set("agent", agent);
      const ws = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${token}` },
      });
      const getTunnel = async (id: string) => {
        if (!cache.has(id)) {
          cache.clear();
          for (const t of await tunnels()) cache.set(t.id, t);
        }
        return cache.get(id);
      };
      const send = (frame: Frame) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 32 * 1024 * 1024) {
          ws.close(1013, "Connection overloaded");
          return;
        }
        ws.send(JSON.stringify(frame));
      };
      let lastPong = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 60_000) {
          ws.terminate();
          return;
        }
        send({ type: "ping" });
      }, 20_000);
      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          delay = 1000;
          lastPong = Date.now();
          console.log("Agent connected. Tunnel links are active.");
        };
        ws.onerror = () => {};
        ws.onclose = (event) => {
          clearInterval(heartbeat);
          for (const socket of streams.values()) socket.destroy();
          streams.clear();
          if (event.code === 4000 || event.code === 4001) {
            replaced = true;
            console.log(event.reason);
          }
          resolve();
        };
        ws.onmessage = (event) => {
          const frame = parseFrame(String(event.data));
          if (!frame) {
            ws.close(1008, "Invalid frame");
            return;
          }
          if (frame.type === "pong") {
            lastPong = Date.now();
            return;
          }
          handleFrame(frame).catch((error) => {
            send({
              type:
                frame.type === "http_request" ? "http_response" : "tcp_close",
              id: frame.id,
              status: 502,
              error:
                error instanceof Error
                  ? error.message
                  : "Local service failed.",
            });
          });
        };
      });
      async function handleFrame(frame: Frame) {
        if (frame.type === "http_request" && frame.id && frame.tunnelId) {
          const t = await getTunnel(frame.tunnelId);
          if (!t || t.kind !== "http")
            throw new Error("Tunnel no longer exists.");
          const headers = new Headers(frame.headers);
          for (const key of [
            "host",
            "connection",
            "upgrade",
            "content-length",
            "accept-encoding",
          ])
            headers.delete(key);
          headers.set("accept-encoding", "identity");
          const bytes = frame.body
            ? Buffer.from(frame.body, "base64")
            : undefined;
          const host = t.local_host === "::1" ? "[::1]" : t.local_host;
          if (!frame.path?.startsWith("/"))
            throw new Error("Invalid request path.");
          const response = await fetch(
            `http://${host}:${t.local_port}${frame.path}`,
            {
              method: frame.method || "GET",
              headers,
              body: bytes?.length ? bytes : undefined,
              redirect: "manual",
              signal: AbortSignal.timeout(25_000),
            },
          );
          const reply = await readBody(response.body, MAX_HTTP_BODY);
          send({
            type: "http_response",
            id: frame.id,
            status: response.status,
            headers: proxyHeaders(response.headers, true),
            cookies: response.headers.getSetCookie(),
            body: reply.toString("base64"),
          });
        }
        if (frame.type === "tcp_open" && frame.id && frame.tunnelId) {
          const t = await getTunnel(frame.tunnelId);
          if (!t || t.kind !== "tcp")
            throw new Error("Tunnel no longer exists.");
          const streamId = frame.id;
          if (ws.readyState !== WebSocket.OPEN) return;
          const socket = tcpConnect({
            port: t.local_port,
            host: t.local_host,
            allowHalfOpen: true,
          });
          streams.set(streamId, socket);
          socket.on("connect", () => send({ type: "tcp_ready", id: streamId }));
          socket.on("data", (data) => {
            const chunk = Buffer.from(data);
            socket.pause();
            for (let offset = 0; offset < chunk.length; offset += 48 * 1024) {
              acknowledgements.set(
                streamId,
                (acknowledgements.get(streamId) || 0) + 1,
              );
              send({
                type: "tcp_data",
                id: streamId,
                body: chunk
                  .subarray(offset, offset + 48 * 1024)
                  .toString("base64"),
              });
            }
          });
          socket.on("end", () => send({ type: "tcp_end", id: streamId }));
          socket.on("close", () => {
            streams.delete(streamId);
            acknowledgements.delete(streamId);
            send({ type: "tcp_close", id: streamId });
          });
          socket.on("error", () => socket.destroy());
          socket.setTimeout(300_000, () => socket.destroy());
        }
        if (!frame.id) return;
        const socket = streams.get(frame.id);
        if (!socket) return;
        if (frame.type === "tcp_data" && frame.body) {
          if (frame.body.length > 128 * 1024) {
            socket.destroy();
            return;
          }
          socket.write(Buffer.from(frame.body, "base64"), () =>
            send({ type: "tcp_ack", id: frame.id }),
          );
        }
        if (frame.type === "tcp_ack") {
          const remaining = (acknowledgements.get(frame.id) || 0) - 1;
          acknowledgements.set(frame.id, remaining);
          if (remaining === 0) socket.resume();
        }
        if (frame.type === "tcp_end") socket.end();
        if (frame.type === "tcp_close") socket.destroy();
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status))
        throw error;
      console.error(error instanceof Error ? error.message : error);
    }
    if (!replaced) {
      console.log(`Connection lost. Reconnecting in ${delay / 1000}s…`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
