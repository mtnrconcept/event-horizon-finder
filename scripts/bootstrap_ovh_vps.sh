#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly REPOSITORY_URL="https://github.com/mtnrconcept/event-horizon-finder.git"
readonly INSTALL_DIR="/opt/globalparty/event-horizon-finder"
readonly ENV_FILE="${INSTALL_DIR}/infra/searxng/.env"
readonly COMPOSE_FILE="${INSTALL_DIR}/infra/searxng/compose.vps.yaml"
readonly DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

PUBLIC_HOST=""
EXPECTED_IPV4=""
EXPECTED_IPV6=""
REPOSITORY_REF=""
declare -a TEMP_FILES=()
declare -a compose=()
STACK_EXPOSED=false
STACK_PREEXISTED=false
PUBLIC_HOST_HAS_IPV6=false

usage() {
  cat <<'EOF'
Usage: sudo bash bootstrap_ovh_vps.sh \
  --host HOSTNAME --expected-ip IPV4 --expected-ipv6 IPV6 --ref COMMIT_SHA

Installs and secures the GlobalParty private search stack on Ubuntu 24.04.
HOSTNAME must resolve in public DNS to IPV4. If HOSTNAME publishes an AAAA
record, it must resolve to IPV6. Secrets are generated locally and are never
printed by this script. COMMIT_SHA must be the complete 40-character SHA of a
reviewed commit.
EOF
}

log() {
  printf '[globalparty-vps] %s\n' "$*"
}

