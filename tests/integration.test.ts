import { request as httpRequest } from "node:http";
import { after as afterAll, before as beforeAll, test } from "node:test";
import { expect } from "expect";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
function launch(args: string[], options: { env: NodeJS.ProcessEnv }) {
  const child = spawn(args[0], args.slice(1), {
    env: options.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return Object.assign(child, { exited });
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Socket } from "node:net";
import Database from "better-sqlite3";

type Credential = { id: string; token: string };
type Tunnel = { id: string; public_port: number; url: string };
let dataDir: string;
let serverProcess: ReturnType<typeof launch>;
let cliProcess: ReturnType<typeof launch>;
let origin: string;
let serverPort: number;
let tcpPort: number;
let cookie: string;
let agent: Credential;
let httpTunnel: Tunnel;
let tcpTunnel: Tunnel;
let uploadedId: string;
let local: ReturnType<typeof serve>;
const echo = createServer({ allowHalfOpen: true }, (socket) => {
  socket.on("data", (chunk) => socket.write(chunk));
  socket.on("end", () => socket.end());
});
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("No port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
async function eventually(check: () => Promise<boolean>, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await check()) return;
    } catch {}
    await sleep(50);
  }
  throw Error("Timed out waiting for condition");
}
async function startServer() {
  serverProcess = launch([process.execPath, "dist/server.mjs"], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      BETTER_AUTH_SECRET: "integration-test-only-secret-12345678901234567890",
      PUBLIC_ORIGIN: origin,
      BASE_DOMAIN: "tunnel.test",
      TCP_PORT_START: String(tcpPort),
      TCP_PORT_END: String(tcpPort + 1),
      DATA_DIR: dataDir,
    },
  });
  await eventually(async () => (await fetch(origin + "/health")).ok);
}
async function startCli() {
  cliProcess = launch([process.execPath, "dist/relay.cjs", "connect"], {
    env: {
      ...process.env,
      RELAY_SERVER: origin,
      RELAY_AGENT: agent.id,
      RELAY_TOKEN: agent.token,
    },
  });
  await eventually(async () => {
    const response = await fetch(origin + "/api/tunnels", {
      headers: { cookie },
    });
    const tunnels = (await response.json()) as { online: boolean }[];
    return tunnels.length > 0 && tunnels.every((t) => t.online);
  });
}
async function request(
  path: string,
  method = "GET",
  value?: object,
  auth = cookie,
) {
  return fetch(origin + path, {
    method,
    headers: {
      ...(auth ? { cookie: auth } : {}),
      origin,
      "content-type": "application/json",
    },
    body: value ? JSON.stringify(value) : undefined,
  });
}
async function proxy(path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      origin + path,
      { headers: { host: httpTunnel.id + ".tunnel.test" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const headers = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          resolve(
            new Response(
              [204, 205, 304].includes(res.statusCode || 0)
                ? null
                : Buffer.concat(chunks),
              { status: res.statusCode, headers },
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "relay-test-"));
  serverPort = await freePort();
  tcpPort = await freePort();
  origin = `http://127.0.0.1:${serverPort}`;
  local = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/empty")
        return new Response(null, { status: 204 });
      const headers = new Headers();
      headers.append("set-cookie", "one=1; Path=/");
      headers.append("set-cookie", "two=2; Path=/");
      return new Response("local:" + new URL(request.url).pathname, {
        headers,
      });
    },
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  await startServer();
});
afterAll(async () => {
  cliProcess?.kill();
  serverProcess?.kill();
  await Promise.allSettled([cliProcess?.exited, serverProcess?.exited]);
  local?.close();
  if (local && "closeAllConnections" in local) local.closeAllConnections();
  echo.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("accounts, session, credentials and registration toggle", async () => {
  const registered = await request("/api/auth/sign-up/email", "POST", {
    name: "Test user",
    email: "admin@example.com",
    password: "a secure password 123",
  });
  if (!registered.ok) console.error(await registered.clone().text());
  expect(registered.status).toBe(200);
  cookie = registered.headers.get("set-cookie")!.split(";")[0];
  const me = (await (await request("/api/me")).json()) as { admin: boolean };
  expect(me.admin).toBe(true);
  const createdKey = await request("/api/keys", "POST", { label: "test" });
  const key = (await createdKey.json()) as Credential;
  expect(
    (
      await fetch(origin + "/api/me", {
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).status,
  ).toBe(200);
  await request("/api/keys/" + key.id, "DELETE");
  expect(
    (
      await fetch(origin + "/api/me", {
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).status,
  ).toBe(401);
  agent = (await (
    await request("/api/agents", "POST", { label: "test laptop" })
  ).json()) as Credential;
  expect(
    (
      await fetch(origin + "/api/keys", {
        headers: { authorization: `Bearer ${agent.token}` },
      })
    ).status,
  ).toBe(403);
  await request("/api/admin/settings", "PATCH", {
    registration_enabled: false,
  });
  expect(
    (
      await request("/api/auth/sign-up/email", "POST", {
        name: "Test user",
        email: "blocked@example.com",
        password: "a secure password 123",
      })
    ).status,
  ).toBe(403);
  await request("/api/admin/settings", "PATCH", { registration_enabled: true });
});

test("HTTP root, reserved API paths, cookies, disconnect and reconnect", async () => {
  httpTunnel = (await (
    await request("/api/tunnels", "POST", {
      agent_id: agent.id,
      kind: "http",
      local_port: (local.address() as { port: number }).port,
    })
  ).json()) as Tunnel;
  const address = echo.address();
  if (!address || typeof address === "string") throw Error("No echo address");
  tcpTunnel = (await (
    await request("/api/tunnels", "POST", {
      agent_id: agent.id,
      kind: "tcp",
      local_port: address.port,
    })
  ).json()) as Tunnel;
  expect((await proxy("/")).status).toBe(503);
  expect((await proxy("/api/me")).status).toBe(503);
  await startCli();
  const root = await proxy("/");
  expect(await root.text()).toBe("local:/");
  expect(root.headers.getSetCookie()).toHaveLength(2);
  expect(await (await proxy("/api/me")).text()).toBe("local:/api/me");
  expect((await proxy("/empty")).status).toBe(204);
  cliProcess.kill();
  await cliProcess.exited;
  await eventually(async () => (await proxy("/")).status === 503);
  await startCli();
  expect(await (await proxy("/")).text()).toBe("local:/");
});

test("TCP forwards a large payload with backpressure and stops existing sockets", async () => {
  const socket = connect(tcpTunnel.public_port, "127.0.0.1");
  const payload = Buffer.alloc(1024 * 1024, 42);
  let received = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.from(chunk)]);
      if (received.length === payload.length) resolve();
    });
    socket.setTimeout(5000, () => reject(Error("TCP timeout")));
  });
  expect(received.equals(payload)).toBe(true);
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  expect((await request("/api/tunnels/" + tcpTunnel.id, "DELETE")).status).toBe(
    200,
  );
  await closed;
  const address = echo.address();
  if (!address || typeof address === "string") throw Error("No echo address");
  const reused = await request("/api/tunnels", "POST", {
    agent_id: agent.id,
    kind: "tcp",
    local_port: address.port,
  });
  expect(reused.status).toBe(201);
  tcpTunnel = (await reused.json()) as Tunnel;
  expect(tcpTunnel.public_port).toBe(tcpPort);
});

