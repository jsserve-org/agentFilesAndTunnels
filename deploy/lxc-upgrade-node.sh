#!/usr/bin/env bash
# Resume a failed Bun installation, preserving the LXC and all user data.
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8 LC_ALL=C.UTF-8
[[ $EUID == 0 ]] || { echo 'Run inside the Relay LXC as root.' >&2; exit 1; }
mountpoint -q /var/lib/relay || { echo 'Missing data mount at /var/lib/relay.' >&2; exit 1; }
[[ -d /opt/relay ]] || { echo 'Existing /opt/relay installation not found.' >&2; exit 1; }
source_ref=${SOURCE_REF:-master}
[[ $source_ref =~ ^[a-zA-Z0-9._/-]+$ ]] || { echo 'Invalid SOURCE_REF.' >&2; exit 1; }
workdir=$(mktemp -d /opt/relay-upgrade.XXXXXX)
trap 'rm -rf -- "$workdir"' EXIT
curl -fsSL --retry 3 "https://github.com/jsserve-org/agentFilesAndTunnels/archive/$source_ref.tar.gz" -o "$workdir/source.tar.gz"
mkdir "$workdir/app"
tar -xzf "$workdir/source.tar.gz" -C "$workdir/app" --strip-components=1 --no-same-owner
for file in pnpm-lock.yaml package.json deploy/lxc-finish.sh deploy/install-node.sh; do
  [[ -f $workdir/app/$file ]] || { echo "Missing $file in source archive." >&2; exit 1; }
done
bash "$workdir/app/deploy/install-node.sh"
# Build before stopping or replacing the existing service.
(cd "$workdir/app"; CI=true pnpm install --frozen-lockfile; pnpm run build)
backup="/opt/relay-before-node-$(date +%Y%m%d-%H%M%S)-$$"
if systemctl cat relay.service >/dev/null 2>&1; then systemctl stop relay; fi
mv /opt/relay "$backup"
mv "$workdir/app" /opt/relay
printf 'Previous application retained at %s. Data and /etc/relay.env are unchanged.\n' "$backup"
bash /opt/relay/deploy/lxc-finish.sh
printf '\nFor initial admin setup, run /opt/relay/deploy/bootstrap-admin.sh\n'
