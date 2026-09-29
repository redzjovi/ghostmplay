#!/usr/bin/env bash
#
# Local development services: PostgreSQL + Valkey in Docker.
#
# Connection details are read from the same .env the application uses, so the
# containers and the app can never disagree about host, port or credentials.
#
#   ./scripts/dev-services.sh up       start both (default)
#   ./scripts/dev-services.sh down     stop and remove
#   ./scripts/dev-services.sh reset    drop and recreate the database
#   ./scripts/dev-services.sh status   show ports and readiness
#   ./scripts/dev-services.sh logs pg  tail logs (pg or valkey)
#
# Deliberately NOT a compose file: this is a host-side convenience for running
# the API with `pnpm dev`. docker-compose.yml is the production path and points
# at DOM Cloud's shared database over the container host bridge.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Pin to the production major. Testing migrations against 16 and deploying to 17
# hides exactly the class of problem that is expensive to find later.
PG_IMAGE="${DEV_PG_IMAGE:-postgres:17-alpine}"
# Production runs Valkey 8.0. Valkey is a Redis fork and wire-compatible for
# everything this app uses (INCR, EXPIRE, SET NX EX, EVAL). Note the image is
# namespaced: plain `valkey:8-alpine` does not exist on Docker Hub.
VALKEY_IMAGE="${DEV_VALKEY_IMAGE:-valkey/valkey:8-alpine}"

PG_CONTAINER="${DEV_PG_CONTAINER:-ghostmplay-pg}"
VALKEY_CONTAINER="${DEV_VALKEY_CONTAINER:-ghostmplay-valkey}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_OFF=''
fi

die()  { printf '%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
warn() { printf '%swarn%s  %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
info() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok()   { printf '%sok%s    %s\n' "$C_GREEN" "$C_OFF" "$*"; }

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon — is it running?"

if [[ ! -f .env ]]; then
  die ".env not found. Copy .env.example to .env and set DATABASE_URL first."
fi

# ---------------------------------------------------------------------------
# Read the connection settings out of .env using the same key=value semantics
# the application uses, so the containers and the app cannot disagree.
# ---------------------------------------------------------------------------
load_url() {
  local key="$1"
  local name value
  URL_HOST=''; URL_PORT=''; URL_USER=''; URL_PASS=''; URL_DB=''
  while IFS=$'\t' read -r name value; do
    case "$name" in
      URL_HOST) URL_HOST="$value" ;;
      URL_PORT) URL_PORT="$value" ;;
      URL_USER) URL_USER="$value" ;;
      URL_PASS) URL_PASS="$value" ;;
      URL_DB)   URL_DB="$value" ;;
    esac
  done < <(KEY="$key" node scripts/read-env-url.mjs) \
    || die "could not read $key from .env"

  [[ -n "${URL_HOST:-}" ]] || die "$key in .env has no host"
}

parse_pg()    { load_url DATABASE_URL; PG_HOST="$URL_HOST"; PG_PORT="$URL_PORT"; PG_USER="$URL_USER"; PG_PASS="$URL_PASS"; PG_DB="$URL_DB"; }
parse_valkey() { load_url REDIS_URL; VALKEY_PORT="$URL_PORT"; VALKEY_PASS="$URL_PASS"; }

container_running() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

# Refuses to start if something unrelated already holds the port, so a failure
# is "port 5432 is taken" rather than a container that starts and cannot connect.
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .
  else
    node -e "
      const net=require('net');
      const s=net.createServer();
      s.once('error',()=>process.exit(0));
      s.once('listening',()=>s.close(()=>process.exit(1)));
      s.listen($port);
    " 2>/dev/null
  fi
}

start_pg() {
  if container_running "$PG_CONTAINER"; then
    ok "postgres already running (${PG_CONTAINER})"
    return
  fi
  if container_exists "$PG_CONTAINER"; then
    info "removing stopped container $PG_CONTAINER"
    docker rm -f "$PG_CONTAINER" >/dev/null
  fi
  if port_in_use "$PG_PORT"; then
    die "port $PG_PORT is already in use. Stop whatever is using it, or change the port in DATABASE_URL in .env"
  fi

  info "starting postgres  ${PG_IMAGE}  port ${PG_PORT}"
  # POSTGRES_* only apply on first initialisation, which is why `reset` has to
  # recreate the database rather than trying to change credentials in place.
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASS" \
    -e POSTGRES_DB="$PG_DB" \
    -p "${PG_PORT}:5432" \
    "$PG_IMAGE" >/dev/null

  info "waiting for postgres to accept connections"
  for _ in $(seq 1 60); do
    if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
      ok "postgres ready on ${PG_HOST}:${PG_PORT}/${PG_DB}"
      return
    fi
    sleep 1
  done
  die "postgres did not become ready in 60s. Check: docker logs $PG_CONTAINER"
}

