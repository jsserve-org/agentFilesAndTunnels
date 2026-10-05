#!/usr/bin/env bash
# Finish an interrupted Relay LXC installation without recreating its volumes.
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8 LC_ALL=C.UTF-8
[[ $EUID == 0 ]] || { echo 'Run inside the Relay LXC as root.' >&2; exit 1; }
cd /opt/relay
mountpoint -q /var/lib/relay || { echo 'Missing data mount at /var/lib/relay; stopping.' >&2; exit 1; }
[[ -x /usr/local/bin/node ]] || { echo 'Node.js is missing at /usr/local/bin/node.' >&2; exit 1; }
/usr/local/bin/node --version
ask() {
  local variable=$1 prompt=$2 value
  [[ -z ${!variable:-} ]] || return 0
  read -r -p "$prompt: " value </dev/tty
  [[ -n $value ]] || { echo "$variable is required." >&2; exit 1; }
  printf -v "$variable" '%s' "$value"
}
# Preserve existing configuration, including the auth secret, on every retry.
if [[ ! -f /etc/relay.env ]]; then
  ask PUBLIC_ORIGIN 'Panel origin (https://relay.example.com)'
  ask BASE_DOMAIN 'Wildcard base (tunnel.example.com, without *.)'
  PUBLIC_ORIGIN=${PUBLIC_ORIGIN%/}
  [[ $PUBLIC_ORIGIN =~ ^https://[a-zA-Z0-9.-]+$ ]] || { echo 'Invalid HTTPS panel origin.' >&2; exit 1; }
  TCP_PUBLIC_HOST=${TCP_PUBLIC_HOST:-${PUBLIC_ORIGIN#https://}}
  for value in "$BASE_DOMAIN" "$TCP_PUBLIC_HOST"; do
    [[ $value =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid hostname.' >&2; exit 1; }
  done
  TCP_PORT_START=${TCP_PORT_START:-20000}; TCP_PORT_END=${TCP_PORT_END:-20099}
  for value in "$TCP_PORT_START" "$TCP_PORT_END"; do
    if ! [[ $value =~ ^[1-9][0-9]{3,4}$ ]] || ! ((value >= 1024 && value <= 65535)); then
      echo 'Invalid TCP port.' >&2; exit 1
    fi
  done
  ((TCP_PORT_START <= TCP_PORT_END)) || { echo 'Invalid TCP port range.' >&2; exit 1; }
  umask 077
  auth_secret=$(/usr/local/bin/node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
  [[ $auth_secret =~ ^[a-f0-9]{64}$ ]] || { echo 'Auth secret generation failed.' >&2; exit 1; }
  config_tmp=$(mktemp /etc/relay.env.XXXXXX)
  trap 'rm -f -- "$config_tmp"' EXIT
  {
    printf 'PUBLIC_ORIGIN=%s\nBASE_DOMAIN=%s\nTCP_PUBLIC_HOST=%s\n' "$PUBLIC_ORIGIN" "$BASE_DOMAIN" "$TCP_PUBLIC_HOST"
    printf 'TCP_PORT_START=%s\nTCP_PORT_END=%s\nPORT=3000\n' "$TCP_PORT_START" "$TCP_PORT_END"
    printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret"
  } > "$config_tmp"
  mv "$config_tmp" /etc/relay.env
  unset auth_secret
  trap - EXIT
fi
umask 022
CI=true pnpm install --frozen-lockfile
pnpm run build
# Build scripts inherit the complete PATH above.
id relay >/dev/null 2>&1 || useradd --system --home /var/lib/relay --shell /usr/sbin/nologin relay
DATA_DIR=/var/lib/relay /usr/local/bin/node --import tsx --input-type=module -e 'import {db} from "./src/db.ts"; if(!db.prepare("SELECT value FROM settings WHERE key=?").get("admin_user_id"))db.prepare("UPDATE settings SET value=? WHERE key=?").run("false","registration_enabled");'
bash deploy/data-ownership.sh
install -m 0644 deploy/relay.service /etc/systemd/system/relay.service
systemctl daemon-reload
systemctl enable relay
systemctl restart relay || echo 'Relay did not start immediately; checking health and service status.' >&2
namespace_retry=false
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent http://127.0.0.1:3000/health >/dev/null; then
    printf '\nRelay is running. For initial administrator setup, run /opt/relay/deploy/bootstrap-admin.sh inside the LXC.\n'
    exit 0
  fi
  if [[ $namespace_retry == false ]] && [[ $(systemctl show relay -p ExecMainStatus --value) == 226 ]] && [[ $(systemd-detect-virt --container || true) == lxc ]]; then
    # Some unprivileged LXC hosts deny systemd's additional mount namespace.
    # Keep the service UID, NoNewPrivileges and LXC isolation; only remove
    # the mount-namespace-dependent settings for this service.
    echo 'LXC denied the Relay service mount namespace (226/NAMESPACE). Applying a service-only compatibility override.'
    install -d -m 0755 /etc/systemd/system/relay.service.d
    cat > /etc/systemd/system/relay.service.d/lxc-namespace.conf <<'UNIT'
[Service]
PrivateTmp=false
ProtectSystem=false
ProtectHome=false
ReadWritePaths=
UNIT
    systemctl daemon-reload
    systemctl reset-failed relay
    systemctl restart relay
    namespace_retry=true
  fi
  sleep 1
done
journalctl -u relay -n 40 --no-pager
exit 1
