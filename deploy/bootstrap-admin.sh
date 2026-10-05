#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
bootstrap_args=()
if [[ -f /etc/relay.env ]]; then
  [[ $EUID == 0 ]] || { echo 'Run inside the LXC as root.' >&2; exit 1; }
  bootstrap_args+=(--env-file=/etc/relay.env)
elif [[ -f .env ]]; then
  bootstrap_args+=(--env-file=.env)
fi
if [[ $PWD == /opt/relay && $EUID == 0 ]]; then
  trap 'bash /opt/relay/deploy/data-ownership.sh' EXIT
fi
read -r -p 'Administrator email: ' admin_email </dev/tty
read -r -s -p 'Administrator password (12+ characters, hidden): ' admin_password </dev/tty
printf '\n'
read -r -s -p 'Confirm password (hidden): ' admin_confirm </dev/tty
printf '\n'
[[ $admin_password == "$admin_confirm" ]] || { echo 'Passwords do not match.' >&2; exit 1; }
printf '%s\n%s\n' "$admin_email" "$admin_password" | node "${bootstrap_args[@]}" dist/bootstrap-admin.mjs
unset admin_password admin_confirm