start_valkey() {
  if container_running "$VALKEY_CONTAINER"; then
    ok "valkey already running (${VALKEY_CONTAINER})"
    return
  fi
  if container_exists "$VALKEY_CONTAINER"; then
    info "removing stopped container $VALKEY_CONTAINER"
    docker rm -f "$VALKEY_CONTAINER" >/dev/null
  fi
  if port_in_use "$VALKEY_PORT"; then
    die "port $VALKEY_PORT is already in use. Stop whatever is using it, or change the port in REDIS_URL in .env"
  fi

  info "starting valkey   ${VALKEY_IMAGE}  port ${VALKEY_PORT}"
  # Password is optional: the app degrades gracefully without Valkey (rate
  # limiting off, sync lock falls back in-process), so a local run with no
  # REDIS_URL password is fine.
  local args=(-d --name "$VALKEY_CONTAINER" -p "${VALKEY_PORT}:6379")
  if [[ -n "${VALKEY_PASS:-}" ]]; then
    args+=(--requirepass "$VALKEY_PASS")
  fi
  docker run "${args[@]}" "$VALKEY_IMAGE" >/dev/null

  for _ in $(seq 1 30); do
    if docker exec "$VALKEY_CONTAINER" valkey-cli ${VALKEY_PASS:+-a "$VALKEY_PASS"} ping 2>/dev/null | grep -q PONG; then
      ok "valkey ready on port ${VALKEY_PORT}"
      return
    fi
    sleep 1
  done
  die "valkey did not answer PING in 30s. Check: docker logs $VALKEY_CONTAINER"
}

cmd_up() {
  parse_pg; parse_valkey
  start_pg
  start_valkey
  printf '\n'
  ok "ready — start the API with: pnpm dev"
}

cmd_down() {
  local removed=0
  for c in "$PG_CONTAINER" "$VALKEY_CONTAINER"; do
    if container_exists "$c"; then
      info "removing $c"
      docker rm -f "$c" >/dev/null
      removed=1
    fi
  done
  [[ $removed -eq 1 ]] && ok "stopped" || info "nothing to stop"
}

# Drops and recreates the database so the next API boot replays every migration
# from scratch. The container is left running.
cmd_reset() {
  parse_pg
  if ! container_running "$PG_CONTAINER"; then
    die "$PG_CONTAINER is not running. Run 'pnpm db:up' first."
  fi
  warn "this deletes all data in ${PG_DB}"
  printf 'type "yes" to continue: '
  local reply
  read -r reply
  [[ "$reply" == "yes" ]] || die "aborted"

  # Cannot drop the database you are connected to, so use the always-present
  # `postgres` database as the session.
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$PG_DB\" WITH (FORCE);" \
    -c "CREATE DATABASE \"$PG_DB\" OWNER \"$PG_USER\";" >/dev/null
  ok "recreated ${PG_DB}"
  # Migrations run at API boot, not on connection, so a running API stays
  # pointed at an empty database until it is restarted.
  info "restart the API (pnpm dev) to re-run all migrations"
}

cmd_status() {
  parse_pg; parse_valkey
  printf '%-8s %-22s %s\n' "service" "connection" "state"
  if container_running "$PG_CONTAINER"; then
    printf '%-8s %-22s %s\n' "postgres" "${PG_HOST}:${PG_PORT}/${PG_DB}" "${C_GREEN}up${C_OFF}"
  else
    printf '%-8s %-22s %s\n' "postgres" "${PG_HOST}:${PG_PORT}/${PG_DB}" "${C_YELLOW}down${C_OFF}"
  fi
  if container_running "$VALKEY_CONTAINER"; then
    printf '%-8s %-22s %s\n' "valkey" "127.0.0.1:${VALKEY_PORT}" "${C_GREEN}up${C_OFF}"
  else
    printf '%-8s %-22s %s\n' "valkey" "127.0.0.1:${VALKEY_PORT}" "${C_YELLOW}down${C_OFF}"
  fi

  if container_running "$PG_CONTAINER"; then
    local tables
    tables="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo '?')"
    info "  $tables public tables (9 expected once migrations have run)"
  fi
}

cmd_logs() {
  case "${1:-}" in
    pg)     docker logs -f "$PG_CONTAINER" ;;
    valkey|redis) docker logs -f "$VALKEY_CONTAINER" ;;
    *) die "usage: $0 logs [pg|valkey]" ;;
  esac
}

case "${1:-up}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  status) cmd_status ;;
  logs)   shift; cmd_logs "${1:-}" ;;
  -h|--help|help) sed -n '/^# Local development services/,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//' | sed '/^set -euo/d' ;;
  *) die "unknown command: $1 (try up, down, reset, status, logs)" ;;
esac
