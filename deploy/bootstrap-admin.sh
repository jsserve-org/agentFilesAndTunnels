#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run inside the LXC as root.' >&2; exit 1; }
cd /opt/relay
read -r -p 'Administrator email: ' admin_email </dev/tty
read -r -s -p 'Administrator password (12+ characters, hidden): ' admin_password </dev/tty
printf '\n'
read -r -s -p 'Confirm password (hidden): ' admin_confirm </dev/tty
printf '\n'
[[ $admin_password == "$admin_confirm" ]] || { echo 'Passwords do not match.' >&2; exit 1; }
printf '%s\n%s\n' "$admin_email" "$admin_password" | /usr/local/bin/bun --env-file=/etc/relay.env deploy/bootstrap-admin.ts
unset admin_password admin_confirm
