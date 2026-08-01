#!/usr/bin/env bash
#
# Local Postgres for development, via podman.
#
#   ./scripts/db.sh up      start (idempotent)
#   ./scripts/db.sh down    stop and remove
#   ./scripts/db.sh psql    open a shell
#   ./scripts/db.sh reset   destroy and recreate, losing all data
#   ./scripts/db.sh status  show state
#
# No compose provider is installed on this machine, so this drives podman
# directly rather than shipping a compose file that would not run.
#
# Port 5433 is deliberate — it avoids colliding with any system Postgres on 5432.

set -euo pipefail

CONTAINER="alertshield-postgres"
IMAGE="docker.io/library/postgres:17-alpine"
PORT="${ALERTSHIELD_DB_PORT:-5433}"
USER="alertshield"
PASSWORD="alertshield"
DB="alertshield"
VOLUME="alertshield-pgdata"

runtime() {
  if command -v podman >/dev/null 2>&1; then echo podman
  elif command -v docker >/dev/null 2>&1; then echo docker
  else echo "Neither podman nor docker found." >&2; exit 1
  fi
}

RT="$(runtime)"

exists() { "$RT" container exists "$CONTAINER" 2>/dev/null; }
running() { [ "$("$RT" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; }

up() {
  if running; then
    echo "Already running on port ${PORT}."
  else
    if exists; then
      "$RT" start "$CONTAINER" >/dev/null
      echo "Restarted existing container."
    else
      "$RT" run -d \
        --name "$CONTAINER" \
        -e POSTGRES_USER="$USER" \
        -e POSTGRES_PASSWORD="$PASSWORD" \
        -e POSTGRES_DB="$DB" \
        -p "${PORT}:5432" \
        -v "${VOLUME}:/var/lib/postgresql/data" \
        "$IMAGE" >/dev/null
      echo "Created container from ${IMAGE}."
    fi
  fi

  printf 'Waiting for Postgres'
  for _ in $(seq 1 30); do
    if "$RT" exec "$CONTAINER" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; then
      echo " ready."
      echo "DATABASE_URL=postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB}"
      return 0
    fi
    printf '.'
    sleep 1
  done
  echo " timed out." >&2
  exit 1
}

case "${1:-up}" in
  up) up ;;
  down)
    "$RT" rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "Stopped and removed ${CONTAINER}. Volume ${VOLUME} kept — use 'reset' to wipe it."
    ;;
  reset)
    "$RT" rm -f "$CONTAINER" >/dev/null 2>&1 || true
    "$RT" volume rm "$VOLUME" >/dev/null 2>&1 || true
    echo "Destroyed container and volume."
    up
    ;;
  psql)
    exec "$RT" exec -it "$CONTAINER" psql -U "$USER" -d "$DB"
    ;;
  status)
    if running; then echo "running on port ${PORT}"
    elif exists; then echo "stopped"
    else echo "not created"
    fi
    ;;
  *)
    echo "Usage: $0 {up|down|reset|psql|status}" >&2
    exit 1
    ;;
esac