close_stack_on_failure() {
  [[ "$STACK_EXPOSED" == true && ${#compose[@]} -gt 0 ]] || return 0
  if [[ "$STACK_PREEXISTED" == true ]]; then
    "${compose[@]}" stop gateway >/dev/null 2>&1 || true
  else
    "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}

die() {
  close_stack_on_failure
  printf '[globalparty-vps] ERROR: %s\n' "$*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  trap - ERR
  close_stack_on_failure
  printf '[globalparty-vps] ERROR: installation stopped at line %s (exit %s)\n' "${BASH_LINENO[0]}" "$exit_code" >&2
  exit "$exit_code"
}

cleanup() {
  local path
  for path in "${TEMP_FILES[@]}"; do
    [[ -n "$path" ]] && rm -f -- "$path"
  done
}

trap on_error ERR
trap cleanup EXIT

while (($# > 0)); do
  case "$1" in
    --host)
      (($# >= 2)) || die "--host requires a value"
      PUBLIC_HOST="$2"
      shift 2
      ;;
    --expected-ip)
      (($# >= 2)) || die "--expected-ip requires a value"
      EXPECTED_IPV4="$2"
      shift 2
      ;;
    --expected-ipv6)
      (($# >= 2)) || die "--expected-ipv6 requires a value"
      EXPECTED_IPV6="$2"
      shift 2
      ;;
    --ref)
      (($# >= 2)) || die "--ref requires a value"
      REPOSITORY_REF="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "run this installer with sudo"
command -v flock >/dev/null || die "the required flock command is unavailable"
install -d -m 0755 /run/lock
exec 9>/run/lock/globalparty-vps-bootstrap.lock
flock -n 9 || die "another GlobalParty VPS installation is already running"

[[ -n "$PUBLIC_HOST" ]] || die "--host is required"
[[ ${#PUBLIC_HOST} -le 253 && "$PUBLIC_HOST" == *.* ]] || die "invalid public hostname"
IFS='.' read -r -a hostname_labels <<<"$PUBLIC_HOST"
for label in "${hostname_labels[@]}"; do
  [[ ${#label} -ge 1 && ${#label} -le 63 ]] || die "invalid public hostname label"
  [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ || "$label" =~ ^[a-z0-9]$ ]] || die "invalid public hostname label"
done

valid_ipv4() {
  local address="$1" octet
  local -a octets
  IFS='.' read -r -a octets <<<"$address"
  [[ ${#octets[@]} -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
}

[[ -n "$EXPECTED_IPV4" ]] || die "--expected-ip is required"
valid_ipv4 "$EXPECTED_IPV4" || die "invalid expected IPv4 address"
[[ -n "$EXPECTED_IPV6" ]] || die "--expected-ipv6 is required"
[[ "$REPOSITORY_REF" =~ ^[0-9a-f]{40}$ ]] || die "--ref must be a complete lowercase 40-character commit SHA"

source /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "this installer supports Ubuntu only"
[[ "${VERSION_ID:-}" == "24.04" ]] || die "Ubuntu 24.04 LTS is required"

export DEBIAN_FRONTEND=noninteractive

log "installing operating-system prerequisites"
apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
  ca-certificates \
  curl \
  dnsutils \
  fail2ban \
  git \
  gnupg \
  iproute2 \
  jq \
  openssl \
  python3-minimal \
  unattended-upgrades \
  ufw

log "configuring the official Docker package repository"
conflicting_packages=()
for package in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii'; then
    conflicting_packages+=("$package")
  fi
done
if ((${#conflicting_packages[@]} > 0)); then
  die "remove conflicting Docker packages first: ${conflicting_packages[*]}"
fi

install -d -m 0755 /etc/apt/keyrings
docker_key_temp="$(mktemp /etc/apt/keyrings/docker.asc.XXXXXX)"
TEMP_FILES+=("$docker_key_temp")
curl --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 \
  https://download.docker.com/linux/ubuntu/gpg \
  --output "$docker_key_temp"
docker_fingerprint="$(gpg --show-keys --with-colons "$docker_key_temp" | awk -F: '$1 == "fpr" { print $10; exit }')"
[[ "$docker_fingerprint" == "$DOCKER_GPG_FINGERPRINT" ]] || die "the Docker signing-key fingerprint is unexpected"
install -m 0644 "$docker_key_temp" /etc/apt/keyrings/docker.asc

architecture="$(dpkg --print-architecture)"
[[ "$architecture" == "amd64" ]] || die "the reviewed image set currently supports this installer on amd64 only"
codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
[[ -n "$codename" ]] || die "could not determine the Ubuntu codename"
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
  containerd.io \
  docker-buildx-plugin \
  docker-ce \
  docker-ce-cli \
  docker-compose-plugin
systemctl enable --now docker
docker compose version >/dev/null

log "enabling automatic security updates"
cat > /etc/apt/apt.conf.d/52globalparty-unattended-upgrades <<'EOF'
APT::Periodic::Enable "1";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
systemctl enable --now unattended-upgrades.service

log "configuring the firewall"
mapfile -t ssh_ports < <(sshd -T | awk '$1 == "port" && $2 ~ /^[0-9]+$/ { print $2 }')
if [[ -n "${SSH_CONNECTION:-}" ]]; then
  read -r _ _ _ active_ssh_port <<<"$SSH_CONNECTION"
  [[ "$active_ssh_port" =~ ^[0-9]+$ ]] && ssh_ports+=("$active_ssh_port")
fi
((${#ssh_ports[@]} > 0)) || die "could not determine the active SSH port"
mapfile -t ssh_ports < <(printf '%s\n' "${ssh_ports[@]}" | sort -nu)

ufw default deny incoming
ufw default allow outgoing
for ssh_port in "${ssh_ports[@]}"; do
  ((ssh_port >= 1 && ssh_port <= 65535)) || die "invalid SSH port reported by sshd"
  ufw allow "${ssh_port}/tcp"
done
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

log "enabling SSH brute-force protection"
ssh_ports_csv="$(IFS=,; echo "${ssh_ports[*]}")"
cat > /etc/fail2ban/jail.d/globalparty-sshd.local <<EOF
[sshd]
enabled = true
backend = systemd
port = ${ssh_ports_csv}
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
fail2ban-client reload >/dev/null
log "leaving SSH authentication unchanged to avoid locking out the current administrator"

EXPECTED_IPV6="$(python3 -c 'import ipaddress,sys; print(ipaddress.IPv6Address(sys.argv[1]).compressed)' "$EXPECTED_IPV6")" \
  || die "invalid expected IPv6 address"

log "checking that both public addresses are assigned to this VPS"
address_json="$(ip -j address show)"
jq -e --arg address "$EXPECTED_IPV4" \
  '[.[].addr_info[]? | select(.family == "inet") | .local] | index($address) != null' \
  <<<"$address_json" >/dev/null || die "${EXPECTED_IPV4} is not assigned to this VPS"
jq -e --arg address "$EXPECTED_IPV6" \
  '[.[].addr_info[]? | select(.family == "inet6") | .local] | index($address) != null' \
  <<<"$address_json" >/dev/null || die "${EXPECTED_IPV6} is not assigned to this VPS"

log "checking the public DNS records for the VPS addresses"
dns_ipv4_answers="$(mktemp)"
dns_ipv6_answers="$(mktemp)"
TEMP_FILES+=("$dns_ipv4_answers" "$dns_ipv6_answers")
public_dns_state="mismatch"
for _ in $(seq 1 18); do
  : >"$dns_ipv4_answers"
  : >"$dns_ipv6_answers"
  ipv4_lookup_ok=false
  ipv6_lookup_ok=false
  if dig +time=3 +tries=1 +short "${PUBLIC_HOST}." A >"$dns_ipv4_answers" 2>/dev/null; then
    ipv4_lookup_ok=true
  fi
  if dig +time=3 +tries=1 +short "${PUBLIC_HOST}." AAAA >"$dns_ipv6_answers" 2>/dev/null; then
    ipv6_lookup_ok=true
  fi
  if [[ "$ipv4_lookup_ok" == true && "$ipv6_lookup_ok" == true ]]; then
    public_dns_state="$(python3 - "$EXPECTED_IPV4" "$EXPECTED_IPV6" "$dns_ipv4_answers" "$dns_ipv6_answers" <<'PY'
import ipaddress
import sys

expected_v4, expected_v6, ipv4_path, ipv6_path = sys.argv[1:]


def addresses(path, version):
    resolved = set()
    with open(path, encoding="utf-8") as answers:
        for raw_answer in answers:
            try:
                address = ipaddress.ip_address(raw_answer.strip())
            except ValueError:
                # `dig +short` can include a CNAME before its address.
                continue
            if address.version == version:
                resolved.add(address.compressed)
    return resolved


ipv4_addresses = addresses(ipv4_path, 4)
ipv6_addresses = addresses(ipv6_path, 6)
if expected_v4 not in ipv4_addresses:
    print("mismatch")
elif not ipv6_addresses:
    print("ipv4-only")
elif expected_v6 in ipv6_addresses:
    print("dual-stack")
else:
    print("mismatch")
PY
    )"
    case "$public_dns_state" in
      dual-stack)
        PUBLIC_HOST_HAS_IPV6=true
        break
        ;;
      ipv4-only)
        break
        ;;
    esac
  fi
  sleep 5
done
[[ "$public_dns_state" != "mismatch" ]] \
  || die "${PUBLIC_HOST} does not publish the expected IPv4 address or publishes an unexpected IPv6 address"
if [[ "$PUBLIC_HOST_HAS_IPV6" != true ]]; then
  log "the public hostname has no AAAA record; continuing with an IPv4 public endpoint"
fi

log "waiting for synchronized system time before ACME certificate issuance"
timedatectl set-ntp true || true
time_synchronized=false
for _ in $(seq 1 36); do
  if timedatectl show --property=NTPSynchronized --value | grep -Fxq yes; then
    time_synchronized=true
    break
  fi
  sleep 5
done
[[ "$time_synchronized" == true ]] || die "system time is not synchronized"

log "installing the reviewed repository revision"
install -d -m 0755 "$(dirname "$INSTALL_DIR")"
if [[ -e "$INSTALL_DIR" && ! -d "${INSTALL_DIR}/.git" ]]; then
  die "${INSTALL_DIR} exists but is not a Git checkout"
fi
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  [[ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]] || die "the deployment checkout contains local changes"
  [[ "$(git -C "$INSTALL_DIR" remote get-url origin)" == "$REPOSITORY_URL" ]] \
    || die "the deployment checkout has an unexpected origin URL"
else
  install -d -m 0755 "$INSTALL_DIR"
  git -C "$INSTALL_DIR" init
  git -C "$INSTALL_DIR" remote add origin "$REPOSITORY_URL"
fi
git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPOSITORY_REF"
git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD
[[ "$(git -C "$INSTALL_DIR" rev-parse HEAD)" == "$REPOSITORY_REF" ]] \
  || die "Git did not check out the requested reviewed commit"
chown -R root:root "$INSTALL_DIR"

read_env_value() {
  local key="$1"
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

if [[ -L "$ENV_FILE" ]]; then
  die "refusing to read a symbolic-link runtime configuration"
elif [[ -e "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  die "the runtime configuration is not a regular file"
elif [[ -f "$ENV_FILE" ]]; then
  for secret_name in SEARXNG_SECRET SEARXNG_AUTH_TOKEN SAFE_FETCH_AUTH_TOKEN; do
    secret_entries="$(awk -F= -v wanted="$secret_name" '$1 == wanted { count++ } END { print count + 0 }' "$ENV_FILE")"
    [[ "$secret_entries" -eq 1 ]] \
      || die "the existing runtime configuration has an invalid ${secret_name} entry"
  done
  searxng_secret="$(read_env_value SEARXNG_SECRET)"
  searxng_token="$(read_env_value SEARXNG_AUTH_TOKEN)"
  safe_fetch_token="$(read_env_value SAFE_FETCH_AUTH_TOKEN)"
  [[ "$searxng_secret" =~ ^[0-9a-f]{64}$ ]] || die "existing SEARXNG_SECRET is invalid; refusing to rotate it"
  [[ "$searxng_token" =~ ^[0-9a-f]{64}$ ]] || die "existing SEARXNG_AUTH_TOKEN is invalid; refusing to rotate it"
  [[ "$safe_fetch_token" =~ ^[0-9a-f]{64}$ ]] || die "existing SAFE_FETCH_AUTH_TOKEN is invalid; refusing to rotate it"
else
  searxng_secret="$(openssl rand -hex 32)"
  searxng_token="$(openssl rand -hex 32)"
  safe_fetch_token="$(openssl rand -hex 32)"
fi
[[ "$searxng_secret" != "$searxng_token" ]] || die "SearXNG secrets must be independent"
[[ "$searxng_secret" != "$safe_fetch_token" ]] || die "proxy secrets must be independent"
[[ "$searxng_token" != "$safe_fetch_token" ]] || die "bearer tokens must be independent"

log "atomically writing the root-only runtime configuration"
umask 077
env_temp="$(mktemp "${ENV_FILE}.XXXXXX")"
TEMP_FILES+=("$env_temp")
chmod 0600 "$env_temp"
cat > "$env_temp" <<EOF
SEARXNG_PUBLIC_HOST=${PUBLIC_HOST}
SEARXNG_PUBLIC_URL=https://${PUBLIC_HOST}/
SEARXNG_SECRET=${searxng_secret}
SEARXNG_AUTH_TOKEN=${searxng_token}
SAFE_FETCH_AUTH_TOKEN=${safe_fetch_token}
SAFE_FETCH_PROXY_URL=https://${PUBLIC_HOST}/safe-fetch/v1/fetch
SAFE_FETCH_MAX_RESPONSE_BYTES=5242880
SAFE_FETCH_MAX_CONCURRENCY=16
SAFE_FETCH_TOTAL_TIMEOUT=20s
SAFE_FETCH_DNS_TIMEOUT=3s
SAFE_FETCH_CONNECT_TIMEOUT=5s
SAFE_FETCH_RESPONSE_HEADER_TIMEOUT=8s
CADDY_IMAGE=docker.io/library/caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
SEARXNG_IMAGE=ghcr.io/searxng/searxng:2026.5.10-df1f24fb7@sha256:e29964c6e23ce4bb09a173c5d7618534a40497d585ae9d90ed1bd93bab9474a9
VALKEY_IMAGE=docker.io/valkey/valkey:8.1.8-alpine@sha256:cfe71288f087704b06be45e270afa7a2abbf820093d6b11a23762081f5ff321d
SAFE_FETCH_GO_IMAGE=docker.io/library/golang:1.25-alpine@sha256:56961d79ea8129efddcc0b8643fd8a5416b4e6228cfd477e3fd61deb2672c587
SAFE_FETCH_PROXY_IMAGE=globalparty/safe-fetch-proxy:local
EOF
mv -f -- "$env_temp" "$ENV_FILE"
chmod 0600 "$ENV_FILE"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
log "validating the Docker Compose model"
"${compose[@]}" config --quiet

existing_gateway_id="$("${compose[@]}" ps -q gateway)"
if [[ -z "$existing_gateway_id" ]]; then
  for port in 80 443; do
    if ss -H -ltn "sport = :${port}" | grep -q .; then
      die "TCP port ${port} is already in use by another service"
    fi
  done
  if ss -H -lun "sport = :443" | grep -q .; then
    die "UDP port 443 is already in use by another service"
  fi
else
  STACK_PREEXISTED=true
fi

log "pulling digest-pinned service images"
"${compose[@]}" pull gateway searxng valkey

log "building and testing the safe-fetch proxy"
"${compose[@]}" build --pull safe-fetch-proxy

log "starting the private search stack"
STACK_EXPOSED=true
"${compose[@]}" up -d --remove-orphans --wait --wait-timeout 300

log "verifying container health and private port isolation"
for service in gateway safe-fetch-proxy searxng valkey; do
  container_id="$("${compose[@]}" ps -q "$service")"
  [[ -n "$container_id" ]] || die "${service} did not create a container"
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  [[ "$health_status" == "healthy" ]] || die "${service} is not healthy"
done
for service in safe-fetch-proxy searxng valkey; do
  container_id="$("${compose[@]}" ps -q "$service")"
  port_bindings="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$container_id")"
  jq -e 'to_entries | all(.value == null)' <<<"$port_bindings" >/dev/null \
    || die "${service} unexpectedly publishes a host port"
done

wait_for_https() {
  local address_family="$1"
  local address="$2"
  local endpoint="$3"
  for _ in $(seq 1 36); do
    if curl "$address_family" --noproxy '*' \
      --resolve "${PUBLIC_HOST}:443:${address}" \
      --fail --silent --show-error --max-time 5 "$endpoint" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

log "waiting for the public TLS endpoint"
wait_for_https --ipv4 "$EXPECTED_IPV4" "https://${PUBLIC_HOST}/healthz" \
  || die "the public HTTPS endpoint did not become ready over IPv4"
if [[ "$PUBLIC_HOST_HAS_IPV6" == true ]]; then
  wait_for_https --ipv6 "[${EXPECTED_IPV6}]" "https://${PUBLIC_HOST}/healthz" \
    || die "the public HTTPS endpoint did not become ready over IPv6"
fi
wait_for_https --ipv4 "$EXPECTED_IPV4" "https://${PUBLIC_HOST}/safe-fetch/healthz" \
  || die "the safe-fetch health endpoint did not become ready"

unauthorized_status="$(curl --silent --show-error --connect-timeout 5 --max-time 30 --output /dev/null --write-out '%{http_code}' \
  --noproxy '*' --resolve "${PUBLIC_HOST}:443:${EXPECTED_IPV4}" \
  --get --data-urlencode 'q=Geneva events' --data-urlencode 'format=json' \
  "https://${PUBLIC_HOST}/search")"
[[ "$unauthorized_status" == "401" ]] || die "the unauthenticated search endpoint returned ${unauthorized_status}, expected 401"

searx_curl_config="$(mktemp)"
safe_fetch_curl_config="$(mktemp)"
searx_health_json="$(mktemp)"
TEMP_FILES+=("$searx_curl_config" "$safe_fetch_curl_config" "$searx_health_json")
chmod 0600 "$searx_curl_config" "$safe_fetch_curl_config" "$searx_health_json"
printf 'header = "Authorization: Bearer %s"\n' "$searxng_token" >"$searx_curl_config"
printf 'header = "Authorization: Bearer %s"\n' "$safe_fetch_token" >"$safe_fetch_curl_config"

log "checking an authenticated SearXNG JSON response"
curl --config "$searx_curl_config" --fail --silent --show-error --connect-timeout 5 --max-time 30 \
  --noproxy '*' --resolve "${PUBLIC_HOST}:443:${EXPECTED_IPV4}" \
  --get --data-urlencode 'q=Agenda Geneva' --data-urlencode 'format=json' \
  "https://${PUBLIC_HOST}/search" \
  --output "$searx_health_json"
jq -e 'type == "object" and (.results | type == "array")' "$searx_health_json" >/dev/null

log "checking an authenticated safe fetch"
curl --config "$safe_fetch_curl_config" --fail --silent --show-error --connect-timeout 5 --max-time 30 \
  --noproxy '*' --resolve "${PUBLIC_HOST}:443:${EXPECTED_IPV4}" \
  --header 'Content-Type: application/json' \
  --data '{"url":"https://example.com/"}' \
  "https://${PUBLIC_HOST}/safe-fetch/v1/fetch" \
  --output /dev/null

"${compose[@]}" ps
STACK_EXPOSED=false

cat <<EOF

GlobalParty search infrastructure is healthy.

Public endpoints:
  SEARXNG_BASE_URL=https://${PUBLIC_HOST}/
  SAFE_FETCH_PROXY_URL=https://${PUBLIC_HOST}/safe-fetch/v1/fetch

The two bearer tokens remain only in this root-readable file:
  ${ENV_FILE}

Do not paste those tokens into chat or commit them. The next step is to copy
them directly into the protected GitHub Actions and Supabase Edge secrets.
EOF