test("files last at least 72 hours and MCP can upload and list", async () => {
  const form = new FormData();
  form.set(
    "file",
    new File(["hello file"], "demo.txt", { type: "text/plain" }),
  );
  const uploaded = (await (
    await fetch(origin + "/api/files", {
      method: "POST",
      headers: { cookie },
      body: form,
    })
  ).json()) as { id: string; url: string; expires_at: number };
  uploadedId = uploaded.id;
  expect(uploaded.expires_at - Date.now()).toBeGreaterThan(
    72 * 3600_000 - 5000,
  );
  expect(await (await fetch(uploaded.url)).text()).toBe("hello file");
  const rpc = async (method: string, params?: object) =>
    request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method, params });
  expect(
    (
      (await (await rpc("initialize")).json()) as {
        result: { protocolVersion: string };
      }
    ).result.protocolVersion,
  ).toBe("2025-03-26");
  expect(
    (
      (await (await rpc("tools/list")).json()) as {
        result: { tools: unknown[] };
      }
    ).result.tools,
  ).toHaveLength(5);
  const result = (await (
    await rpc("tools/call", {
      name: "upload_file",
      arguments: {
        name: "mcp.txt",
        content_base64: Buffer.from("mcp file").toString("base64"),
      },
    })
  ).json()) as { result: { content: { text: string }[] } };
  const file = JSON.parse(result.result.content[0].text) as { url: string };
  expect(await (await fetch(file.url)).text()).toBe("mcp file");
});

test("server restart preserves URLs and files; CLI reconnects automatically", async () => {
  serverProcess.kill();
  await serverProcess.exited;
  await startServer();
  await eventually(async () => {
    const response = await proxy("/");
    return response.ok && (await response.text()) === "local:/";
  }, 15_000);
  expect(await (await fetch(origin + "/f/" + uploadedId)).text()).toBe(
    "hello file",
  );
  const database = new Database(join(dataDir, "app.sqlite"));
  database
    .prepare("UPDATE files SET expires_at=? WHERE id=?")
    .run(Date.now() - 1, uploadedId);
  database.close();
  expect((await fetch(origin + "/f/" + uploadedId)).status).toBe(404);
});

