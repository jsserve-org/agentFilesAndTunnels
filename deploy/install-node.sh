#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8 LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive
[[ $EUID == 0 ]] || { echo 'Run as root inside the LXC.' >&2; exit 1; }
case $(uname -m) in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo 'Unsupported Node architecture.' >&2; exit 1 ;;
esac
node_version=22.23.3
apt-get -o Acquire::Retries=5 update
apt-get -o Acquire::Retries=5 install -y ca-certificates curl xz-utils
if [[ ! -x /opt/relay-node/bin/node ]] || [[ $(/opt/relay-node/bin/node --version) != "v$node_version" ]]; then
  workdir=$(mktemp -d)
  trap 'rm -rf -- "$workdir"' EXIT
  archive="node-v$node_version-linux-$node_arch.tar.xz"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$node_version/$archive" -o "$workdir/$archive"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$workdir/SHASUMS256.txt"
  (cd "$workdir"; grep -F "  $archive" SHASUMS256.txt | sha256sum --check --strict -)
  install -d /opt/relay-node
  tar -xJf "$workdir/$archive" -C /opt/relay-node --strip-components=1 --no-same-owner
fi
ln -sf /opt/relay-node/bin/node /usr/local/bin/node
# Verify that this runtime actually executes JavaScript before installing the app.
/usr/local/bin/node -e 'console.log("Node runtime ready:",process.version)'
ln -sf /opt/relay-node/bin/corepack /usr/local/bin/corepack
corepack enable --install-directory /usr/local/bin pnpm
corepack prepare pnpm@10.28.2 --activate
pnpm --version
