#!/usr/bin/env bash
# Only Relay-owned paths: the volume may also contain host-owned lost+found.
set -Eeuo pipefail
chown relay:relay /var/lib/relay
for path in /var/lib/relay/app.sqlite /var/lib/relay/app.sqlite-wal /var/lib/relay/app.sqlite-shm; do
  if [[ -e $path ]]; then chown --no-dereference relay:relay "$path"; fi
done
if [[ -d /var/lib/relay/files ]]; then
  chown -R --no-dereference relay:relay /var/lib/relay/files
fi
