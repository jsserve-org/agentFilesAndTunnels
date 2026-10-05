export {};

type Config = {
  registration_enabled: boolean;
  max_file_bytes: number;
  retention_hours: number;
};
type Credential = { id: string; token: string };
type Named = { id: string; label: string };
type Tunnel = {
  id: string;
  kind: "http" | "tcp";
  url: string | null;
  address: string | null;
  local_host: string;
  local_port: number;
  online: boolean;
};
type StoredFile = {
  name: string;
  url: string;
  expires_at: number;
  size: number;
};
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
const notice = (message: string) => {
  element("notice").textContent = message;
};
const show = (id: string, visible = true) =>
  element(id).classList.toggle("hidden", !visible);
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new ApiError(
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : data && typeof data === "object" && "message" in data
          ? String(data.message)
          : "Request failed.",
      response.status,
    );
  return data as T;
}
function action(
  id: string,
  callback: (event: Event) => Promise<void>,
  eventName = "click",
) {
  element(id).addEventListener(eventName, (event) => {
    event.preventDefault();
    callback(event).catch((error) =>
      notice(error instanceof Error ? error.message : "Request failed."),
    );
  });
}
function item(text: string) {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}
function button(
  text: string,
  callback: () => Promise<void>,
  style = "secondary",
) {
  const value = document.createElement("button");
  value.textContent = text;
  value.className = style;
  value.onclick = () => {
    value.disabled = true;
    callback()
      .catch((error) => notice(error.message))
      .finally(() => {
        value.disabled = false;
      });
  };
  return value;
}
function formData(id: string) {
  return Object.fromEntries(new FormData(element<HTMLFormElement>(id)));
}
let lastPrompt = "";
let signedIn = false;
let registrationLoaded = false;

function displayAgent(credential: Credential) {
  element("agent-secret").textContent =
    `Agent ID: ${credential.id}\nToken: ${credential.token}`;
  show("agent-secret");
  lastPrompt = `Connect this laptop to Relay desk and expose only the local service I request.\n\nDownload the CLI from ${location.origin}/cli.js and save it as relay.js. It requires Bun 1.3.6 or later.\n\nSet these environment variables in the process running the CLI (do not commit or publish the token):\nRELAY_SERVER=${location.origin}\nRELAY_AGENT=${credential.id}\nRELAY_TOKEN=${credential.token}\n\nKeep \`bun relay.js connect\` running. Create a tunnel with \`bun relay.js create http --local-port PORT\`, or use \`create tcp\` for raw TCP and local HTTPS. Return the assigned URL or address. To stop a tunnel run \`bun relay.js stop TUNNEL_ID\`. To upload a file run \`bun relay.js upload PATH\`. List existing tunnels before creating duplicates.\n\nMCP endpoint: ${location.origin}/mcp (Authorization: Bearer token above). The CLI connection must remain running for either API or MCP-created tunnels to work.`;
  show("copy-prompt");
}
async function refreshConfig() {
  const config = await api<Config>("/config");
  show("register-card", config.registration_enabled);
  element<HTMLInputElement>("registration-enabled").checked =
    config.registration_enabled;
  element("file-label").textContent =
    `Choose a file (up to ${Math.round(config.max_file_bytes / 1024 / 1024)} MB)`;
  element("upload-button").textContent =
    `Upload for ${config.retention_hours} hours`;
}
async function refresh() {
  try {
    const me = await api<{ user: { email: string }; admin: boolean }>("/me");
    signedIn = true;
    show("auth", false);
    show("dashboard");
    show("admin", me.admin);
    element("identity").textContent = me.user.email;
    if (!registrationLoaded) {
      await refreshConfig();
      registrationLoaded = true;
    }
    const [keys, agents, tunnels, files] = await Promise.all([
      api<Named[]>("/keys"),
      api<Named[]>("/agents"),
      api<Tunnel[]>("/tunnels"),
      api<StoredFile[]>("/files"),
    ]);
    element("keys").replaceChildren(
      ...keys.map((key) => {
        const li = item(`${key.label} · ${key.id} `);
        li.append(
          button(
            "Revoke key",
            async () => {
              await api(`/keys/${key.id}`, { method: "DELETE" });
              notice("API key revoked.");
              await refresh();
            },
            "danger",
          ),
        );
        return li;
      }),
    );
    element("agents").replaceChildren(
      ...agents.map((agent) => {
        const li = item(`${agent.label} · ${agent.id} `);
        li.append(
          button("Replace token", async () => {
            const credential = await api<Credential>(
              `/agents/${agent.id}/rotate`,
              { method: "POST" },
            );
            displayAgent(credential);
            notice(
              "Old token revoked. Reconnect this agent with the new token.",
            );
            await refresh();
          }),
        );
        return li;
      }),
    );
    element("tunnels").replaceChildren(
      ...(tunnels.length
        ? tunnels.map((tunnel) => {
            const li = item(`${tunnel.kind.toUpperCase()} · `);
            if (tunnel.url) {
              const link = document.createElement("a");
              link.href = tunnel.url;
              link.textContent = tunnel.url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              li.append(link);
            } else li.append(document.createTextNode(tunnel.address || ""));
            li.append(
              document.createTextNode(
                ` → ${tunnel.local_host}:${tunnel.local_port} `,
              ),
            );
            const status = document.createElement("span");
            status.className = `pill${tunnel.online ? "" : " off"}`;
            status.textContent = tunnel.online ? "Online" : "Laptop offline";
            li.append(status);
            li.append(
              button(
                "Stop tunnel",
                async () => {
                  await api(`/tunnels/${tunnel.id}`, { method: "DELETE" });
                  notice("Tunnel stopped and connections closed.");
                  await refresh();
                },
                "danger",
              ),
            );
            return li;
          })
        : [
            item(
              "No tunnels yet. Create an agent, copy its prompt, and ask it to publish a local port.",
            ),
          ]),
    );
    element("files").replaceChildren(
      ...(files.length
        ? files.map((file) => {
            const li = item(
              `${file.name} · ${file.size.toLocaleString()} bytes · expires ${new Date(file.expires_at).toLocaleString()} · `,
            );
            const link = document.createElement("a");
            link.href = file.url;
            link.textContent = "Download";
            li.append(link);
            li.append(
              button("Copy link", async () => {
                await navigator.clipboard.writeText(file.url);
                notice(
                  "Download link copied. Anyone with this link can download the file until it expires.",
                );
              }),
            );
            return li;
          })
        : [item("No files yet. Upload a file to create a download link.")]),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      signedIn = false;
      show("auth");
      show("dashboard", false);
      element("identity").textContent = "Laptop links, held in place.";
    } else throw error;
  }
}
for (const name of ["login", "register"])
  action(
    name,
    async () => {
      await api(
        name === "register" ? "/auth/sign-up/email" : "/auth/sign-in/email",
        {
          method: "POST",
          body: JSON.stringify({
            ...formData(name),
            ...(name === "register"
              ? { name: String(formData(name).email).split("@")[0] }
              : {}),
          }),
        },
      );
      element<HTMLFormElement>(name).reset();
      registrationLoaded = false;
      notice("Signed in.");
      await refresh();
    },
    "submit",
  );
