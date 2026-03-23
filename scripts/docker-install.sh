#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-snail-subscription-server}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}-docker}"
DATA_DIR="${DATA_DIR:-${APP_DIR}/data}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/app.env}"
CONTAINER_NAME="${CONTAINER_NAME:-${APP_NAME}}"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/laolaoshiren/snail-subscription-server:latest}"
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

log() {
  printf '[docker-install] %s\n' "$1"
}

fail() {
  printf '[docker-install] %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "please run as root or through sudo"
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
  if [ -f "${ENV_FILE}" ] || [ -d "${DATA_DIR}" ]; then
    INSTALL_MODE="update"
  fi

  if command -v docker >/dev/null 2>&1; then
    if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
      INSTALL_MODE="update"
    fi
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
    apt-get install -y ca-certificates curl
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl
    return
  fi

  fail "unsupported package manager, please install curl and docker manually"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
    return
  fi

  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

random_password() {
  local chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%&*!'
  local length="${#chars}"
  local output=""
  local index=""
  local i=""

  for i in $(seq 1 18); do
    index="$(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % length ))"
    output="${output}${chars:index:1}"
  done

  printf '%s' "${output}"
}

port_in_use() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q LISTEN
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"
    return
  fi

  return 1
}

random_port() {
  local candidate=""

  while true; do
    candidate="$(awk 'BEGIN{srand(); print int(20000 + rand() * 30000)}')"
    if ! port_in_use "${candidate}"; then
      printf '%s' "${candidate}"
      return
    fi
    sleep 1
  done
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

  if [ "${INSTALL_MODE}" = "update" ] && [ -f "${DATA_DIR}/account.json" ]; then
    answer="$(prompt_secret 'Set panel password, press Enter to keep the current password: ')"
    if [ -z "${answer}" ]; then
      PASSWORD_CHANGED="0"
      PANEL_PASSWORD_RESULT=""
      return
    fi
  else
    answer="$(prompt_secret 'Set panel password, press Enter to generate a random password: ')"
    if [ -z "${answer}" ]; then
      answer="$(random_password)"
      log "generated a random panel password"
    fi
  fi

  if [ "${#answer}" -lt 4 ]; then
    fail "panel password must be at least 4 characters"
  fi

  PANEL_PASSWORD_RESULT="${answer}"
  PASSWORD_CHANGED="1"
}

ask_port() {
  local answer=""
  local fallback=""

  if [ -n "${PORT_INPUT}" ]; then
    if ! validate_port "${PORT_INPUT}"; then
      fail "PORT must be a number between 1 and 65535"
    fi
    return
  fi

  if [ "${INSTALL_MODE}" = "update" ] && [ -n "${CURRENT_PORT}" ]; then
    answer="$(prompt_text "Set listen port, press Enter to keep ${CURRENT_PORT}: ")"
    if [ -z "${answer}" ]; then
      PORT_INPUT="${CURRENT_PORT}"
      return
    fi
  else
    answer="$(prompt_text 'Set listen port, press Enter to generate a random port: ')"
    if [ -z "${answer}" ]; then
      fallback="$(random_port)"
      log "generated a random listen port ${fallback}"
      PORT_INPUT="${fallback}"
      return
    fi
  fi

  if ! validate_port "${answer}"; then
    fail "listen port must be a number between 1 and 65535"
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

prepare_directories() {
  mkdir -p "${APP_DIR}" "${DATA_DIR}"
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

pull_image() {
  if ! docker pull "${IMAGE_NAME}"; then
    fail "failed to pull ${IMAGE_NAME}; wait for the GitHub Actions Docker workflow to finish or override IMAGE_NAME"
  fi
}

set_panel_password() {
  if [ "${PASSWORD_CHANGED}" != "1" ]; then
    return
  fi

  docker run --rm \
    --entrypoint node \
    -e PANEL_PASSWORD="${PANEL_PASSWORD_RESULT}" \
    -e ACCOUNT_DATA_DIR=/work/data \
    -v "${DATA_DIR}:/work/data" \
    "${IMAGE_NAME}" \
    scripts/init-account.js >/dev/null
}

replace_container() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

  docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --env-file "${ENV_FILE}" \
    -p "${PORT_INPUT}:${PORT_INPUT}" \
    -v "${DATA_DIR}:/app/data" \
    "${IMAGE_NAME}" >/dev/null
}

print_summary() {
  log "deployment completed"
  log "mode: ${INSTALL_MODE}"
  log "container: ${CONTAINER_NAME}"
  log "image: ${IMAGE_NAME}"
  log "data dir: ${DATA_DIR}"
  log "panel url: http://SERVER_IP:${PORT_INPUT}"

  if [ "${PASSWORD_CHANGED}" = "1" ]; then
    log "panel password: ${PANEL_PASSWORD_RESULT}"
  else
    log "panel password: kept existing password"
  fi

  log "health: http://127.0.0.1:${PORT_INPUT}/api/health"
  log "status: docker ps --filter name=${CONTAINER_NAME}"
  log "logs: docker logs -f ${CONTAINER_NAME}"
}

main() {
  require_root
  load_existing_env
  install_base_packages
  install_docker
  ask_password
  ask_port
  apply_default_env_values
  prepare_directories
  write_env_file
  pull_image
  set_panel_password
  replace_container
  print_summary
}

main "$@"
