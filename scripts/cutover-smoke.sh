#!/usr/bin/env bash
#
# Cutover smoke: drive one observation through every stage of the pipeline and
# assert each one in order.
#
# This is the gate before traffic resumes in the maintenance window. The deploy
# script's own smoke cannot serve that purpose: it reads `.group_id` from the
# ingest response and polls it as an incident id, but that field now carries the
# capture handle (a raw fingerprint, not a UUID), and a single event never
# reaches a terminal worker state because the filter admits at two affected
# units. Run this instead, with SKIP_SMOKE=1 on the deploy.
#
# Required:
#   INGESTION_URL     e.g. https://app.opslane.com
#   DATABASE_URL      a DSN that can read the pipeline tables
#   SMOKE_API_KEY     ingest key for SMOKE_PROJECT_ID
#   SMOKE_PROJECT_ID  project UUID
#
# Optional:
#   SMOKE_TIMEOUT      seconds to wait per stage (default 180)
#   DIGEST_REPLAY_CMD  how to invoke cmd/digest-replay (default: go run ...)
#
# Exit 0 only when every stage passed.

set -euo pipefail

readonly INGESTION_URL="${INGESTION_URL:?INGESTION_URL is required}"
readonly DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
readonly SMOKE_API_KEY="${SMOKE_API_KEY:?SMOKE_API_KEY is required}"
readonly SMOKE_PROJECT_ID="${SMOKE_PROJECT_ID:?SMOKE_PROJECT_ID is required}"
readonly SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-180}"
readonly DIGEST_REPLAY_CMD="${DIGEST_REPLAY_CMD:-go run ./packages/ingestion/cmd/digest-replay}"

for command_name in curl jq psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 1
  }
done

STAGE=0
stage() {
  STAGE=$((STAGE + 1))
  printf '\n[%d/7] %s\n' "$STAGE" "$1"
}
fail() {
  printf 'FAIL at stage %d: %s\n' "$STAGE" "$1" >&2
  exit 1
}

# query runs one read and returns a single value with no decoration.
query() {
  psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

# await polls one scalar query until it equals the expected value.
await() {
  local description="$1" sql="$2" want="$3" deadline got
  deadline=$(( $(date +%s) + SMOKE_TIMEOUT ))
  while :; do
    got="$(query "$sql")"
    if [[ "$got" == "$want" ]]; then
      echo "  ok: $description"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      fail "$description (last value: '${got}', wanted '${want}')"
    fi
    sleep 3
  done
}

MARKER="cutover-smoke-$(date +%s)-$$"
readonly MARKER

# ---------------------------------------------------------------------------

stage "an event is accepted and returns a capture handle"

# Two distinct users on purpose. The cheap filter admits at two affected units
# in seven days (admitUnits in packages/ingestion/filter/evaluate.go), so a
# single observation parks at 'watch' and stages four onward never run. This is
# the smallest input that exercises the whole pipeline.
post_event() {
  local user_id="$1" session_id="$2"
  jq -n \
    --arg marker "$MARKER" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg user "$user_id" \
    --arg session "$session_id" \
    '{
      timestamp: $timestamp,
      session_id: $session,
      error: {
        type: "CutoverSmokeError",
        message: $marker,
        stack: ("CutoverSmokeError: " + $marker + "\n    at cutoverSmoke (cutover-smoke.sh:1:1)")
      },
      breadcrumbs: [],
      context: {source: "cutover-smoke", user: {id: $user}},
      sdk_version: "cutover-smoke"
    }' |
    curl -fsS -X POST "${INGESTION_URL}/api/v1/events" \
      -H "X-API-Key: ${SMOKE_API_KEY}" \
      -H "Content-Type: application/json" \
      --data @-
}

FIRST_RESPONSE="$(post_event "cutover-smoke-user-1" "cutover-smoke-session-1")"
post_event "cutover-smoke-user-2" "cutover-smoke-session-2" >/dev/null

CAPTURE_HANDLE="$(jq -er '.group_id' <<<"$FIRST_RESPONSE")"
[[ -n "$CAPTURE_HANDLE" && "$CAPTURE_HANDLE" != "null" ]] ||
  fail "ingest returned no capture handle: $FIRST_RESPONSE"
echo "  ok: capture handle ${CAPTURE_HANDLE}"

await "both observations are stored" \
  "SELECT count(*) FROM error_events
    WHERE project_id='${SMOKE_PROJECT_ID}' AND error_message='${MARKER}'" \
  "2"

EVENT_IDS="SELECT id FROM error_events
             WHERE project_id='${SMOKE_PROJECT_ID}' AND error_message='${MARKER}'"

# ---------------------------------------------------------------------------

stage "its resolution row reaches a terminal status"

# Settlement only proceeds from 'resolved' or 'no_map'. 'failed' is terminal for
# the resolver but would strand identity, so it is not accepted here.
await "resolution is settleable" \
  "SELECT count(*) FROM error_event_resolutions
    WHERE project_id='${SMOKE_PROJECT_ID}'
      AND event_id IN (${EVENT_IDS})
      AND status IN ('resolved','no_map')" \
  "2"

# ---------------------------------------------------------------------------

stage "its identity settles to a canonical issue"

