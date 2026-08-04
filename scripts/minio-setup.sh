#!/bin/sh
# Readiness gate and bucket bootstrap for the bundled MinIO.
#
# This runs as minio-setup's entrypoint. Ingestion and worker gate on
# `minio-setup: service_completed_successfully`, so whatever this script does
# decides whether the whole stack starts.
#
# The retry is bounded on purpose. An unbounded retry turns every MinIO failure
# -- bound host port, bad image pull, full disk, rootless networking -- into a
# stack that hangs in `Created` behind a `server misbehaving` DNS error that
# names none of them. Bounded, the operator gets the real cause in a minute.
#
# The deadline is safe against slow networks because `depends_on: minio:
# condition: service_started` already requires MinIO's image to be pulled and
# its container started before this runs, and mc's own image is pulled before
# the entrypoint executes. No pull time sits inside the deadline. Do not weaken
# that condition without raising the timeout.
#
# Lives in a file rather than an inline compose `entrypoint:` so it can quote
# shell freely -- a nested double quote inside `sh -c "..."` silently truncates
# the argument at the quote, and `docker compose config --quiet` accepts it.
set -eu

ALIAS_URL="${MINIO_INTERNAL_URL:-http://minio:9000}"
HOST_PORT="${MINIO_HOST_PORT:-9012}"
TIMEOUT="${MINIO_READY_TIMEOUT_SECONDS:-60}"
BUCKET="${MINIO_BUCKET:-opslane-replays}"
USER="${MINIO_ROOT_USER:-minio}"
PASSWORD="${MINIO_ROOT_PASSWORD:-minio12345}"

DEADLINE=$(( $(date +%s) + TIMEOUT ))

until mc alias set local "$ALIAS_URL" "$USER" "$PASSWORD" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "minio-setup: MinIO did not accept a connection at $ALIAS_URL within ${TIMEOUT}s." >&2
    echo "minio-setup: This container reaches MinIO over the Compose network; the host publishes it on port ${HOST_PORT}." >&2
    echo "minio-setup: Most common cause - host port ${HOST_PORT} is already bound by another Compose stack." >&2
    echo "minio-setup:   check: docker ps --filter publish=${HOST_PORT}" >&2
    echo "minio-setup:   fix:   export OPSLANE_MINIO_HOST_PORT=<free port> && docker compose up -d" >&2
    echo "minio-setup: If nothing holds that port, MinIO itself failed to start (bad pull, full disk, rootless networking)." >&2
    echo "minio-setup:   check: docker compose logs minio" >&2
    echo "minio-setup: If this machine is just slow, raise OPSLANE_MINIO_READY_TIMEOUT_SECONDS." >&2
    exit 1
  fi
  sleep 1
done

# No `|| true` on either call. `mc mb -p` already succeeds on an existing
# bucket, and a failed `anonymous set` must fail the stack: it is the line
# TestAnonymousGetIsForbidden exists to protect, and `|| true` made this
# script's exit code unconditionally 0 -- so nothing downstream could ever
# observe a failed policy apply.
mc mb -p "local/${BUCKET}"
mc anonymous set none "local/${BUCKET}"
