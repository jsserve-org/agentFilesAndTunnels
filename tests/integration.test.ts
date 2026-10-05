import { request as httpRequest } from "node:http";
import { after as afterAll, before as beforeAll, test } from "node:test";
import { expect } from "expect";
import { zipSync, strToU8 } from "fflate";
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

import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
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
  ).toHaveLength(8);
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

async function renewAdmin() {
  const signed = await request("/api/auth/sign-in/email", "POST", {
    email: "admin@example.com",
    password: "replacement password 456",
  });
  expect(signed.status).toBe(200);
  cookie = signed.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

test("admin creates users with registration closed; resource limits cover REST and MCP", async () => {
  await renewAdmin();
  await request("/api/admin/settings", "PATCH", {
    registration_enabled: false,
  });
  const limits = { storage_bytes: 5, tunnels: 1 };
  const created = await request("/api/admin/users", "POST", {
    name: "Limited user",
    email: "limited@example.com",
    password: "limited password 123",
    limits,
  });
  expect(created.status).toBe(201);
  const account = (await created.json()) as { user: { id: string } };
  const signed = await request("/api/auth/sign-in/email", "POST", {
    email: "limited@example.com",
    password: "limited password 123",
  });
  expect(signed.status).toBe(200);
  const userCookie = signed.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(
    (await request("/api/admin/users", "GET", undefined, userCookie)).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/admin/users",
        "POST",
        { name: "No", email: "no@example.com", password: "password is long" },
        userCookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/admin/users/" + account.user.id + "/limits",
        "PATCH",
        limits,
        userCookie,
      )
    ).status,
  ).toBe(403);
  const agentResponse = await request(
    "/api/agents",
    "POST",
    { label: "limited agent" },
    userCookie,
  );
  const limitedAgent = (await agentResponse.json()) as Credential;
  expect(agentResponse.status).toBe(201);
  expect(
    (await request("/api/agents", "POST", { label: "extra" }, userCookie))
      .status,
  ).toBe(201);
  expect(
    (await request("/api/keys", "POST", { label: "one" }, userCookie)).status,
  ).toBe(201);
  expect(
    (await request("/api/keys", "POST", { label: "extra" }, userCookie)).status,
  ).toBe(201);
  const tunnel = await request(
    "/api/tunnels",
    "POST",
    { agent_id: limitedAgent.id, kind: "http", local_port: 3000 },
    userCookie,
  );
  expect(tunnel.status).toBe(201);
  expect(
    (
      await request(
        "/api/tunnels",
        "POST",
        { agent_id: limitedAgent.id, kind: "http", local_port: 3001 },
        userCookie,
      )
    ).status,
  ).toBe(429);
  const mcp = await fetch(origin + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${limitedAgent.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_tunnel",
        arguments: {
          agent_id: limitedAgent.id,
          kind: "http",
          local_port: 3001,
        },
      },
    }),
  });
  expect(
    ((await mcp.json()) as { result: { isError: boolean } }).result.isError,
  ).toBe(true);
  expect(
    (
      await fetch(origin + "/api/files", {
        method: "POST",
        headers: {
          cookie: userCookie,
          "content-type": "text/plain",
          "x-file-name": "too-large.txt",
        },
        body: "123456",
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await fetch(origin + "/api/files", {
        method: "POST",
        headers: {
          cookie: userCookie,
          "content-type": "text/plain",
          "x-file-name": "fits.txt",
        },
        body: "12345",
      })
    ).status,
  ).toBe(201);
  const zero = { storage_bytes: 0, tunnels: 0 };
  expect(
    (await request(`/api/admin/users/${account.user.id}/limits`, "PATCH", zero))
      .status,
  ).toBe(200);
  const usage = (await (
    await request("/api/usage", "GET", undefined, userCookie)
  ).json()) as { limits: typeof zero; usage: typeof zero };
  expect(usage.limits).toEqual(zero);
  expect(usage.usage.tunnels).toBe(1);
  expect(
    (
      await request(`/api/admin/users/${account.user.id}/limits`, "PATCH", {
        ...zero,
        tunnels: -1,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/api/auth/admin/create-user", "POST", {
        email: "bypass@example.com",
        password: "bypass password 123",
        name: "bypass",
      })
    ).status,
  ).toBe(404);
  await request("/api/admin/settings", "PATCH", { registration_enabled: true });
});

