# Relay desk agent instructions

Relay desk exposes loopback services through persistent HTTP URLs or public TCP ports, and stores shared files for at least 72 hours. Use only services and files the user has asked you to publish.

## Install and authorize

Read the server origin from the user or from the page that linked here. Replace `https://relay.example.com` below with that origin.

```sh
curl -fsSL https://relay.example.com/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
relayoo login --server https://relay.example.com
```

The command is installed as `~/.local/bin/relayoo`; the installer adds its directory to bash/zsh startup files. A piped installer cannot update its parent shell, so run the export above for the current shell.

The installer uses Node.js 22 or later if available, otherwise it downloads a checksum-verified Node runtime for Linux/macOS x64/arm64. curl and bash are required. Alternatively download `/cli.cjs` and run `node relay.cjs` without installing a wrapper.

The login command uses Better Auth's OAuth device authorization flow. Give the user the approval URL and code printed by the CLI. Wait for the user to approve it in the panel. Never approve a request on the user's behalf. The authorized credential is limited to this agent and stored in `~/.config/relay/credentials.json` with mode 0600. Use `--config PATH` or `RELAY_CONFIG` for separate installations. Sessions expire; run login again if authentication expires. Administrators can revoke the agent immediately.

Manual credentials remain supported when supplied by the user: `RELAY_SERVER`, `RELAY_AGENT`, and `RELAY_TOKEN`. Never commit these, print them in public output, place them in tunnel responses, or include them in shareable URLs. An account API key has broader access than an agent credential.

## Publish a service

```sh
relayoo connect
# Keep the connection process running while the service is needed.
relayoo list
relayoo create http --local-port 3000
# For raw TCP or a local HTTPS server:
relayoo create tcp --local-port 443
relayoo stop TUNNEL_ID
```

Only loopback targets are accepted. List existing tunnels before creating duplicates. Return the assigned URL or address to the user. A disconnected laptop displays an offline response at its HTTP URL; reconnecting restores access to the same reservation. Stop a tunnel when the user asks to close it. Valid ports are 1–65535.

## Share files

```sh
relayoo upload ./report.pdf
```

Return the download link and expiry time. Anyone with the link can download until expiry. Do not upload secrets unless the user explicitly asks to share them. Storage and tunnel allowances are enforced by the server; report quota errors to the user rather than creating another account or agent to bypass them.

## Host a static site

Create a ZIP with index.html at its root. Hosting is persistent until you or an administrator deletes the site; it shares your storage allowance.

```sh
relayoo deploy ./site.zip --name demo --visibility login
relayoo sites
relayoo delete-site SITE_ID
```

Use --visibility public only when the user asks for public access. Login protection accepts any registered platform user through Better Auth. Sites can read the signed-in user's id, name and email from GET /__relay/me; POST /__relay/logout signs out of that site only. Never put credentials into the ZIP.

## REST and MCP

Use `Authorization: Bearer TOKEN`. The approved OAuth token is in the private credential file; do not display it. The agent's connection must be running for tunnels created through either interface.

REST: `GET /api/tunnels`, `POST /api/tunnels` with `{ "agent_id": "ID", "kind": "http", "local_host": "127.0.0.1", "local_port": 3000 }`, `DELETE /api/tunnels/ID`, `POST /api/files` with a multipart `file` field, `GET /api/usage`.

MCP: POST `/mcp` using JSON-RPC with `initialize`, `tools/list`, or `tools/call`. Available tools include `create_tunnel`, `list_tunnels`, `stop_tunnel`, `upload_file`, `list_files`, `list_sites`, `deploy_site`, and `delete_site`. Discover tool schemas using `tools/list` before calling. Use your agent credential, which cannot create account API keys, change account settings, or manage other agents' tunnels.

## Before finishing

Tell the user which connection process needs to remain running, the public addresses created, file expiry times, and how to stop any tunnel. Do not close a tunnel or the connection process while the user is still using the demo.

Site uploads accept a ZIP root containing index.html or one enclosing website folder. Finder metadata (__MACOSX, .DS_Store and AppleDouble files) is ignored, and leading ./ paths are normalized. Hidden configuration files and traversal paths remain rejected.
