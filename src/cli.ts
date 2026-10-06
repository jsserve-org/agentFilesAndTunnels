import WebSocket from "ws";
import {
  openAsBlob,
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
const credentialPath =
  opt("config", process.env.RELAY_CONFIG) ||
  join(homedir(), ".config", "relay", "credentials.json");
let saved: { server?: string; agent?: string; token?: string } = {};
try {
  saved = JSON.parse(readFileSync(credentialPath, "utf8")) as typeof saved;
} catch (error) {
  if (!(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  ))
    throw new Error(
      "Could not read Relay credentials. Check your --config file.",
    );
}
const selectedServer =
  opt("server", process.env.RELAY_SERVER) || saved.server || "";
const sameServer =
  !saved.server || selectedServer.replace(/\/$/, "") === saved.server;
const server = selectedServer.replace(/\/$/, "");
const agent =
  opt("agent", process.env.RELAY_AGENT) ||
  (sameServer ? saved.agent : "") ||
  "";
const token =
  opt("token", process.env.RELAY_TOKEN) ||
  (sameServer ? saved.token : "") ||
  "";
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
    console.log(`Relayoo CLI

Commands:
  login --server URL               Authorize this agent in your browser (OAuth device flow)
  connect                          Keep this laptop connected; reconnect automatically
  create http|tcp --local-port PORT Create a tunnel; optional --name my-demo
  list                             List active tunnel reservations
  stop TUNNEL_ID                   Close a tunnel and all its connections
  upload FILE_PATH [--permanent]   Upload for 72 hours, or keep until deleted
  deploy ZIP --name NAME            Host a static site (use --site ID to update)
  update-site SITE_ID ZIP           Replace a site's files without changing its URL
  sites                            List hosted sites
  delete-site SITE_ID               Delete a hosted site and its files

Credentials: --server URL --agent ID --token TOKEN
Environment: RELAY_SERVER, RELAY_AGENT, RELAY_TOKEN
The agent ID is needed for connect and create. An account API key can list,
stop and upload; an agent token can manage only its own tunnels.`);
    return;
  }
  if (!server || (!token && command !== "login"))
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
  if (command === "login") {
    if (
      origin.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
      throw new Error(
        "Device authorization requires HTTPS (except localhost).",
      );
    const response = await fetch(`${server}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "relay-cli",
        scope: "agent:tunnels files:upload",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error("Could not request device authorization.");
    const device = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    console.log(
      `Open ${device.verification_uri_complete}\nCheck this code in your browser: ${device.user_code}\nWaiting for approval…`,
    );
    const deadline = Date.now() + device.expires_in * 1000;
    let interval = device.interval;
    while (Date.now() < deadline) {
      await sleep(interval * 1000);
      const response = await fetch(`${server}/api/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "relay-cli",
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const grant = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (grant.error === "authorization_pending") continue;
      if (grant.error === "slow_down") {
        interval += 5;
        continue;
      }
      if (!response.ok || !grant.access_token)
        throw new Error(grant.error || "Device authorization failed.");
      const linked = await fetch(`${server}/api/agents/oauth`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${grant.access_token}`,
        },
        body: JSON.stringify({ label: opt("name", hostname()) }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await linked.json()) as { id?: string; error?: string };
      if (!linked.ok || !result.id)
        throw new Error(
          result.error || "Could not register the approved agent.",
        );
      mkdirSync(join(credentialPath, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(
        credentialPath,
        JSON.stringify(
          { server, agent: result.id, token: grant.access_token },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      chmodSync(credentialPath, 0o600);
      console.log(
        `Agent approved: ${result.id}\nCredentials saved to ${credentialPath}.\nRun relayoo connect to keep this agent online. Device sessions expire; run login again when required.`,
      );
      return;
    }
    throw new Error("Device approval expired. Run login again.");
  }
  if (["connect", "create"].includes(command) && !agent)
    throw new Error("Set RELAY_AGENT or pass --agent ID.");
  if (command === "list") {
    console.log(JSON.stringify(await tunnels(), null, 2));
    return;
  }
  if (command === "sites") {
    console.log(JSON.stringify(await api("/sites"), null, 2));
    return;
  }
  if (command === "delete-site") {
    const siteId = args[1];
    if (!siteId || !/^[a-f0-9]{32}$/.test(siteId))
      throw new Error("Usage: delete-site SITE_ID");
    await api(`/sites/${siteId}`, { method: "DELETE" });
    console.log("Site deleted.");
    return;
  }
  if (command === "deploy") {
    const path = args[1],
      name = opt("name"),
      visibility = opt("visibility"),
      siteId = opt("site");
    if (
      !path ||
      (!name && !siteId) ||
      (visibility !== undefined && !["login", "public"].includes(visibility))
    )
      throw new Error(
        "Usage: deploy ZIP --name NAME [--visibility login|public] [--site SITE_ID]",
      );
    const form = new FormData();
    if (name) form.set("name", name);
    if (siteId) {
      if (visibility) form.set("visibility", visibility);
    } else form.set("visibility", visibility || "login");
    form.set("file", await openAsBlob(path), "site.zip");
    console.log(
      JSON.stringify(
        await api(siteId ? `/sites/${siteId}` : "/sites", {
          method: siteId ? "PUT" : "POST",
          body: form,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "update-site") {
    const siteId = args[1], path = args[2];
    if (!siteId || !/^[a-f0-9]{32}$/.test(siteId) || !path)
      throw new Error("Usage: update-site SITE_ID ZIP");
    const form = new FormData();
    form.set("file", await openAsBlob(path), "site.zip");
    console.log(JSON.stringify(await api(`/sites/${siteId}`, { method: "PUT", body: form }), null, 2));
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
        name: opt("name"),
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
    if (!path) throw new Error("Usage: upload FILE_PATH [--permanent]");
    const file = await openAsBlob(path);
    const form = new FormData();
    form.set("file", file, path.split(/[\\/]/).pop() || "file");
    form.set("permanent", String(args.includes("--permanent")));
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
      const webStreams = new Map<string, WebSocket>();
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
          for (const socket of webStreams.values()) socket.close();
          webStreams.clear();
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
        if (frame.type === "ws_open" && frame.id && frame.tunnelId) {
          const t = await getTunnel(frame.tunnelId);
          if (!t || t.kind !== "http") throw new Error("Tunnel no longer exists.");
          const host = t.local_host === "::1" ? "[::1]" : t.local_host;
          if (!frame.path?.startsWith("/")) throw new Error("Invalid WebSocket path.");
          const local = new WebSocket(`ws://${host}:${t.local_port}${frame.path}`);
          webStreams.set(frame.id, local);
          local.onopen = () => {};
          local.onmessage = (event) => {
            const bytes = Buffer.isBuffer(event.data) ? event.data : Buffer.from(String(event.data));
            send({ type: "ws_data", id: frame.id, body: bytes.toString("base64") });
          };
          local.onerror = () => { send({ type: "ws_close", id: frame.id }); local.close(); };
          local.onclose = () => { webStreams.delete(frame.id!); send({ type: "ws_close", id: frame.id }); };
          return;
        }
        if (frame.type === "ws_data" && frame.id && frame.body) {
          const local = webStreams.get(frame.id);
          if (local?.readyState === WebSocket.OPEN) local.send(Buffer.from(frame.body, "base64"));
          return;
        }
        if (frame.type === "ws_close" && frame.id) {
          webStreams.get(frame.id)?.close();
          webStreams.delete(frame.id);
          return;
        }
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
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
