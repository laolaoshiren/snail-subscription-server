#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-snail-subscription-server}"
APP_USER="${APP_USER:-snailrelay}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
REPO_URL="${REPO_URL:-https://github.com/laolaoshiren/snail-subscription-server.git}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"
ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
HOST="${HOST:-0.0.0.0}"
PROXY_URL="${PROXY_URL:-}"
INVITE_CODE="${INVITE_CODE:-}"
ALLOW_INSECURE_TLS="${ALLOW_INSECURE_TLS:-}"
RELAY_FETCH_TIMEOUT_MS="${RELAY_FETCH_TIMEOUT_MS:-}"
MAX_RETRIES="${MAX_RETRIES:-}"
RETRY_DELAY_MS="${RETRY_DELAY_MS:-}"
FETCH_TIMEOUT_MS="${FETCH_TIMEOUT_MS:-}"
PORT_INPUT="${PORT:-}"
PASSWORD_INPUT="${PANEL_PASSWORD:-}"

INSTALL_MODE="install"
CURRENT_PORT=""
CURRENT_PROXY_URL=""
CURRENT_INVITE_CODE=""
CURRENT_ALLOW_INSECURE_TLS=""
CURRENT_RELAY_FETCH_TIMEOUT_MS=""
CURRENT_MAX_RETRIES=""
CURRENT_RETRY_DELAY_MS=""
CURRENT_FETCH_TIMEOUT_MS=""
PANEL_PASSWORD_RESULT=""
PASSWORD_CHANGED="0"
BACKUP_DIR=""

log() {
  printf '[install] %s\n' "$1"
}

fail() {
  printf '[install] %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "请使用 root 或 sudo 运行安装脚本"
  fi
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "目标服务器必须使用 systemd"
  fi
}

tty_available() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

prompt_text() {
  local message="$1"
  local value=""

  if ! tty_available; then
    printf '%s' ""
    return
  fi

  printf '%s' "${message}" > /dev/tty
  IFS= read -r value < /dev/tty || true
  printf '%s' "${value}"
}

prompt_secret() {
  local message="$1"
  local value=""
  local stty_state=""

  if ! tty_available; then
    printf '%s' ""
    return
  fi

  printf '%s' "${message}" > /dev/tty
  stty_state="$(stty -g < /dev/tty)"
  stty -echo < /dev/tty
  IFS= read -r value < /dev/tty || true
  stty "${stty_state}" < /dev/tty
  printf '\n' > /dev/tty
  printf '%s' "${value}"
}

load_existing_env() {
  if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ] || [ -f "${ENV_FILE}" ] || [ -d "${APP_DIR}" ]; then
    INSTALL_MODE="update"
  fi

  if [ ! -f "${ENV_FILE}" ]; then
    return
  fi

  CURRENT_PORT="$(awk -F= '$1=="PORT" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
  CURRENT_PROXY_URL="$(awk -F= '$1=="PROXY_URL" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
  CURRENT_INVITE_CODE="$(awk -F= '$1=="INVITE_CODE" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
  CURRENT_ALLOW_INSECURE_TLS="$(awk -F= '$1=="ALLOW_INSECURE_TLS" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
  CURRENT_RELAY_FETCH_TIMEOUT_MS="$(awk -F= '$1=="RELAY_FETCH_TIMEOUT_MS" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
  CURRENT_MAX_RETRIES="$(awk -F= '$1=="MAX_RETRIES" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
  CURRENT_RETRY_DELAY_MS="$(awk -F= '$1=="RETRY_DELAY_MS" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
  CURRENT_FETCH_TIMEOUT_MS="$(awk -F= '$1=="FETCH_TIMEOUT_MS" {print substr($0, index($0, "=") + 1); exit}' "${ENV_FILE}")"
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

  fail "不支持当前包管理器，请手动安装 curl、git、node.js"
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

  fail "无法自动安装 Node.js"
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

random_password() {
  node -e "const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%&*!';let out='';for(let i=0;i<18;i+=1){out+=chars[Math.floor(Math.random()*chars.length)];}console.log(out);"
}

