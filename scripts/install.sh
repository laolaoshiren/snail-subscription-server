#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-snail-subscription-server}"
APP_USER="${APP_USER:-snailrelay}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
REPO_URL="${REPO_URL:-https://github.com/laolaoshiren/snail-subscription-server.git}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"
ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
PROXY_URL="${PROXY_URL:-off}"
INVITE_CODE="${INVITE_CODE:-}"
ALLOW_INSECURE_TLS="${ALLOW_INSECURE_TLS:-1}"
RELAY_FETCH_TIMEOUT_MS="${RELAY_FETCH_TIMEOUT_MS:-30000}"
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_DELAY_MS="${RETRY_DELAY_MS:-3000}"
FETCH_TIMEOUT_MS="${FETCH_TIMEOUT_MS:-15000}"

log() {
  printf '[install] %s\n' "$1"
}

fail() {
  printf '[install] %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "please run as root or through sudo"
  fi
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemd is required on the target server"
  fi
}

install_base_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl git gnupg
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl git
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl git
    return
  fi

  fail "unsupported package manager, please install curl/git/node.js manually"
}

install_nodejs() {
  local needs_install="yes"

  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [ "${major}" -ge 20 ]; then
      needs_install="no"
    fi
  fi

  if [ "${needs_install}" = "no" ]; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
    return
  fi

  fail "unable to install node.js automatically"
}

ensure_app_user() {
  if id "${APP_USER}" >/dev/null 2>&1; then
    return
  fi

  useradd \
    --system \
    --create-home \
    --home-dir "/var/lib/${APP_USER}" \
    --shell /usr/sbin/nologin \
    "${APP_USER}"
}

sync_repository() {
  mkdir -p "$(dirname "${APP_DIR}")"

  if [ -d "${APP_DIR}/.git" ]; then
    git -C "${APP_DIR}" remote set-url origin "${REPO_URL}"
    git -C "${APP_DIR}" fetch --depth 1 origin main
    git -C "${APP_DIR}" checkout -B main origin/main
  elif [ -d "${APP_DIR}" ]; then
    fail "${APP_DIR} already exists and is not a git repository"
  else
    git clone --depth 1 "${REPO_URL}" "${APP_DIR}"
  fi
}

install_dependencies() {
  mkdir -p "${APP_DIR}/data"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
  su -s /bin/bash -c "cd '${APP_DIR}' && npm ci --omit=dev --no-fund --no-audit" "${APP_USER}"
}

write_env_file() {
  cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
HOST=${HOST}
PROXY_URL=${PROXY_URL}
INVITE_CODE=${INVITE_CODE}
ALLOW_INSECURE_TLS=${ALLOW_INSECURE_TLS}
RELAY_FETCH_TIMEOUT_MS=${RELAY_FETCH_TIMEOUT_MS}
MAX_RETRIES=${MAX_RETRIES}
RETRY_DELAY_MS=${RETRY_DELAY_MS}
FETCH_TIMEOUT_MS=${FETCH_TIMEOUT_MS}
EOF

  chmod 600 "${ENV_FILE}"
}

write_service() {
  local node_bin
  node_bin="$(command -v node)"

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Snail Subscription Relay Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=${node_bin} src/server.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
}

print_summary() {
  local health_url
  health_url="http://127.0.0.1:${PORT}/api/health"

  log "deployment completed"
  log "service: ${SERVICE_NAME}"
  log "app dir: ${APP_DIR}"
  log "env file: ${ENV_FILE}"
  log "health: ${health_url}"
  log "status: systemctl status ${SERVICE_NAME}"
  log "logs: journalctl -u ${SERVICE_NAME} -f"
}

main() {
  require_root
  require_systemd
  install_base_packages
  install_nodejs
  ensure_app_user
  sync_repository
  install_dependencies
  write_env_file
  write_service
  print_summary
}

main "$@"
