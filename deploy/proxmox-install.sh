#!/usr/bin/env bash
# Run on a Proxmox VE host as root. Never modifies an existing guest.
set -Eeuo pipefail

usage() {
  cat <<'HELP'
Relay desk Proxmox LXC installer

Run as root on the Proxmox host. Missing domains and storage are prompted on /dev/tty.
Environment options:
  PUBLIC_ORIGIN       Required HTTPS panel origin (https://relay.example.com)
  BASE_DOMAIN         Required wildcard base (tunnel.example.com; omit *.)
  TCP_PUBLIC_HOST     TCP hostname or IPv4 address (defaults to panel hostname)
  CTID                Next available ID by default
  STORAGE             System/app storage supporting rootdir (prompt/auto-select)
  DATA_STORAGE        Data volume storage supporting rootdir (defaults to STORAGE)
  DATA_DISK_GB        Data volume size in GiB (default 100)
  TEMPLATE_STORAGE    Active storage supporting vztmpl (prompt/auto-select)
  TEMPLATE            Existing storage:vztmpl/template.tar.zst (optional)
  BRIDGE              vmbr0
  IP_ADDRESS          dhcp, or IPv4 CIDR (e.g. 192.168.1.90/24)
  GATEWAY             Required with a static IPv4 CIDR
  VLAN_TAG            Optional VLAN tag
  CORES / MEMORY / DISK_GB   2 / 2048 MiB / 16 GiB
  TCP_PORT_START / TCP_PORT_END   20000 / 20099
  SOURCE_REF          master (or a release tag / commit SHA)
  SOURCE_URL          Override source archive URL; default GitHub repository
  CT_HOSTNAME            relay-desk

Creates a Debian 12 unprivileged container, installs Node.js 22 and a systemd
service, generates its auth secret, and prompts for the initial administrator.
It does not modify OpenWrt, DNS, Nginx Proxy Manager or Proxmox firewall rules.
HELP
}
if [[ ${1:-} == --help ]]; then usage; exit 0; fi
[[ $# == 0 ]] || { usage >&2; exit 1; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
has_tty() { ( : </dev/tty ) 2>/dev/null; }
[[ $EUID == 0 ]] || die 'Run this installer as root on your Proxmox host.'
for command in pct pveam pvesm pvesh curl tar ip; do command -v "$command" >/dev/null || die "Missing Proxmox prerequisite: $command"; done
[[ $(uname -m) == x86_64 ]] || die 'This installer currently supports x86_64 Proxmox hosts.'

ask() {
  local variable=$1 prompt=$2 value
  [[ -z ${!variable:-} ]] || return 0
  has_tty || die "Set $variable for noninteractive installation."
  read -r -p "$prompt: " value </dev/tty || die "Could not read $variable."
  [[ -n $value ]] || die "$variable is required."
  printf -v "$variable" '%s' "$value"
}
number() {
  if ! [[ $2 =~ ^[0-9]+$ ]] || ! ((10#$2 >= $3 && 10#$2 <= $4)); then die "$1 must be between $3 and $4."; fi
}
domain() { [[ $2 =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] && [[ $2 != *..* ]] || die "$1 must be a hostname or IPv4 address."; }
select_storage() {
  local variable=$1 content=$2 selected
  local -a available=()
  while IFS= read -r selected; do [[ -z $selected ]] || available+=("$selected"); done < <(pvesm status --content "$content" | awk 'NR>1 && $3=="active" {print $1}')
  ((${#available[@]})) || die "No active storage supports $content."
  if [[ -z ${!variable:-} ]]; then
    if ((${#available[@]} == 1)); then printf -v "$variable" '%s' "${available[0]}"
    else printf '%s options: %s\n' "$variable" "${available[*]}"; ask "$variable" "Choose $variable"; fi
  fi
  for selected in "${available[@]}"; do [[ $selected != "${!variable}" ]] || return 0; done
  die "${!variable} is not active storage supporting $content."
}
ask PUBLIC_ORIGIN 'Panel origin (https://relay.example.com)'
ask BASE_DOMAIN 'Wildcard base (tunnel.example.com, without *.)'
PUBLIC_ORIGIN=${PUBLIC_ORIGIN%/}
[[ $PUBLIC_ORIGIN =~ ^https://([a-zA-Z0-9.-]+)$ ]] || die 'PUBLIC_ORIGIN must be an HTTPS origin without a port or path.'
panel_host=${BASH_REMATCH[1]}
domain PUBLIC_ORIGIN "$panel_host"
domain BASE_DOMAIN "$BASE_DOMAIN"
TCP_PUBLIC_HOST=${TCP_PUBLIC_HOST:-$panel_host}; domain TCP_PUBLIC_HOST "$TCP_PUBLIC_HOST"
CTID=${CTID:-$(pvesh get /cluster/nextid)}
BRIDGE=${BRIDGE:-vmbr0}; IP_ADDRESS=${IP_ADDRESS:-dhcp}
CORES=${CORES:-2}; MEMORY=${MEMORY:-2048}; DISK_GB=${DISK_GB:-16}
DATA_DISK_GB=${DATA_DISK_GB:-100}
CT_HOSTNAME=${CT_HOSTNAME:-relay-desk}
TCP_PORT_START=${TCP_PORT_START:-20000}; TCP_PORT_END=${TCP_PORT_END:-20099}
number CTID "$CTID" 100 999999999
number CORES "$CORES" 1 128; number MEMORY "$MEMORY" 512 1048576; number DISK_GB "$DISK_GB" 4 65536
number DATA_DISK_GB "$DATA_DISK_GB" 1 65536
number TCP_PORT_START "$TCP_PORT_START" 1024 65535; number TCP_PORT_END "$TCP_PORT_END" "$TCP_PORT_START" 65535
domain CT_HOSTNAME "$CT_HOSTNAME"
[[ $BRIDGE =~ ^[a-zA-Z0-9_.-]+$ ]] || die 'Invalid bridge name.'
ip link show "$BRIDGE" >/dev/null || die "Bridge $BRIDGE does not exist."
[[ ! -e /etc/pve/lxc/$CTID.conf && ! -e /etc/pve/qemu-server/$CTID.conf ]] || die "Guest $CTID already exists."
net="name=eth0,bridge=$BRIDGE,ip=$IP_ADDRESS,type=veth"
if [[ $IP_ADDRESS != dhcp ]]; then
  [[ $IP_ADDRESS =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || die 'IP_ADDRESS must be dhcp or an IPv4 CIDR.'
  [[ ${GATEWAY:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'Set GATEWAY for static IPv4.'
  net+=",gw=$GATEWAY"
fi
if [[ -n ${VLAN_TAG:-} ]]; then number VLAN_TAG "$VLAN_TAG" 1 4094; net+=",tag=$VLAN_TAG"; fi
select_storage STORAGE rootdir
DATA_STORAGE=${DATA_STORAGE:-$STORAGE}
select_storage DATA_STORAGE rootdir
if [[ -z ${TEMPLATE:-} ]]; then
  select_storage TEMPLATE_STORAGE vztmpl
  pveam update
  template_name=$(pveam available --section system | awk '$2 ~ /^debian-12-standard_.*_amd64.tar/ {print $2}' | sort -V | tail -n 1)
  [[ -n $template_name ]] || die 'No Debian 12 template available. Set TEMPLATE to an existing Debian 12 volume.'
  pveam download "$TEMPLATE_STORAGE" "$template_name"
  TEMPLATE="$TEMPLATE_STORAGE:vztmpl/$template_name"
fi
pvesm path "$TEMPLATE" >/dev/null || die "Template $TEMPLATE is unavailable."
SOURCE_REF=${SOURCE_REF:-master}
[[ $SOURCE_REF =~ ^[a-zA-Z0-9._/-]+$ ]] || die 'Invalid SOURCE_REF.'
SOURCE_URL=${SOURCE_URL:-https://github.com/jsserve-org/agentFilesAndTunnels/archive/$SOURCE_REF.tar.gz}
[[ $SOURCE_URL == https://* ]] || die 'SOURCE_URL must use HTTPS.'
workdir=$(mktemp -d)
created=false
cleanup() {
  local status=$?
  rm -rf -- "$workdir"
  if ((status != 0)) && [[ $created == true ]]; then
    printf '\nInstallation failed. Container %s was preserved for diagnosis; no existing guest was removed.\nInspect it with: pct enter %s\n' "$CTID" "$CTID" >&2
  fi
}
trap cleanup EXIT
curl --fail --location --retry 3 --output "$workdir/source.tar.gz" "$SOURCE_URL"
tar -tzf "$workdir/source.tar.gz" > "$workdir/entries"
for file in package.json pnpm-lock.yaml src/server.ts deploy/relay.service deploy/lxc-finish.sh deploy/install-node.sh; do
  grep -Eq "^[^/]+/$file$" "$workdir/entries" || die "Source archive is missing $file."
done
printf 'Creating unprivileged LXC %s on %s: %s cores, %s MiB RAM, %s GiB disk, %s\n' "$CTID" "$STORAGE" "$CORES" "$MEMORY" "$DISK_GB" "$IP_ADDRESS"
printf 'User data: %s GiB on %s, mounted at /var/lib/relay (included in backups).\n' "$DATA_DISK_GB" "$DATA_STORAGE"
pct create "$CTID" "$TEMPLATE" --hostname "$CT_HOSTNAME" --unprivileged 1 --cores "$CORES" --memory "$MEMORY" --swap 512 --rootfs "$STORAGE:$DISK_GB" --mp0 "$DATA_STORAGE:$DATA_DISK_GB,mp=/var/lib/relay,backup=1" --net0 "$net" --onboot 1 --description 'Relay desk: agent tunnels and file uploads'
created=true
pct start "$CTID"
for ((attempt=0; attempt<60; attempt++)); do
  if pct exec "$CTID" -- /bin/true >/dev/null 2>&1; then break; fi
  sleep 1
done
pct push "$CTID" "$workdir/source.tar.gz" /root/relay-source.tar.gz --perms 0600
pct exec "$CTID" -- env PUBLIC_ORIGIN="$PUBLIC_ORIGIN" BASE_DOMAIN="$BASE_DOMAIN" TCP_PUBLIC_HOST="$TCP_PUBLIC_HOST" TCP_PORT_START="$TCP_PORT_START" TCP_PORT_END="$TCP_PORT_END" bash -s <<'GUEST'
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8 LC_ALL=C.UTF-8
mountpoint -q /var/lib/relay || { echo 'Data volume is not mounted; refusing to write user data to the system disk.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=5 update
apt-get -o Acquire::Retries=5 install -y ca-certificates curl unzip openssl
useradd --system --home /var/lib/relay --shell /usr/sbin/nologin relay
install -d /opt/relay /var/lib/relay
tar -xzf /root/relay-source.tar.gz -C /opt/relay --strip-components=1 --no-same-owner
rm /root/relay-source.tar.gz
bash /opt/relay/deploy/install-node.sh
bash /opt/relay/deploy/lxc-finish.sh
GUEST
printf '\nService installed. Registration is closed. Create an administrator with the local bootstrap utility.\n'
pct exec "$CTID" -- hostname -I
printf '\nTo bootstrap manually: pct enter %s, then run /opt/relay/deploy/bootstrap-admin.sh\n' "$CTID"
printf 'Then configure Nginx Proxy Manager for %s and *.%s to this LXC on port 3000.\n' "$panel_host" "$BASE_DOMAIN"
printf 'Forward TCP %s–%s from OpenWrt to this LXC.\n' "$TCP_PORT_START" "$TCP_PORT_END"
if has_tty; then
  read -r -p 'Administrator email: ' admin_email </dev/tty
  read -r -s -p 'Administrator password (12+ characters, hidden): ' admin_password </dev/tty
  printf '\n'
  read -r -s -p 'Confirm password (hidden): ' admin_confirm </dev/tty
  printf '\n'
  [[ $admin_password == "$admin_confirm" ]] || die 'Passwords do not match. Use the bootstrap command above to retry.'
  printf '%s\n%s\n' "$admin_email" "$admin_password" | pct exec "$CTID" -- /usr/local/bin/node --env-file=/etc/relay.env /opt/relay/dist/bootstrap-admin.mjs
  unset admin_password admin_confirm
fi
