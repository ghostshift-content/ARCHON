#!/usr/bin/env bash
# /root/agents/scripts/kurukshetra-verify-loop.sh
#
# Ralph-pattern continuous verification loop for kurukshetra.
# Cron: */30 * * * * bash /root/agents/scripts/kurukshetra-verify-loop.sh
#
# Runs every 30 min:
#   1. bun test (full test suite, baseline 35/36 passing)
#   2. verify-framework (baseline 54/55 GATEs passing)
#   3. PM2 daemon health (event-bus, mc, supervisor, telegram-relay)
#
# Alert path: writes JSON to /root/intel/telegram-outbox/ on regression.
# Telegram-relay (independent of MCP) delivers the alert.
#
# Baseline (acceptable state — DO NOT alert if these match):
#   - Tests: 35 passed, 1 stale-known-fail (network-dispatcher chainVerifier-deps)
#   - GATEs: 54/55 (GATE-55 skip-pass for legacy reports)
#
# Regression triggers alert:
#   - Test pass count drops below 35
#   - GATE pass count drops below 54
#   - Any PM2 daemon goes offline

set -u

JAY_CHAT_ID=487977821
WORK_DIR=/root/agents
STATE_FILE=/tmp/kurukshetra-verify-state
OUTBOX=/root/intel/telegram-outbox
LOG=/tmp/kurukshetra-verify.log

ts() { date -u +%FT%TZ; }
log_line() { echo "[$(ts)] $1" | tee -a "$LOG" >/dev/null; }

cd "$WORK_DIR" || { log_line "ERROR: cannot cd to $WORK_DIR"; exit 1; }

# ── 1. Run tests ──
log_line "RUN: bun test"
test_pass=0
test_fail=0
for f in test/*.test.js; do
  out=$(timeout 30 /root/.bun/bin/bun test "$f" 2>&1 | tail -3)
  if echo "$out" | grep -qE "0 (failed|fail)"; then
    test_pass=$((test_pass + 1))
  elif echo "$out" | grep -qE "[1-9][0-9]* (failed|fail)"; then
    test_fail=$((test_fail + 1))
  fi
done

log_line "TEST: $test_pass passed, $test_fail failed"

# ── 2. Run verify-framework ──
gate_summary=$(timeout 60 node verify-framework.js 2>&1 | grep -oE 'RESULT: [0-9]+/[0-9]+ gates passed' | head -1)
log_line "GATE: $gate_summary"
gate_pass=$(echo "$gate_summary" | grep -oE '[0-9]+/[0-9]+' | cut -d'/' -f1)
gate_total=$(echo "$gate_summary" | grep -oE '[0-9]+/[0-9]+' | cut -d'/' -f2)

# ── 3. PM2 daemon health ──
daemons_online=$(pm2 list 2>/dev/null | grep -cE '\bonline\b')
log_line "PM2: $daemons_online daemons online"

# ── 4. Compare against baseline + alert on regression ──
BASELINE_TESTS=35
BASELINE_GATES=54
BASELINE_DAEMONS=4

regression=""
if [ "$test_pass" -lt "$BASELINE_TESTS" ]; then
  regression+="tests dropped to $test_pass (baseline $BASELINE_TESTS); "
fi
if [ -n "$gate_pass" ] && [ "$gate_pass" -lt "$BASELINE_GATES" ]; then
  regression+="GATEs dropped to $gate_pass/$gate_total (baseline $BASELINE_GATES); "
fi
if [ "$daemons_online" -lt "$BASELINE_DAEMONS" ]; then
  regression+="only $daemons_online PM2 daemons online (baseline $BASELINE_DAEMONS); "
fi

now=$(date +%s)

# Anti-spam: only alert once per hour for same regression
if [ -n "$regression" ]; then
  prev_alert_ts=0
  prev_msg=""
  if [ -f "$STATE_FILE" ]; then
    prev_alert_ts=$(awk -F= '/^alert_ts=/{print $2}' "$STATE_FILE" 2>/dev/null)
    prev_msg=$(awk -F= '/^last_msg=/{print $2}' "$STATE_FILE" 2>/dev/null)
  fi
  prev_alert_ts=${prev_alert_ts:-0}
  cooldown=3600
  elapsed=$((now - prev_alert_ts))

  if [ "$prev_msg" != "$regression" ] || [ "$elapsed" -ge "$cooldown" ]; then
    log_line "REGRESSION: $regression"
    alert_file="$OUTBOX/kurukshetra-verify-regression-${now}.json"
    python3 -c "
import json
text = '''⚠️ Kurukshetra verify-loop REGRESSION

$regression

Tests: $test_pass / 36 passed
GATEs: $gate_pass / $gate_total passed
Daemons online: $daemons_online / 4

Run: bash /root/agents/scripts/kurukshetra-verify-loop.sh
Log: $LOG
'''
import os
with open('$alert_file', 'w') as f:
    json.dump({'chat_id': $JAY_CHAT_ID, 'text': text}, f)
"
    {
      echo "alert_ts=$now"
      echo "last_msg=$regression"
    } > "$STATE_FILE"
    log_line "ALERT written to $alert_file"
  else
    log_line "anti-spam: same regression alerted ${elapsed}s ago, suppressing"
  fi
else
  log_line "OK: tests=$test_pass GATEs=$gate_pass/$gate_total daemons=$daemons_online"
  # Clear stale alert state on full healthy
  > "$STATE_FILE"
fi

exit 0
