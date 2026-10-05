# Relay desk

A Node.js 22 + TypeScript service with a browser panel, laptop CLI, public REST API and HTTP MCP endpoint. SQLite stores accounts and permanent tunnel reservations; uploaded files live on the same persistent volume. This is a single-server deployment.

## What it does

- Register, log in, create/revoke account API keys and create/replace agent tokens.
- Turn registration on or off immediately from the first user's administrator panel.
- Assign random permanent HTTP subdomains. The laptop connects outbound, so a changed laptop IP does not change the public link. Reconnects work after 24 hours and beyond. Reservations persist until explicitly stopped.
- Show an offline page while a laptop is disconnected. Requests are not queued or replayed.
- Forward raw TCP ports, including HTTPS bytes, through the same outbound connection.
- Stop a tunnel from the laptop CLI or panel, including existing TCP connections.
- Store files for at least 72 hours; return an unguessable public download link. Anyone holding that link can download until expiry. Cleanup runs hourly.
- Manage tunnels, files, static sites, agents, API keys and accounts on dedicated pages in a shadcn/ui sidebar panel. Avatars use Gravatar.
- Administrators create users through Better Auth, set storage/tunnel allowances, and delete abusive tunnels, files, sites and credentials. Agents and API keys have no count caps.
- Host persistent static ZIP sites with optional platform login, using the existing wildcard proxy.
- Expose tunnels, files and static sites as MCP tools at `/mcp`.

## Authentication

