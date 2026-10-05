#!/usr/bin/env bash
# Install Relay CLI and, if needed, Node.js into the current user's home.
set -Eeuo pipefail
umask 022
relay_origin=${RELAY_SERVER:-'{{ORIGIN}}'}
relay_destination=${RELAY_INSTALL_DIR:-$HOME/.local/bin}
relay_runtime="$HOME/.local/share/relay/node"
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
if command -v node >/dev/null && node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'; then
  relay_node=$(command -v node)
elif [[ -x $relay_runtime/bin/node ]] && "$relay_runtime/bin/node" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'; then
  relay_node="$relay_runtime/bin/node"
else
  case $(uname -s) in Linux) relay_platform=linux;; Darwin) relay_platform=darwin;; *) echo 'This installer supports Linux and macOS.' >&2; exit 1;; esac
  case $(uname -m) in x86_64|amd64) relay_arch=x64;; aarch64|arm64) relay_arch=arm64;; *) echo 'This installer supports x64 and arm64 CPUs.' >&2; exit 1;; esac
  relay_version=22.23.3
  relay_archive="node-v$relay_version-$relay_platform-$relay_arch.tar.gz"
  relay_workdir=$(mktemp -d)
  trap 'rm -rf -- "$relay_workdir"' EXIT
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$relay_version/$relay_archive" -o "$relay_workdir/$relay_archive"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$relay_version/SHASUMS256.txt" -o "$relay_workdir/SHASUMS256.txt"
  relay_expected=$(awk -v file="$relay_archive" '$2==file {print $1}' "$relay_workdir/SHASUMS256.txt")
  if command -v sha256sum >/dev/null; then
    relay_actual=$(sha256sum "$relay_workdir/$relay_archive" | awk '{print $1}')
  elif command -v shasum >/dev/null; then
    relay_actual=$(shasum -a 256 "$relay_workdir/$relay_archive" | awk '{print $1}')
  else
    echo 'sha256sum or shasum is required to verify Node.js.' >&2; exit 1
  fi
  [[ -n $relay_expected && $relay_actual == "$relay_expected" ]] || { echo 'Node.js archive checksum failed.' >&2; exit 1; }
  mkdir "$relay_workdir/node"
  tar -xzf "$relay_workdir/$relay_archive" -C "$relay_workdir/node" --strip-components=1
  "$relay_workdir/node/bin/node" --version
  mkdir -p "$relay_runtime"
  cp -R "$relay_workdir/node/." "$relay_runtime/"
  relay_node="$relay_runtime/bin/node"
  rm -rf -- "$relay_workdir"
  trap - EXIT
fi
mkdir -p "$relay_destination"
relay_temp=$(mktemp "$relay_destination/.relay.XXXXXX")
trap 'rm -f -- "$relay_temp"' EXIT
curl -fsSL --retry 3 "${relay_origin%/}/cli.cjs" -o "$relay_temp"
mv "$relay_temp" "$relay_destination/relay.cjs"
chmod 600 "$relay_destination/relay.cjs"
{
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\nset -euo pipefail\nexec %q "$(dirname -- "${BASH_SOURCE[0]}")/relay.cjs" "$@"\n' "$relay_node"
} > "$relay_destination/relayoo"
chmod 755 "$relay_destination/relayoo"
# A piped installer cannot change its parent shell's environment. Configure future
# bash/zsh shells and print the command to activate the path in the current one.
# Keep $PATH literal so the startup file expands it when the shell starts.
# shellcheck disable=SC2016
relay_path_line=$(printf 'export PATH=%q:"$PATH"' "$relay_destination")
for relay_profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zprofile"; do
  touch "$relay_profile"
  if ! grep -Fqx -- "$relay_path_line" "$relay_profile"; then
    printf '\n# Relay CLI\n%s\n' "$relay_path_line" >> "$relay_profile"
  fi
done
if [[ -f $HOME/.bash_profile ]] && ! grep -Fqx -- "$relay_path_line" "$HOME/.bash_profile"; then
  printf '\n# Relay CLI\n%s\n' "$relay_path_line" >> "$HOME/.bash_profile"
fi
printf '\nInstalled %s/relayoo\nAdded the install directory to your bash/zsh PATH.\nFor this shell, run:\n  %s\nAuthorize this agent:\n  relayoo login --server %s\nThen connect:\n  relayoo connect\n' "$relay_destination" "$relay_path_line" "$relay_origin"
