#!/usr/bin/env bash
#
# Local development data services: PostgreSQL + Valkey, defined in
# docker-compose.dev.yml. The API itself runs on the host via `pnpm dev`.
#
#   up       start both and wait until healthy
#   down     stop and remove the containers, KEEPING the data volume
#   nuke     stop and remove the containers AND the data volume
#   reset    drop and recreate the database (migrations replay on next API boot)
#   status   show container health, then check the schema via DATABASE_URL
#   logs     tail logs; pass pg or valkey to follow just one
#
# `docker compose down -v` is what destroys data, and `up` reuses the volume, so
# the lifecycle is expressible with stock compose commands. This script exists
# only to add the two things compose has no concept of — recreating a database
# in place, and checking the app's connection string against the compose file.
#
# docker-compose.yml is the production path and is deliberately separate: it
# points at DOM Cloud's shared database over the container host bridge.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_FILE=docker-compose.dev.yml
WAIT_TIMEOUT="${DEV_WAIT_TIMEOUT:-60}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_BLUE=$'\033[34m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_BLUE=''; C_OFF=''
fi

die() { printf '%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
head1() { printf '\n%s%s%s\n' "$C_BLUE" "$1" "$C_OFF"; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
  docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable. Is Docker running?"
}

# The healthchecks in docker-compose.dev.yml are what --wait blocks on, so this
# returns as soon as both services can actually accept traffic, not merely once
# the containers exist.
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

cmd_up() {
  require_docker
  head1 "Starting PostgreSQL and Valkey (waiting up to ${WAIT_TIMEOUT}s to be healthy)"
  compose up -d --wait --wait-timeout "$WAIT_TIMEOUT"
  printf '  %s✓ both services healthy%s\n' "$C_GREEN" "$C_OFF"
  printf '\n  Next: %spnpm dev%s  (or %spnpm db:status%s to verify the connection)\n' \
    "$C_GREEN" "$C_OFF" "$C_BLUE" "$C_OFF"
}

cmd_down() {
  require_docker
  head1 "Stopping services (data volume kept — use nuke to delete it)"
  compose down
}

cmd_nuke() {
  require_docker
  head1 "Stopping services and DELETING the data volume"
  compose down -v
  printf '  %svolume removed%s — the next %sup%s initialises a fresh database\n' \
    "$C_BLUE" "$C_OFF" "$C_BLUE" "$C_OFF"
}

cmd_logs() {
  require_docker
  case "${1:-}" in
    pg | postgres) compose logs -f postgres ;;
    valkey | redis) compose logs -f valkey ;;
    '') compose logs -f ;;
    *) die "logs: expected 'pg' or 'valkey', got '$1'" ;;
  esac
}

cmd_status() {
  require_docker
  head1 "Containers"
  compose ps
  # The point of this half: it connects with the exact DATABASE_URL the API will
  # use, over the host-mapped port, so a mismatch between .env and the compose
  # file's POSTGRES_* literals is reported here rather than as an obscure
  # authentication failure in the API later.
  head1 "Database (via DATABASE_URL from .env)"
  node scripts/dev-db.mjs status
}

cmd_reset() {
  require_docker
  head1 "Resetting the database"
  node scripts/dev-db.mjs reset
}

command="${1:-up}"
[[ $# -gt 0 ]] && shift || true

case "$command" in
  up) cmd_up "$@" ;;
  down) cmd_down "$@" ;;
  nuke) cmd_nuke "$@" ;;
  reset) cmd_reset "$@" ;;
  status) cmd_status "$@" ;;
  logs) cmd_logs "$@" ;;
  -h | --help | help) sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$command' (expected up, down, nuke, reset, status or logs)" ;;
esac