Authentication is provided by [Better Auth](https://www.better-auth.com/) and its official `@better-auth/api-key` plugin. Better Auth owns password hashing, credential validation, signed session cookies, session expiry/revocation, origin checks on auth endpoints, and database-backed auth rate limits. Account API keys and manually issued agent tokens are generated, hashed, verified and revoked by the API key plugin. Browser-approved agents use Better Auth device authorization sessions. The application only maps verified identities to owned tunnels/files and administrator permissions.

The panel includes password changes and signing out other browsers. API keys and agent tokens must be revoked separately. Email verification and forgotten-password email delivery are not configured; no email sender has been supplied.

Generate a secret once with `openssl rand -hex 32`, put it in `BETTER_AUTH_SECRET`, and preserve it across restarts. Never commit it. Better Auth creates/migrates its own tables at startup.

### Upgrading the earlier prototype

The workspace had no existing user database when this replacement was made. If you ran the previous version elsewhere, back up its data first: its custom password/session/key tables are deliberately not imported or accepted. Startup detects that legacy schema and stops instead of silently losing data. Use a fresh volume/data directory for this version; migrating populated legacy accounts requires an explicit account-reset and resource migration.

## Docker

Requires Docker Compose. Copy `.env.example` to `.env`, set real domains and `BETTER_AUTH_SECRET`, then:

```sh
docker compose up -d --build
docker compose logs -f relay
```

Create your administrator account before opening registration to other people. The first account becomes administrator. Data lives in the `relay-data` volume; preserve it across upgrades and back up both the SQLite database and `files/` directory. Do not use `docker compose down -v` unless deleting all data is intended.

## Proxmox LXC (native Node.js, no Docker required)

### One-command Proxmox host installer

Run this as **root in your Proxmox host shell**, after these installer files have been pushed to the repository's `master` branch:

```bash
curl -fsSL https://raw.githubusercontent.com/jsserve-org/agentFilesAndTunnels/master/deploy/proxmox-install.sh -o /tmp/relay-install.sh && bash /tmp/relay-install.sh
```

The installer asks for your panel domain and wildcard base, selects compatible storage (or asks when there are multiple choices), and creates a new **unprivileged Debian 12 LXC**. Defaults: next available container ID, `vmbr0`, DHCP, 2 CPU cores, 2 GiB RAM, and 16 GiB disk. It installs pinned Node.js 22.23.3 and pnpm 10.28.2, builds the app from the repository, generates the auth secret, and starts the systemd service. Then it asks for an administrator email and a hidden password. Better Auth creates that account; public registration stays closed until you enable it in the panel. Credentials travel over stdin and are not written into command arguments.

For a static address and specific storage, override settings in the same line:

```bash
curl -fsSL https://raw.githubusercontent.com/jsserve-org/agentFilesAndTunnels/master/deploy/proxmox-install.sh -o /tmp/relay-install.sh && PUBLIC_ORIGIN=https://relay.example.com BASE_DOMAIN=tunnel.example.com TCP_PUBLIC_HOST=ports.example.com STORAGE=local-lvm TEMPLATE_STORAGE=local CTID=120 IP_ADDRESS=192.168.1.90/24 GATEWAY=192.168.1.1 bash /tmp/relay-install.sh
```

For your two-storage setup, put the OS, Node.js and application on `local-lvm`, and user data on `fourtb`:

```bash
curl -fsSL https://raw.githubusercontent.com/jsserve-org/agentFilesAndTunnels/master/deploy/proxmox-install.sh -o /tmp/relay-install.sh && STORAGE=local-lvm DATA_STORAGE=fourtb DATA_DISK_GB=100 bash /tmp/relay-install.sh
```

This creates a 16 GiB root disk on `local-lvm` and a separate 100 GiB data volume on `fourtb`. Change `DATA_DISK_GB` to the capacity you want to allocate; it does not consume the entire four-terabyte pool. The data volume is mounted at `/var/lib/relay` and holds uploaded files, accounts, API key records, and tunnel reservations. The system disk holds `/opt/relay`, Node.js, and `/etc/relay.env`. Include both volumes when backing up so the auth secret and database are preserved together. The data mount has `backup=1` enabled. Both selected storage pools must support Proxmox **Container** (`rootdir`) content; the installer checks this before creating a guest. Template storage is selected separately.

`DATA_STORAGE` defaults to the system storage if omitted; the installer still creates a separate data volume (100 GiB by default). These settings apply to new containers only. They do not move data from an existing installation. You can expand the data volume later from Proxmox or with `pct resize CTID mp0 +100G`.

Run `bash /tmp/relay-install.sh --help` for all options, including bridge, VLAN, CPU/RAM/disk, existing template, TCP range, and source revision. `SOURCE_REF` defaults to `master`; set a commit SHA for a fixed app revision. The download URL for the installer itself can also use that SHA. Existing containers are never overwritten. Failed installations preserve the new LXC for diagnosis rather than deleting its disk.

For an installation without a controlling terminal, supply all required settings. The service starts with registration closed; finish account setup using `pct enter CTID`, then `/opt/relay/deploy/bootstrap-admin.sh`. That command also lets you retry if the initial password was invalid. The utility refuses to create a second administrator.

The Proxmox host needs Internet access and a storage pool supporting container disks; template storage must support `vztmpl`. Keep a stable LXC address (static configuration or a DHCP reservation). DNS, Nginx Proxy Manager, OpenWrt forwarding and any existing Proxmox firewall rules still need the configuration below. The installer does not change those systems.

### Manual installation inside an existing LXC

If the earlier Bun installation stopped at `Illegal instruction` or `bun: command not found`, keep the existing LXC and both disks. Intel Core 2 CPUs such as the Q8400 lack the SSE4.2 required by Bun's baseline build. This version runs on Node.js instead; Better Auth and the SQLite database format are unchanged.

From the Proxmox host run `pct enter 111` (replace the ID if needed), then inside the LXC:

```bash
curl -fsSL https://raw.githubusercontent.com/jsserve-org/agentFilesAndTunnels/master/deploy/lxc-upgrade-node.sh -o /tmp/relay-upgrade-node.sh && bash /tmp/relay-upgrade-node.sh
```

This installs the pinned Node runtime with a SHA-256 archive check, downloads the updated app, and builds it before stopping the existing service. The previous application directory is retained as `/opt/relay-before-node-TIMESTAMP-PID`. It preserves `/var/lib/relay` and `/etc/relay.env`, including the auth secret. If no configuration exists, it prompts for the domains. After it succeeds, run `/opt/relay/deploy/bootstrap-admin.sh` to create the first administrator if needed. The script requires the existing data mount and `/opt/relay` directory.

If this Node installation is interrupted later, resume inside the LXC with `bash /opt/relay/deploy/lxc-finish.sh` after correcting the reported failure. If Relay fails with `226/NAMESPACE` inside LXC, the finish script retries with a service-only override disabling `PrivateTmp`, `ProtectSystem`, `ProtectHome`, and `ReadWritePaths`. The service still runs as `relay` with `NoNewPrivileges` and container isolation. This reduces systemd filesystem isolation to accommodate hosts that deny additional mount namespaces. Other failures are reported in the service journal; inspect `journalctl -u relay -b --no-pager -l` for the complete error.

Use a Debian/Ubuntu unprivileged LXC with a static LAN address, outbound Internet access, and a persistent disk sized for uploads. Install Node.js 22 and pnpm, or use `bash deploy/install-node.sh` after copying the project. Copy this project into `/opt/relay`, then inside the LXC as root:

```sh
useradd --system --home /var/lib/relay --shell /usr/sbin/nologin relay
cd /opt/relay
pnpm install --frozen-lockfile
pnpm run build
cp .env.example /etc/relay.env
# Edit /etc/relay.env with your real domains and a generated BETTER_AUTH_SECRET.
chmod 600 /etc/relay.env
cp deploy/relay.service /etc/systemd/system/relay.service
systemctl daemon-reload
systemctl enable --now relay
journalctl -u relay -f
```

The service creates `/var/lib/relay`. Set `PORT=3000` in `/etc/relay.env` if needed. The bundled unit runs as an ordinary user and uses ports above 1023.

## DNS, Nginx Proxy Manager and OpenWrt

Example domains:

- Panel/API/MCP: `relay.example.com`
- Tunnel wildcard: `*.tunnel.example.com`
- Raw TCP public host: `ports.example.com` (or a public IPv4 address)

Point panel and wildcard DNS at your public IP. For dynamic public IPs, keep these records updated with your OpenWrt/DDNS provider. Point `ports.example.com` at whichever public IP forwards your TCP range.

In Nginx Proxy Manager create proxy hosts for `relay.example.com` and `*.tunnel.example.com`, both forwarding HTTP to the LXC address on port 3000. Enable WebSocket support, preserve the original Host header, and issue TLS certificates (wildcard certificates normally require a DNS challenge). Add this advanced configuration:

```nginx
client_max_body_size 101m;
proxy_read_timeout 120s;
proxy_send_timeout 120s;
proxy_buffering off;
```

Forward WAN TCP 80/443 to Nginx Proxy Manager. Forward WAN TCP 20000–20099 directly to the LXC (or Docker host) on the same ports. Docker publishes this range in `compose.yaml`. TCP tunnels allocate listeners from this range themselves; no Docker socket access or privileged container is needed. Keep `TCP_PORT_START`, `TCP_PORT_END`, Compose ports and OpenWrt forwarding in agreement.

Only TCP is implemented. HTTP tunnels terminate public TLS at Nginx Proxy Manager and speak HTTP to the laptop's loopback service. To demonstrate a local HTTPS server with its own TLS, create a **TCP** tunnel to its HTTPS port; its certificate must match the hostname the browser uses. TCP uses the returned `host:port`, not wildcard HTTP routing. Valid port numbers end at 65535.

## Laptop / agent

Create an agent in the panel and use **Copy agent prompt**. The served CLI is a single bundled file requiring Node.js 22 or later:

```sh
curl --fail --output relay.cjs https://relay.example.com/cli.cjs
export RELAY_SERVER=https://relay.example.com
export RELAY_AGENT=AGENT_ID
export RELAY_TOKEN=AGENT_TOKEN
node relay.cjs connect
```

Leave `connect` running. In another shell with the same environment:

```sh
node relay.cjs create http --local-port 3000
node relay.cjs create tcp --local-port 8443
node relay.cjs list
node relay.cjs upload ./demo.zip
node relay.cjs stop TUNNEL_ID
```

The CLI also accepts `--server`, `--agent`, `--token`, and `--local-host`. Targets are limited to laptop loopback (`127.0.0.1`, `localhost`, `::1`). A connection lost through sleep or an IP change reconnects automatically with backoff. A second connection for the same agent replaces the first. Use distinct agent IDs for separate laptops. Replacing a token disconnects the old connection but preserves all tunnel IDs.

## REST API

Use `Authorization: Bearer ACCOUNT_API_KEY` or an agent token. Agent tokens cannot manage credentials or registration and can manage only their own tunnels; they can upload/list the account's files. Login sessions use an HttpOnly cookie. Account keys can manage all resources in that account.

| Method     | Path                      | Body / behavior                                                                             |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| POST       | `/api/auth/sign-up/email` | `{ "name": "Your name", "email": "you@example.com", "password": "at-least-12-characters" }` |
| POST       | `/api/auth/sign-in/email` | Same fields; returns session cookie                                                         |
| POST       | `/api/auth/sign-out`      | Clear session                                                                               |
| GET        | `/api/me`                 | Current account and admin status                                                            |
| GET        | `/api/config`             | Registration and file limits                                                                |
| GET / POST | `/api/keys`               | List / create with `{ "label": "automation" }`; token shown once                            |
| DELETE     | `/api/keys/:id`           | Revoke account key                                                                          |
| GET / POST | `/api/agents`             | List / create with `{ "label": "laptop" }`; token shown once                                |
| POST       | `/api/agents/:id/rotate`  | Replace token, preserving reservations                                                      |
| GET / POST | `/api/tunnels`            | List / create with `agent_id`, `kind: http or tcp`, `local_port`, optional `local_host`     |
| DELETE     | `/api/tunnels/:id`        | Stop permanently and release TCP port                                                       |
| GET / POST | `/api/files`              | List / upload multipart field `file`, or raw bytes with `X-File-Name`                       |
| GET        | `/f/:id`                  | Public file download until expiry                                                           |
| PATCH      | `/api/admin/settings`     | Admin only: `{ "registration_enabled": false }`                                             |
| GET        | `/health`                 | Liveness                                                                                    |

## MCP

Configure a remote HTTP MCP client with URL `https://relay.example.com/mcp` and an Authorization Bearer header. The endpoint supports stateless Streamable HTTP JSON responses, protocol version `2025-03-26`. It provides `list_tunnels`, `create_tunnel`, `stop_tunnel`, `list_files`, and `upload_file` (base64 content). The agent CLI connection still has to run on the laptop to serve traffic. Use the REST multipart upload or CLI for large files.

```json
{
  "mcpServers": {
    "relay": {
      "url": "https://relay.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY_OR_AGENT_TOKEN" }
    }
  }
}
```

Client configuration syntax varies. Tokens are hashed in the database and must not be committed in client configuration files.

## Configuration and current limits

| Variable                          | Default                                           |
| --------------------------------- | ------------------------------------------------- |
| `BETTER_AUTH_SECRET`              | Required: random secret of at least 32 characters |
| `PORT`                            | `3000`                                            |
| `PUBLIC_ORIGIN`                   | `http://localhost:3000`                           |
| `BASE_DOMAIN`                     | Hostname of public origin                         |
| `TCP_PUBLIC_HOST`                 | Base domain                                       |
| `TCP_BIND_ADDRESS`                | `0.0.0.0`                                         |
| `TCP_PORT_START` / `TCP_PORT_END` | `20000` / `20099`                                 |
| `DATA_DIR`                        | `./data`                                          |
| `FILE_RETENTION_HOURS`            | `72` (values below 72 are clamped)                |
| `MAX_FILE_BYTES`                  | 100 MiB                                           |
| `MAX_USER_STORAGE_BYTES`          | 1 GiB                                             |

Better Auth limits email sign-in to 10 attempts per minute and signup to 5; key verification is limited to 600 requests per minute per key. The Node adapter sets the client IP header from the connection peer, so callers cannot spoof it. Behind Nginx Proxy Manager, authentication attempts share the proxy address rate-limit bucket.

HTTP tunnels buffer requests and responses, limited to 16 MiB and a 30-second response deadline. For WebSockets, streaming/SSE, larger payloads or opaque TLS, use a raw TCP tunnel. TCP streams use acknowledgements for backpressure and close after five idle minutes. Each account has up to 100 active reservations; each agent has up to 128 TCP connections and 64 simultaneous HTTP requests. This deployment uses one server process and one shared persistent volume; it does not provide replication or automatic backups. Account recovery/email verification are not implemented.

## Development and validation

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm test
pnpm start
```

Integration tests start isolated production server processes on temporary ports, exercise the real bundled CLI, and clean up their own processes and data.

## Panel upgrade and agent authorization

Update an existing LXC from inside the container as root:

```bash
curl -fsSL https://raw.githubusercontent.com/jsserve-org/agentFilesAndTunnels/master/deploy/lxc-update.sh -o /tmp/relay-update.sh && bash /tmp/relay-update.sh
```

The update preserves /etc/relay.env and /var/lib/relay and builds before stopping the service. Existing users must log in again because panel cookies now use a host-only cookie name. HTTPS sessions use __Host-relay.session_token, preventing hosted wildcard sites from setting the panel cookie.

Agents install with `curl -fsSL https://relay.example.com/install.sh | bash`, then run `~/.local/bin/relay login --server https://relay.example.com`. Better Auth device authorization prints a URL/code for browser approval. The installer can download a verified Node22.23.3 runtime, including for older x64 CPUs. Credentials are saved privately (0600) and scoped to the approved agent. Login again when the Better Auth session expires. Agent deletion/revocation invalidates the OAuth session and active connection. Download /AGENTS.md from the Agents page for the full workflow. Manual agent credentials and account API keys remain supported.

## Direct TCP hostname with multiple WANs

Use one selected WAN for direct-tunnel.2oo.dev. Create a DNS A record pointing to that WAN's public IPv4 address (keep it updated when the address changes). Forward the configured TCP range, normally 20000–20099, on that WAN directly to the LXC's stable LAN address on the same ports. This hostname bypasses Nginx Proxy Manager; use DNS-only mode with providers that offer an HTTP proxy. Do not publish an AAAA record unless IPv6 routing is configured too.

In the panel, open **Admin → Settings → Direct TCP forwarding**, enter direct-tunnel.2oo.dev, and save. Administrators can change it later; it is persisted in the database and overrides TCP_PUBLIC_HOST. GET/PATCH /api/admin/settings expose this setting as tcp_public_host. Existing reservations keep their ports and immediately advertise the new hostname. DNS and OpenWrt rules are managed separately. Changing the listening port range requires matching server environment, Docker port mappings (when using Docker), and router rules, then a restart.

## Static hosting

Upload a ZIP through Sites or `relay deploy ./site.zip --name demo --visibility login`. Put index.html at the ZIP root. Sites persist until deleted and use storage quota alongside files. Extraction rejects unsafe paths and enforces 100MB/2000-entry limits. The URL is s-ID.BASE_DOMAIN, served by the existing wildcard Nginx Proxy Manager host.

Public sites need no login. Protected sites accept any registered Relay account, including users other than the owner. Users approve a short-lived, site-bound Better Auth login handoff; the platform session stays in a host-only cookie. GET /__relay/me exposes only the authenticated user's id, name and email; POST /__relay/logout signs out of that site. Platform sessions expiring or being revoked also revoke site access. No executable apps are run.

REST: GET/POST /api/sites, GET/PATCH/DELETE /api/sites/:id, POST /api/sites/:id/login (browser session). Upload multipart file (ZIP), name and visibility (login/public). Administrators use GET /api/admin/resources and DELETE /api/admin/sites/:id to moderate. Other moderation collections are tunnels, files, agents and keys. Create users with POST /api/admin/users; PATCH /api/admin/users/:id/limits accepts storage_bytes and tunnels.

MCP tools: list_tunnels, create_tunnel, stop_tunnel, list_files, upload_file, list_sites, deploy_site, delete_site. Discover schemas with tools/list. Deploy accepts a ZIP as base64. CLI commands: deploy, sites, delete-site.