test("admin moderation stops other users' tunnels, deletes files and revokes credentials", async () => {
  const resources = (await (await request("/api/admin/resources")).json()) as {
    tunnels: (Tunnel & { email: string })[];
    files: { id: string; email: string; url: string }[];
    agents: { id: string; email: string }[];
    keys: { id: string; email: string }[];
  };
  const tunnel = resources.tunnels.find(
    (t) => t.email === "limited@example.com",
  )!;
  expect(
    (await request(`/api/admin/tunnels/${tunnel.id}`, "DELETE")).status,
  ).toBe(200);
  const file = resources.files.find((f) => f.email === "limited@example.com")!;
  expect((await request(`/api/admin/files/${file.id}`, "DELETE")).status).toBe(
    200,
  );
  expect((await fetch(file.url)).status).toBe(404);
  const key = resources.keys.find((k) => k.email === "limited@example.com")!;
  expect((await request(`/api/admin/keys/${key.id}`, "DELETE")).status).toBe(
    200,
  );
  const agent = resources.agents.find(
    (a) => a.email === "limited@example.com",
  )!;
  expect(
    (await request(`/api/admin/agents/${agent.id}`, "DELETE")).status,
  ).toBe(200);
  expect(
    (await request(`/api/admin/agents/${agent.id}`, "DELETE")).status,
  ).toBe(404);
});

test("OAuth device authorization creates a scoped agent and admin revocation denies subsequent access", async () => {
  expect(
    (await request("/api/auth/device/code", "POST", { client_id: "unknown" }))
      .status,
  ).toBe(400);
  const response = await request("/api/auth/device/code", "POST", {
    client_id: "relay-cli",
    scope: "agent:tunnels files:upload",
  });
  expect(response.status).toBe(200);
  const device = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
  };
  expect(device.verification_uri_complete).toContain("/dashboard/agents");
  const grantBody = {
    client_id: "relay-cli",
    device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  };
  const pending = await request(
    "/api/auth/device/token",
    "POST",
    grantBody,
    "",
  );
  expect(((await pending.json()) as { error: string }).error).toBe(
    "authorization_pending",
  );
  expect(
    (
      await request(
        "/api/auth/device/approve",
        "POST",
        { userCode: device.user_code },
        "",
      )
    ).status,
  ).toBe(401);
  expect(
    (await request(`/api/auth/device?user_code=${device.user_code}`)).status,
  ).toBe(200);
  expect(
    (
      await request("/api/auth/device/approve", "POST", {
        userCode: device.user_code,
      })
    ).status,
  ).toBe(200);
  await sleep(5100);
  const grant = await request("/api/auth/device/token", "POST", grantBody, "");
  expect(grant.status).toBe(200);
  const token = ((await grant.json()) as { access_token: string }).access_token;
  const oauthRequest = (path: string, method = "GET", body?: object) =>
    fetch(origin + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const registered = await oauthRequest("/api/agents/oauth", "POST", {
    label: "OAuth laptop",
  });
  expect(registered.status).toBe(201);
  const agent = (await registered.json()) as { id: string };
  expect((await oauthRequest("/api/me")).status).toBe(200);
  expect(
    (await oauthRequest("/api/keys", "POST", { label: "forbidden" })).status,
  ).toBe(403);
  expect((await oauthRequest("/api/admin/resources")).status).toBe(403);
  expect(
    (await oauthRequest("/api/auth/revoke-other-sessions", "POST", {})).status,
  ).toBe(403);
  const tunnel = await oauthRequest("/api/tunnels", "POST", {
    agent_id: agent.id,
    kind: "http",
    local_port: 3000,
  });
  expect(tunnel.status).toBe(201);
  expect(
    (
      await oauthRequest("/api/tunnels", "POST", {
        agent_id: httpTunnel.id,
        kind: "http",
        local_port: 3000,
      })
    ).status,
  ).toBe(403);
  const me = await oauthRequest("/api/me");
  expect(
    ((await me.json()) as { user: { agentId: string } }).user.agentId,
  ).toBe(agent.id);
  expect(
    (await request(`/api/admin/agents/${agent.id}`, "DELETE")).status,
  ).toBe(200);
  expect((await oauthRequest("/api/me")).status).toBe(401);
  expect(
    (await oauthRequest("/api/agents/oauth", "POST", { label: "revoked" }))
      .status,
  ).toBe(401);
  await sleep(5100);
  expect(
    (await request("/api/auth/device/token", "POST", grantBody, "")).status,
  ).not.toBe(200);
});

