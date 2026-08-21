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
#   SMOKE_QUERY_TIMEOUT       seconds before one read is abandoned (default 30)
#   SMOKE_ALLOW_DECLINED_INQUIRY=1  pass even if the inquiry declines, leaving
#                                   the investigator handoff unproven
#   DIGEST_REPLAY_CMD  how to invoke cmd/digest-replay (default: go run ...)
#
# Exit 0 only when every stage passed.

set -euo pipefail

readonly INGESTION_URL="${INGESTION_URL:?INGESTION_URL is required}"
readonly DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
readonly SMOKE_API_KEY="${SMOKE_API_KEY:?SMOKE_API_KEY is required}"
readonly SMOKE_PROJECT_ID="${SMOKE_PROJECT_ID:?SMOKE_PROJECT_ID is required}"
readonly SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-180}"
readonly SMOKE_QUERY_TIMEOUT="${SMOKE_QUERY_TIMEOUT:-30}"
# A model declining a synthetic error is a legitimate answer, but then stage 6
# never exercises the handoff to the investigator. Set this to accept that and
# still exit 0, knowing the accepted path went unproven.
readonly SMOKE_ALLOW_DECLINED_INQUIRY="${SMOKE_ALLOW_DECLINED_INQUIRY:-0}"
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

# query runs one read and returns a single value with no decoration. The outer
# timeout is what makes SMOKE_TIMEOUT real: without it a wedged connection blocks
# inside psql and the deadline below is never even evaluated.
query() {
  timeout "$SMOKE_QUERY_TIMEOUT" psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

# await polls one scalar query until it equals the expected value.
await() {
  local description="$1" sql="$2" want="$3" deadline got
  deadline=$(( $(date +%s) + SMOKE_TIMEOUT ))
  while :; do
    # A failed read must not trip `set -e`: that would kill the script without
    # naming the stage. Keep polling and let the deadline report it.
    got="$(query "$sql" || true)"
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

# One row, one round trip. Reading decision and reason separately could pair a
# decision with a different row's reason if another lands between the two reads.
FILTER_ROW="$(query "SELECT decision || '|' || reason FROM issue_decisions
                      WHERE project_id='${SMOKE_PROJECT_ID}'
                        AND episode_id='${EPISODE_ID}'
                      ORDER BY decided_at DESC, id DESC LIMIT 1")"
FILTER_DECISION="${FILTER_ROW%%|*}"
FILTER_REASON="${FILTER_ROW#*|}"
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

INQUIRY_ROW="$(query "SELECT decision || '|' || reason FROM issue_inquiry_decisions
                       WHERE project_id='${SMOKE_PROJECT_ID}'
                         AND episode_id='${EPISODE_ID}'
                       ORDER BY decided_at DESC, id DESC LIMIT 1")"
INQUIRY_DECISION="${INQUIRY_ROW%%|*}"
INQUIRY_REASON="${INQUIRY_ROW#*|}"
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

  # Passing here would be a false pass. The negative half held, but the handoff
  # to the investigator, which is what the window actually needs proven, was
  # never exercised. Say so rather than printing a green line.
  if [[ "$SMOKE_ALLOW_DECLINED_INQUIRY" != "1" ]]; then
    fail "the inquiry declined this observation, so the accepted path was never run.
  Nothing here proves an accepted episode reaches the investigator. Re-run, or set
  SMOKE_ALLOW_DECLINED_INQUIRY=1 to accept the gate with that path unproven."
  fi
  echo "  WARNING: accepted path unproven (SMOKE_ALLOW_DECLINED_INQUIRY=1)" >&2
fi

# ---------------------------------------------------------------------------

stage "a digest run freezes, validates, and delivers"

# The sweeper runs on the daily boundary, which the window cannot wait for, so
# drive one run directly. Same code path, explicit timestamp.
BOUNDARY="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FREEZE_OUTPUT="$($DIGEST_REPLAY_CMD -project "$SMOKE_PROJECT_ID" -freeze -at "$BOUNDARY")" ||
  fail "freezing a digest run failed"

# Take the id the freezer reports, not the newest row. digest_runs is unique per
# project and local date, so the freezer may hand back a run that already
# existed; picking "latest" could just as easily land on an unrelated project's
# newer run and assert against it.
RUN_ID="$(sed -n 's/^run=\([0-9a-f-]*\).*/\1/p' <<<"$FREEZE_OUTPUT")"
[[ -n "$RUN_ID" ]] || fail "could not read a run id from the freezer: ${FREEZE_OUTPUT}"

# If today's run was already delivered, both freeze and publish short-circuit and
# every assertion below passes without a single new write. That is the digest
# equivalent of a green light on a dead wire.
FROZEN_STATUS="$(query "SELECT status FROM digest_runs WHERE id='${RUN_ID}'")"
if [[ "$FROZEN_STATUS" == "delivered" ]]; then
  fail "today's digest run (${RUN_ID}) was already delivered before this smoke ran.
  Freezing and publishing are both no-ops now, so stage 7 would pass without
  writing or validating anything. Re-run after the next daily boundary."
fi
echo "  ok: run ${RUN_ID} at status ${FROZEN_STATUS}"

# Assert on the payload, not on the exact status. The daily sweeper runs in
# production and may validate or deliver this run between the freeze above and
# this read; demanding status='written' would then time out on a run that in fact
# succeeded. A non-null payload is the part that proves the writer ran.
await "the writer produced a payload" \
  "SELECT payload IS NOT NULL AND status IN ('written','validated','delivered')
     FROM digest_runs WHERE id='${RUN_ID}'" \
  "t"

$DIGEST_REPLAY_CMD -project "$SMOKE_PROJECT_ID" -publish -run "$RUN_ID" ||
  fail "validating and publishing the digest run failed"

await "the run is delivered" \
  "SELECT status FROM digest_runs WHERE id='${RUN_ID}'" \
  "delivered"

printf '\ncutover smoke passed: all 7 stages\n'