random_port() {
  node <<'NODE'
const net = require("node:net");
const server = net.createServer();
server.listen(0, "0.0.0.0", () => {
  const address = server.address();
  console.log(address.port);
  server.close();
});
NODE
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac

  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

ask_password() {
  local answer=""

  if [ -n "${PASSWORD_INPUT}" ]; then
    PANEL_PASSWORD_RESULT="${PASSWORD_INPUT}"
    PASSWORD_CHANGED="1"
    return
  fi

  if [ "${INSTALL_MODE}" = "update" ] && [ -f "${APP_DIR}/data/account.json" ]; then
    answer="$(prompt_secret '设置面板密码，直接回车保留当前密码: ')"
    if [ -z "${answer}" ]; then
      PANEL_PASSWORD_RESULT=""
      PASSWORD_CHANGED="0"
      return
    fi
  else
    answer="$(prompt_secret '设置面板密码，直接回车将自动生成随机密码: ')"
    if [ -z "${answer}" ]; then
      answer="$(random_password)"
      log "未输入面板密码，已自动生成随机密码"
    fi
  fi

  if [ "${#answer}" -lt 4 ]; then
    fail "面板密码至少需要 4 个字符"
  fi

  PANEL_PASSWORD_RESULT="${answer}"
  PASSWORD_CHANGED="1"
}

ask_port() {
  local answer=""
  local fallback=""

  if [ -n "${PORT_INPUT}" ]; then
    if ! validate_port "${PORT_INPUT}"; then
      fail "PORT 必须是 1-65535 之间的数字"
    fi
    PORT_INPUT="${PORT_INPUT}"
    return
  fi

  if [ "${INSTALL_MODE}" = "update" ] && [ -n "${CURRENT_PORT}" ]; then
    answer="$(prompt_text "设置监听端口，直接回车保留当前端口 ${CURRENT_PORT}: ")"
    if [ -z "${answer}" ]; then
      PORT_INPUT="${CURRENT_PORT}"
      return
    fi
  else
    answer="$(prompt_text '设置监听端口，直接回车将自动生成随机端口: ')"
    if [ -z "${answer}" ]; then
      fallback="$(random_port)"
      log "未输入监听端口，已自动生成随机端口 ${fallback}"
      PORT_INPUT="${fallback}"
      return
    fi
  fi

  if ! validate_port "${answer}"; then
    fail "监听端口必须是 1-65535 之间的数字"
  fi

  PORT_INPUT="${answer}"
}

apply_default_env_values() {
  PROXY_URL="${PROXY_URL:-${CURRENT_PROXY_URL:-off}}"
  INVITE_CODE="${INVITE_CODE:-${CURRENT_INVITE_CODE:-}}"
  ALLOW_INSECURE_TLS="${ALLOW_INSECURE_TLS:-${CURRENT_ALLOW_INSECURE_TLS:-1}}"
  RELAY_FETCH_TIMEOUT_MS="${RELAY_FETCH_TIMEOUT_MS:-${CURRENT_RELAY_FETCH_TIMEOUT_MS:-30000}}"
  MAX_RETRIES="${MAX_RETRIES:-${CURRENT_MAX_RETRIES:-3}}"
  RETRY_DELAY_MS="${RETRY_DELAY_MS:-${CURRENT_RETRY_DELAY_MS:-3000}}"
  FETCH_TIMEOUT_MS="${FETCH_TIMEOUT_MS:-${CURRENT_FETCH_TIMEOUT_MS:-15000}}"
}

stop_existing_service() {
  if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi
}

sync_repository() {
  mkdir -p "$(dirname "${APP_DIR}")"

  if [ -d "${APP_DIR}/.git" ]; then
    log "检测到已安装项目，执行更新"
    git -C "${APP_DIR}" remote set-url origin "${REPO_URL}"
    git -C "${APP_DIR}" fetch --depth 1 origin main
    git -C "${APP_DIR}" checkout -B main origin/main
    return
  fi

  if [ -d "${APP_DIR}" ]; then
    BACKUP_DIR="${APP_DIR}.backup.$(date +%Y%m%d%H%M%S)"
    log "检测到旧目录不是 Git 仓库，备份到 ${BACKUP_DIR}"
    mv "${APP_DIR}" "${BACKUP_DIR}"
  fi

  log "未检测到已安装项目，执行新安装"
  git clone --depth 1 "${REPO_URL}" "${APP_DIR}"
}

install_dependencies() {
  mkdir -p "${APP_DIR}/data"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
  su -s /bin/bash -c "cd '${APP_DIR}' && npm ci --omit=dev --no-fund --no-audit" "${APP_USER}"
}

restore_backup_data() {
  if [ -z "${BACKUP_DIR}" ] || [ ! -d "${BACKUP_DIR}/data" ]; then
    return
  fi

  log "恢复旧目录中的 data 数据"
  cp -a "${BACKUP_DIR}/data/." "${APP_DIR}/data/"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/data"
}

write_env_file() {
  cat > "${ENV_FILE}" <<EOF
PORT=${PORT_INPUT}
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

set_panel_password() {
  if [ "${PASSWORD_CHANGED}" != "1" ]; then
    return
  fi

  (
    cd "${APP_DIR}"
    PANEL_PASSWORD="${PANEL_PASSWORD_RESULT}" node scripts/init-account.js >/dev/null
  )

  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/data/account.json"
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
  health_url="http://127.0.0.1:${PORT_INPUT}/api/health"

  log "部署完成"
  log "模式: ${INSTALL_MODE}"
  log "服务名: ${SERVICE_NAME}"
  log "项目目录: ${APP_DIR}"
  log "环境文件: ${ENV_FILE}"
  log "面板地址: http://服务器IP:${PORT_INPUT}"
  log "健康检查: ${health_url}"

  if [ "${PASSWORD_CHANGED}" = "1" ]; then
    log "面板密码: ${PANEL_PASSWORD_RESULT}"
  else
    log "面板密码: 保留现有密码"
  fi

  log "查看状态: systemctl status ${SERVICE_NAME}"
  log "查看日志: journalctl -u ${SERVICE_NAME} -f"
}

main() {
  require_root
  require_systemd
  load_existing_env
  install_base_packages
  install_nodejs
  ask_password
  ask_port
  apply_default_env_values
  ensure_app_user
  stop_existing_service
  sync_repository
  install_dependencies
  restore_backup_data
  write_env_file
  set_panel_password
  write_service
  print_summary
}

main "$@"