action("logout", async () => {
  await api("/auth/sign-out", { method: "POST" });
  lastPrompt = "";
  element("new-key").textContent = "";
  element("agent-secret").textContent = "";
  show("new-key", false);
  show("agent-secret", false);
  show("copy-prompt", false);
  registrationLoaded = false;
  notice("Signed out.");
  await refreshConfig();
  await refresh();
});
action(
  "change-password",
  async () => {
    await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        ...formData("change-password"),
        revokeOtherSessions: true,
      }),
    });
    element<HTMLFormElement>("change-password").reset();
    notice("Password changed. Other browser sessions have been signed out.");
  },
  "submit",
);
action("revoke-sessions", async () => {
  await api("/auth/revoke-other-sessions", { method: "POST", body: "{}" });
  notice("Other browser sessions have been signed out.");
});
action("save-registration", async () => {
  await api("/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({
      registration_enabled: element<HTMLInputElement>("registration-enabled")
        .checked,
    }),
  });
  await refreshConfig();
  notice("Registration setting saved.");
});
action(
  "key-form",
  async () => {
    const credential = await api<Credential>("/keys", {
      method: "POST",
      body: JSON.stringify(formData("key-form")),
    });
    element("new-key").textContent = credential.token;
    show("new-key");
    await refresh();
  },
  "submit",
);
action(
  "agent-form",
  async () => {
    displayAgent(
      await api<Credential>("/agents", {
        method: "POST",
        body: JSON.stringify(formData("agent-form")),
      }),
    );
    await refresh();
  },
  "submit",
);
action("copy-prompt", async () => {
  await navigator.clipboard.writeText(lastPrompt);
  notice("Agent prompt copied. It contains the agent token.");
});
action(
  "upload",
  async () => {
    const uploaded = await api<StoredFile>("/files", {
      method: "POST",
      body: new FormData(element<HTMLFormElement>("upload")),
    });
    notice(`Uploaded. Download link: ${uploaded.url}`);
    element<HTMLFormElement>("upload").reset();
    await refresh();
  },
  "submit",
);
Promise.all([refreshConfig(), refresh()]).catch((error) =>
  notice(error.message),
);
setInterval(() => {
  if (signedIn && !document.hidden)
    refresh().catch((error) => notice(error.message));
}, 15_000);