test("different accounts cannot stop tunnels or change registration; origins are checked", async () => {
  const r = await request("/api/auth/sign-up/email", "POST", {
    name: "Test user",
    email: "other@example.com",
    password: "another password 123",
  });
  const other = r.headers.get("set-cookie")!.split(";")[0];
  expect(
    (await request("/api/tunnels/" + httpTunnel.id, "DELETE", undefined, other))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        "/api/admin/settings",
        "PATCH",
        { registration_enabled: false },
        other,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(origin + "/api/keys", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "bad" }),
      })
    ).status,
  ).toBe(403);
});

test("token replacement revokes the old token and preserves tunnel IDs", async () => {
  const oldToken = agent.token;
  agent = (await (
    await request("/api/agents/" + agent.id + "/rotate", "POST")
  ).json()) as Credential;
  expect(
    (
      await fetch(origin + "/api/tunnels", {
        headers: { authorization: `Bearer ${oldToken}` },
      })
    ).status,
  ).toBe(401);
  await cliProcess.exited;
  await startCli();
  expect(await (await proxy("/")).text()).toBe("local:/");
});

test("Better Auth rejects forged sessions, wrong passwords and disabled signup", async () => {
  const fake = "better-auth.session_token=forged-session.forged-signature";
  expect((await request("/api/me", "GET", undefined, fake)).status).toBe(401);
  expect(
    (
      await request("/api/auth/sign-in/email", "POST", {
        email: "admin@example.com",
        password: "wrong password",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/api/auth/sign-up/email", "POST", {
        email: "short@example.com",
        name: "Short",
        password: "short",
      })
    ).status,
  ).toBe(400);
  await request("/api/admin/settings", "PATCH", {
    registration_enabled: false,
  });
  expect(
    (
      await request("/api/auth/sign-up/email", "POST", {
        email: "direct@example.com",
        name: "Direct",
        password: "valid password 123",
      })
    ).status,
  ).toBe(403);
  await request("/api/admin/settings", "PATCH", { registration_enabled: true });
  expect(
    (
      await fetch(origin + "/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "a secure password 123",
        }),
      })
    ).status,
  ).toBe(403);
  expect(
    (await request("/api/auth/api-key/create", "POST", { name: "bypass" }))
      .status,
  ).toBe(404);
});

test("Better Auth changes passwords, invalidates other sessions and signs out", async () => {
  const signin = async (password: string) =>
    request("/api/auth/sign-in/email", "POST", {
      email: "admin@example.com",
      password,
    });
  const first = await signin("a secure password 123");
  expect(first.status).toBe(200);
  const firstCookie = first.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const second = await signin("a secure password 123");
  const secondCookie = second.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const changed = await request(
    "/api/auth/change-password",
    "POST",
    {
      currentPassword: "a secure password 123",
      newPassword: "replacement password 456",
      revokeOtherSessions: true,
    },
    firstCookie,
  );
  expect(changed.status).toBe(200);
  expect(
    (await request("/api/me", "GET", undefined, secondCookie)).status,
  ).toBe(401);
  expect((await signin("a secure password 123")).status).toBe(401);
  const current = await signin("replacement password 456");
  expect(current.status).toBe(200);
  const currentCookie = current.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(
    (await request("/api/auth/sign-out", "POST", {}, currentCookie)).status,
  ).toBe(200);
  expect(
    (await request("/api/me", "GET", undefined, currentCookie)).status,
  ).toBe(401);
});

test("Better Auth rejects expired sessions and stores credentials in its own tables", async () => {
  const signed = await request("/api/auth/sign-in/email", "POST", {
    email: "admin@example.com",
    password: "replacement password 456",
  });
  const sessionCookie = signed.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const database = new Database(join(dataDir, "app.sqlite"));
  database
    .prepare("UPDATE session SET expiresAt=?")
    .run(new Date(Date.now() - 86400000).toISOString());
  const password = database
    .prepare(
      "SELECT password FROM account WHERE providerId='credential' LIMIT 1",
    )
    .get() as { password: string };
  expect(password.password).not.toBe("replacement password 456");
  expect(
    (
      database.prepare("PRAGMA table_info(users)").all() as { name: string }[]
    ).some((c) => c.name === "password"),
  ).toBe(false);
  database.close();
  expect(
    (await request("/api/me", "GET", undefined, sessionCookie)).status,
  ).toBe(401);
});