await "identities are settled" \
  "SELECT count(*) FROM error_event_identities
    WHERE project_id='${SMOKE_PROJECT_ID}'
      AND event_id IN (${EVENT_IDS})
      AND status='settled' AND canonical_issue_id IS NOT NULL" \
  "2"

await "both observations settled onto one issue" \
  "SELECT count(DISTINCT canonical_issue_id) FROM error_event_identities
    WHERE project_id='${SMOKE_PROJECT_ID}' AND event_id IN (${EVENT_IDS})" \
  "1"

EPISODE_ID="$(query "SELECT DISTINCT episode_id FROM error_event_identities
                      WHERE project_id='${SMOKE_PROJECT_ID}'
                        AND event_id IN (${EVENT_IDS})")"
[[ -n "$EPISODE_ID" ]] || fail "settled identity carries no episode"
echo "  ok: episode ${EPISODE_ID}"

# ---------------------------------------------------------------------------

stage "the filter writes a decision"

await "a filter decision exists" \
  "SELECT count(*) > 0 FROM issue_decisions
    WHERE project_id='${SMOKE_PROJECT_ID}' AND episode_id='${EPISODE_ID}'" \
  "t"

FILTER_DECISION="$(query "SELECT decision FROM issue_decisions
                           WHERE project_id='${SMOKE_PROJECT_ID}'
                             AND episode_id='${EPISODE_ID}'
                           ORDER BY decided_at DESC, id DESC LIMIT 1")"
FILTER_REASON="$(query "SELECT reason FROM issue_decisions
                         WHERE project_id='${SMOKE_PROJECT_ID}'
                           AND episode_id='${EPISODE_ID}'
                         ORDER BY decided_at DESC, id DESC LIMIT 1")"
echo "  filter: ${FILTER_DECISION} (${FILTER_REASON})"

# Two distinct users in scope must clear the bar. Anything else means the filter
# or the project's action scope is misconfigured, and the pipeline would stall
# here for real traffic too.
[[ "$FILTER_DECISION" == "open_inquiry" ]] ||
  fail "filter did not admit two affected users: ${FILTER_DECISION} (${FILTER_REASON})"

# ---------------------------------------------------------------------------

stage "a qualified episode reaches an inquiry decision"

await "an inquiry decision exists" \
  "SELECT count(*) > 0 FROM issue_inquiry_decisions
    WHERE project_id='${SMOKE_PROJECT_ID}' AND episode_id='${EPISODE_ID}'" \
  "t"

INQUIRY_DECISION="$(query "SELECT decision FROM issue_inquiry_decisions
                            WHERE project_id='${SMOKE_PROJECT_ID}'
                              AND episode_id='${EPISODE_ID}'
                            ORDER BY decided_at DESC, id DESC LIMIT 1")"
INQUIRY_REASON="$(query "SELECT reason FROM issue_inquiry_decisions
                          WHERE project_id='${SMOKE_PROJECT_ID}'
                            AND episode_id='${EPISODE_ID}'
                          ORDER BY decided_at DESC, id DESC LIMIT 1")"
echo "  inquiry: ${INQUIRY_DECISION} (${INQUIRY_REASON})"

# The verdict itself is not asserted. The inquiry asks a model whether this is a
# real product problem, and declining a synthetic error is a correct answer. What
# the gate proves is that the stage ran and committed a decision.

# ---------------------------------------------------------------------------

stage "an accepted episode creates exactly one investigation"

INVESTIGATIONS="SELECT count(*) FROM error_group_jobs
                 WHERE project_id='${SMOKE_PROJECT_ID}'
                   AND episode_id='${EPISODE_ID}'
                   AND job_type='investigate'"

if [[ "$INQUIRY_DECISION" == "investigate" ]]; then
  await "exactly one investigation was created" "$INVESTIGATIONS" "1"
else
  # A declined episode must create none. Handing work to the investigator
  # without an accepted inquiry is the failure this half guards against.
  [[ "$(query "$INVESTIGATIONS")" == "0" ]] ||
    fail "inquiry returned '${INQUIRY_DECISION}' but an investigation was created anyway"
  echo "  ok: declined episode created no investigation"
fi

# ---------------------------------------------------------------------------

stage "a digest run freezes, validates, and delivers"

# The sweeper runs on the daily boundary, which the window cannot wait for, so
# drive one run directly. Same code path, explicit timestamp.
BOUNDARY="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
$DIGEST_REPLAY_CMD -project "$SMOKE_PROJECT_ID" -freeze -at "$BOUNDARY" ||
  fail "freezing a digest run failed"

RUN_ID="$(query "SELECT id FROM digest_runs
                  WHERE project_id='${SMOKE_PROJECT_ID}'
                  ORDER BY created_at DESC LIMIT 1")"
[[ -n "$RUN_ID" ]] || fail "no digest run was frozen"
echo "  ok: run ${RUN_ID} frozen"

await "the run is written" \
  "SELECT status IN ('written','validated','delivered') FROM digest_runs WHERE id='${RUN_ID}'" \
  "t"

$DIGEST_REPLAY_CMD -project "$SMOKE_PROJECT_ID" -publish -run "$RUN_ID" ||
  fail "validating and publishing the digest run failed"

await "the run is delivered" \
  "SELECT status FROM digest_runs WHERE id='${RUN_ID}'" \
  "delivered"

printf '\ncutover smoke passed: all 7 stages\n'
