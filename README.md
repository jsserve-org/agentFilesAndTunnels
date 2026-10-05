# Relay desk

A Bun + TypeScript service with a browser panel, laptop CLI, public REST API and HTTP MCP endpoint. SQLite stores accounts and permanent tunnel reservations; uploaded files live on the same persistent volume. This is a single-server deployment.

## What it does

- Register, log in, create/revoke account API keys and create/replace agent tokens.
- Turn registration on or off immediately from the first user's administrator panel.
- Assign random permanent HTTP subdomains. The laptop connects outbound, so a changed laptop IP does not change the public link. Reconnects work after 24 hours and beyond. Reservations persist until explicitly stopped.
- Show an offline page while a laptop is disconnected. Requests are not queued or replayed.
- Forward raw TCP ports, including HTTPS bytes, through the same outbound connection.
- Stop a tunnel from the laptop CLI or panel, including existing TCP connections.
- Store files for at least 72 hours; return an unguessable public download link. Anyone holding that link can download until expiry. Cleanup runs hourly.
- Expose tunnel creation/list/stop and file upload/list as MCP tools at `/mcp`.

## Authentication

Authentication is provided by [Better Auth](https://www.better-auth.com/) and its official `@better-auth/api-key` plugin. Better Auth owns password hashing, credential validation, signed session cookies, session expiry/revocation, origin checks on auth endpoints, and database-backed auth rate limits. Both account API keys and agent tokens are generated, hashed, verified and revoked by the plugin. The application only maps verified identities to owned tunnels/files and administrator permissions.

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

## Proxmox LXC (native Bun, no Docker required)

Use a Debian/Ubuntu unprivileged LXC with a static LAN address, outbound Internet access, and a persistent disk sized for uploads. Install Bun 1.3.6 or newer and place its executable at `/usr/local/bin/bun`. Copy this project into `/opt/relay`, then inside the LXC as root:

```sh
useradd --system --home /var/lib/relay --shell /usr/sbin/nologin relay
cd /opt/relay
bun install --frozen-lockfile
bun run build
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

Create an agent in the panel and use **Copy agent prompt**. The served CLI is a single bundled file:

```sh
curl --fail --output relay.js https://relay.example.com/cli.js
export RELAY_SERVER=https://relay.example.com
export RELAY_AGENT=AGENT_ID
export RELAY_TOKEN=AGENT_TOKEN
bun relay.js connect
```

Leave `connect` running. In another shell with the same environment:

```sh
bun relay.js create http --local-port 3000
bun relay.js create tcp --local-port 8443
bun relay.js list
bun relay.js upload ./demo.zip
bun relay.js stop TUNNEL_ID
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

Better Auth limits email sign-in to 10 attempts per minute and signup to 5; key verification is limited to 600 requests per minute per key. Behind Nginx Proxy Manager, restrict direct access to port 3000 and ensure the proxy overwrites client IP forwarding headers.

HTTP tunnels buffer requests and responses, limited to 16 MiB and a 30-second response deadline. For WebSockets, streaming/SSE, larger payloads or opaque TLS, use a raw TCP tunnel. TCP streams use acknowledgements for backpressure and close after five idle minutes. Each account has up to 100 active reservations; each agent has up to 128 TCP connections and 64 simultaneous HTTP requests. This deployment uses one server process and one shared persistent volume; it does not provide replication or automatic backups. Account recovery/email verification are not implemented.

## Development and validation

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun test
bun start
```

Integration tests start isolated production server processes on temporary ports, exercise the real bundled CLI, and clean up their own processes and data.