test("panel routes, agent docs and install script are publicly available", async () => {
  for (const path of [
    "/dashboard",
    "/dashboard/tunnels",
    "/dashboard/agents",
    "/dashboard/users",
    "/dashboard/resources",
  ])
    expect((await fetch(origin + path)).status).toBe(200);
  expect(await (await fetch(origin + "/AGENTS.md")).text()).toContain(
    "OAuth device authorization",
  );
  const installer = await (await fetch(origin + "/install.sh")).text();
  expect(installer).toContain(origin);
  expect(installer).not.toContain("{{ORIGIN}}");
  expect(
    (await fetch(origin + "/style.css")).headers.get("content-type"),
  ).toContain("text/css");
});

async function siteRequest(
  siteId: string,
  path: string,
  siteCookie?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      origin + path,
      {
        headers: {
          host: `s-${siteId}.tunnel.test`,
          ...(siteCookie ? { cookie: siteCookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const headers = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
async function deploySite(
  contents: Record<string, Uint8Array>,
  visibility = "public",
  auth = cookie,
) {
  const form = new FormData();
  form.set("name", "Demo website");
  form.set("visibility", visibility);
  form.set("file", new Blob([new Uint8Array(zipSync(contents))]), "site.zip");
  return fetch(origin + "/api/sites", {
    method: "POST",
    headers: { cookie: auth },
    body: form,
  });
}

test("static sites persist, isolate assets, and share account storage allowances", async () => {
  const contents = {
    "index.html": strToU8("<h1>Hosted demo</h1>"),
    "assets/app.js": strToU8("console.log('site')"),
  };
  const deployed = await deploySite(contents);
  expect(deployed.status).toBe(201);
  const site = (await deployed.json()) as {
    id: string;
    size: number;
    url: string;
  };
  expect(await (await siteRequest(site.id, "/")).text()).toContain(
    "Hosted demo",
  );
  expect(
    (await siteRequest(site.id, "/assets/app.js")).headers.get("content-type"),
  ).toContain("javascript");
  expect((await siteRequest(site.id, "/api/me")).status).toBe(404);
  expect((await siteRequest(site.id, "/%2e%2e/app.sqlite")).status).toBe(404);
  expect((await siteRequest(site.id, "/%2eenv")).status).toBe(404);
  expect(
    (
      await deploySite({
        "index.html": strToU8("ok"),
        "../escape": strToU8("bad"),
      })
    ).status,
  ).toBe(400);
  expect((await deploySite({ "other.html": strToU8("no index") })).status).toBe(
    400,
  );
  const database = new Database(join(dataDir, "app.sqlite"));
  const user = (
    database
      .prepare("SELECT id FROM users WHERE email=?")
      .get("admin@example.com") as { id: string }
  ).id;
  const used = (
    (await (await request("/api/usage")).json()) as {
      usage: { storage_bytes: number };
    }
  ).usage.storage_bytes;
  expect(used).toBeGreaterThanOrEqual(site.size);
  await request(`/api/admin/users/${user}/limits`, "PATCH", {
    storage_bytes: used,
    tunnels: 100,
  });
  expect((await deploySite(contents)).status).toBe(413);
  expect(
    (
      await fetch(origin + "/api/files", {
        method: "POST",
        headers: { cookie, "x-file-name": "over-quota.txt" },
        body: "x",
      })
    ).status,
  ).toBe(413);
  await request(`/api/admin/users/${user}/limits`, "PATCH", {
    storage_bytes: 1024 ** 3,
    tunnels: 100,
  });
  serverProcess.kill();
  await serverProcess.exited;
  await startServer();
  expect(await (await siteRequest(site.id, "/")).text()).toContain(
    "Hosted demo",
  );
  expect((await request(`/api/admin/sites/${site.id}`, "DELETE")).status).toBe(
    200,
  );
  expect((await siteRequest(site.id, "/")).status).toBe(404);
  database.close();
});

test("protected hosted sites reuse Better Auth with site-bound one-time login and isolated cookies", async () => {
  const response = await deploySite(
    {
      "index.html": strToU8("Private site"),
      "secret.txt": strToU8("protected asset"),
    },
    "login",
  );
  const site = (await response.json()) as { id: string };
  const redirect = await siteRequest(site.id, "/secret.txt");
  expect(redirect.status).toBe(303);
  expect(redirect.headers.get("location")).toContain(
    `/dashboard/sites?site_login=${site.id}`,
  );
  expect((await siteRequest(site.id, "/secret.txt", cookie)).status).toBe(303);
  const login = await request(`/api/sites/${site.id}/login`, "POST", {
    return_path: "/secret.txt",
  });
  expect(login.status).toBe(200);
  const callback = new URL(((await login.json()) as { url: string }).url);
  const wrongSiteResponse = await deploySite(
    { "index.html": strToU8("Other site") },
    "login",
  );
  const wrongSite = (await wrongSiteResponse.json()) as { id: string };
  expect(
    (await siteRequest(wrongSite.id, callback.pathname + callback.search))
      .status,
  ).toBe(401);
  const authorized = await siteRequest(
    site.id,
    callback.pathname + callback.search,
  );
  expect(authorized.status).toBe(303);
  expect(authorized.headers.get("location")).toBe("/secret.txt");
  expect(authorized.headers.get("set-cookie")).toContain("HttpOnly");
  expect(authorized.headers.get("set-cookie")).not.toContain("Domain=");
  const siteCookie = authorized.headers.get("set-cookie")!.split(";")[0];
  expect(
    await (await siteRequest(site.id, "/secret.txt", siteCookie)).text(),
  ).toBe("protected asset");
  const me = (await (
    await siteRequest(site.id, "/__relay/me", siteCookie)
  ).json()) as { user: { email: string }; session?: unknown };
  expect(me.user.email).toBe("admin@example.com");
  expect(me.session).toBeUndefined();
  expect((await request("/api/me", "GET", undefined, siteCookie)).status).toBe(
    401,
  );
  expect(
    (await siteRequest(site.id, callback.pathname + callback.search)).status,
  ).toBe(401);
  expect((await request("/api/auth/one-time-token/generate")).status).toBe(404);
  const database = new Database(join(dataDir, "app.sqlite"));
  database
    .prepare(
      "UPDATE session SET expiresAt=? WHERE userId=(SELECT id FROM users WHERE email=?)",
    )
    .run(new Date(Date.now() - 86400000).toISOString(), "admin@example.com");
  database.close();
  expect((await siteRequest(site.id, "/secret.txt", siteCookie)).status).toBe(
    303,
  );
  await renewAdmin();
  await request(`/api/sites/${site.id}`, "DELETE");
  await request(`/api/sites/${wrongSite.id}`, "DELETE");
});

test("admin can change the advertised TCP hostname without changing reserved ports", async () => {
  const original = (await (await request("/api/admin/settings")).json()) as {
    tcp_public_host: string;
  };
  expect(
    (
      await request("/api/admin/settings", "PATCH", {
        tcp_public_host: "https://bad.example:443",
      })
    ).status,
  ).toBe(400);
  const saved = await request("/api/admin/settings", "PATCH", {
    tcp_public_host: "direct-tunnel.2oo.dev",
  });
  expect(saved.status).toBe(200);
  expect(
    ((await saved.json()) as { tcp_public_host: string }).tcp_public_host,
  ).toBe("direct-tunnel.2oo.dev");
  const config = (await (await fetch(`${origin}/api/config`)).json()) as {
    tcp_public_host: string;
    tcp_port_start: number;
  };
  expect(config.tcp_public_host).toBe("direct-tunnel.2oo.dev");
  expect(config.tcp_port_start).toBe(tcpPort);
  serverProcess.kill();
  await serverProcess.exited;
  await startServer();
  expect(
    (
      (await (await request("/api/admin/settings")).json()) as {
        tcp_public_host: string;
      }
    ).tcp_public_host,
  ).toBe("direct-tunnel.2oo.dev");
  await request("/api/admin/settings", "PATCH", {
    tcp_public_host: original.tcp_public_host,
  });
});

test("CLI device login saves private credentials and connects using OAuth", async () => {
  const config = join(dataDir, "cli-oauth", "credentials.json");
  const login = spawn(
    process.execPath,
    [
      "dist/relay.cjs",
      "login",
      "--server",
      origin,
      "--config",
      config,
      "--name",
      "CLI OAuth test",
    ],
    {
      env: {
        ...process.env,
        RELAY_SERVER: "",
        RELAY_TOKEN: "",
        RELAY_AGENT: "",
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let output = "";
  login.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) =>
    login.once("exit", resolve),
  );
  try {
    await eventually(async () =>
      /Check this code in your browser: (\S+)/.test(output),
    );
    const code = output.match(/Check this code in your browser: (\S+)/)?.[1];
    expect((await request(`/api/auth/device?user_code=${code}`)).status).toBe(200);
    expect(
      (await request("/api/auth/device/approve", "POST", { userCode: code }))
        .status,
    ).toBe(200);
    await eventually(async () => output.includes("Agent approved:"));
    expect(await exited).toBe(0);
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(config, "utf8")) as {
      agent: string;
      token: string;
      server: string;
    };
    const connected = launch(
      [process.execPath, "dist/relay.cjs", "connect", "--config", config],
      {
        env: {
          ...process.env,
          RELAY_TOKEN: "",
          RELAY_AGENT: "",
          RELAY_SERVER: "",
        },
      },
    );
    try {
      await eventually(async () =>
        (
          (await (await request("/api/agents")).json()) as {
            id: string;
            online: boolean;
          }[]
        ).some((a) => a.id === saved.agent && a.online),
      );
      const zipPath = join(dataDir, "cli-site.zip");
      await writeFile(
        zipPath,
        zipSync({ "index.html": strToU8("CLI hosted site") }),
      );
      const deploy = launch(
        [
          process.execPath,
          "dist/relay.cjs",
          "deploy",
          zipPath,
          "--name",
          "CLI site",
          "--visibility",
          "public",
          "--config",
          config,
        ],
        {
          env: {
            ...process.env,
            RELAY_TOKEN: "",
            RELAY_AGENT: "",
            RELAY_SERVER: "",
          },
        },
      );
      expect(await deploy.exited).toBe(0);
      const sites = (await (await request("/api/sites")).json()) as {
        id: string;
        name: string;
      }[];
      const site = sites.find((s) => s.name === "CLI site");
      expect(site).toBeDefined();
      if (site) await request(`/api/sites/${site.id}`, "DELETE");
      await request(`/api/admin/agents/${saved.agent}`, "DELETE");
      await eventually(async () => connected.exitCode !== null);
    } finally {
      connected.kill();
      await connected.exited;
    }
  } finally {
    login.kill();
    await exited;
  }
});
