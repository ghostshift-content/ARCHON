#!/usr/bin/env bash
# /root/scripts/telegram-doctor.sh — v2 with auto-heal
#
# Detects multiple Telegram-MCP failure modes and self-heals via tmux send-keys
# of /reload-plugins into the active claude pane. Falls back to Telegram alert
# (delivered through PM2-managed telegram-relay.js, which is independent of MCP)
# only when auto-heal fails or is impossible.
#
# Failure modes detected:
#   BROKEN_DEAD  — bot.pid empty OR PID dead (today's silent-bun-crash mode)
#   BROKEN_RACE  — last log line is "Channel notifications skipped..."
#                  (the github.com/anthropics/claude-code/issues/36411 bug)
#
# Recovery flow:
#   1. Discover the tmux pane whose pty matches the claude --channels process
#   2. Race protection: capture pane buffer twice with 1s delay; skip if changed
#   3. Mode protection: skip if user is in copy/scroll mode
#   4. tmux send-keys "/reload-plugins" Enter → wait 30s → verify
#   5. Verification: bot.pid alive AND fresh "registered" log line within 30s
#   6. If recovered → silent log "SELF-HEALED", no Telegram noise
#   7. If not → Telegram alert (only after 3 consecutive failures, to avoid spam)
#
# Anti-thrash safeguards:
#   - HEAL_COOLDOWN_SEC: max 1 heal attempt per 10 min per session
#   - FAILURE_THRESHOLD: 3 consecutive failures within FAILURE_WINDOW_SEC → stop
#                        attempting heal, switch to alert-only
#   - ALERT_COOLDOWN_SEC: max 1 Telegram alert per hour per session
#
# Flags:
#   --dry-run   : do everything except actually inject + send alert
#   --check     : detect state, log it, exit (never heal or alert)
#
# Cron: */5 * * * * /root/scripts/telegram-doctor.sh >> /tmp/telegram-doctor.log 2>&1

set -u

# ── Args ───────────────────────────────────────────────────────────────
DRY_RUN=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --check)   CHECK_ONLY=1 ;;
  esac
done

# ── Config ─────────────────────────────────────────────────────────────
JAY_CHAT_ID=487977821

LOG_DIRS=(
  /root/.cache/claude-cli-nodejs/-root/mcp-logs-plugin-telegram-telegram
  /root/.cache/claude-cli-nodejs/-root-agents/mcp-logs-plugin-telegram-telegram
  /root/.cache/claude-cli-nodejs/-root-mission-control/mcp-logs-plugin-telegram-telegram
)
STATE_FILE=/root/.cache/telegram-doctor-state
PANE_CACHE=/root/.cache/telegram-doctor-pane
OUTBOX_DIR=/root/intel/telegram-outbox
BOT_PID_FILE=/root/.claude/channels/telegram/bot.pid

STALE_LOG_THRESHOLD_SEC=1800   # 30 min: log inactivity = no active session
HEAL_COOLDOWN_SEC=600          # 10 min between heal attempts
ALERT_COOLDOWN_SEC=3600        # 1 hour between Telegram alerts per session
FAILURE_WINDOW_SEC=3600        # 1 hour window for the 3-strike rule
FAILURE_THRESHOLD=3            # 3 failed heals → stop attempting, alert only

now=$(date +%s)
ts() { date -u +%FT%TZ; }
log_line() { echo "[$(ts)] $1"; }

# ── State load/save ────────────────────────────────────────────────────
load_state() {
  prev_session=""
  prev_alert_ts=0
  last_heal_ts=0
  heal_failures=0
  failure_window_start=0
  if [ -f "$STATE_FILE" ]; then
    prev_session=$(awk -F= '/^session=/{print $2}' "$STATE_FILE" 2>/dev/null)
    prev_alert_ts=$(awk -F= '/^alert_ts=/{print $2}' "$STATE_FILE" 2>/dev/null)
    last_heal_ts=$(awk -F= '/^last_heal_ts=/{print $2}' "$STATE_FILE" 2>/dev/null)
    heal_failures=$(awk -F= '/^heal_failures=/{print $2}' "$STATE_FILE" 2>/dev/null)
    failure_window_start=$(awk -F= '/^failure_window_start=/{print $2}' "$STATE_FILE" 2>/dev/null)
  fi
  prev_alert_ts=${prev_alert_ts:-0}
  last_heal_ts=${last_heal_ts:-0}
  heal_failures=${heal_failures:-0}
  failure_window_start=${failure_window_start:-0}
}

save_state() {
  {
    echo "session=$session_id"
    echo "alert_ts=$prev_alert_ts"
    echo "last_heal_ts=$last_heal_ts"
    echo "heal_failures=$heal_failures"
    echo "failure_window_start=$failure_window_start"
    echo "log=$newest_log"
    echo "updated_at=$now"
  } > "$STATE_FILE"
}

# ── Find newest .jsonl across all log dirs ─────────────────────────────
find_newest_log() {
  newest_log=""
  newest_mtime=0
  for d in "${LOG_DIRS[@]}"; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)
      if [ "$mt" -gt "$newest_mtime" ]; then
        newest_mtime=$mt
        newest_log=$f
      fi
    done < <(find "$d" -maxdepth 1 -name '*.jsonl' 2>/dev/null)
  done
}

# ── Detect MCP state → echoes one of: HEALTHY|BROKEN_RACE|BROKEN_DEAD|IDLE|NO_LOG
detect_state() {
  if [ -z "$newest_log" ]; then echo "NO_LOG"; return; fi
  local age=$((now - newest_mtime))
  if [ "$age" -gt "$STALE_LOG_THRESHOLD_SEC" ]; then echo "IDLE"; return; fi

  # Signal 1: bot.pid health
  local pid_val=""
  [ -f "$BOT_PID_FILE" ] && pid_val=$(cat "$BOT_PID_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$pid_val" ]; then echo "BROKEN_DEAD"; return; fi
  if ! kill -0 "$pid_val" 2>/dev/null; then echo "BROKEN_DEAD"; return; fi
  if ! ps -p "$pid_val" -o cmd= 2>/dev/null | grep -q "bun"; then
    echo "BROKEN_DEAD"; return
  fi

  # Signal 2: last channel-notification log line
  local last_chan
  last_chan=$(grep -aoE 'Channel notifications (registered|skipped)' "$newest_log" 2>/dev/null | tail -1)
  if [ -z "$last_chan" ]; then echo "IDLE"; return; fi
  if [ "$last_chan" = "Channel notifications skipped" ]; then echo "BROKEN_RACE"; return; fi

  echo "HEALTHY"
}

# ── Discover the tmux pane running claude --channels ───────────────────
discover_pane() {
  if ! command -v tmux >/dev/null 2>&1; then
    log_line "PANE: tmux not installed"
    echo ""; return
  fi

  # Try cached pane first — re-validate it still exists
  if [ -f "$PANE_CACHE" ]; then
    local cached
    cached=$(cat "$PANE_CACHE" 2>/dev/null)
    if [ -n "$cached" ] && tmux display -p -t "$cached" "#{pane_tty}" >/dev/null 2>&1; then
      echo "$cached"; return
    fi
  fi

  # Find the claude --channels CLI process
  local claude_pid
  claude_pid=$(pgrep -af 'claude.*--channels plugin:telegram' | grep -v 'grep\|telegram-doctor' | head -1 | awk '{print $1}')
  if [ -z "$claude_pid" ]; then
    log_line "PANE: no 'claude --channels plugin:telegram' process found"
    echo ""; return
  fi

  local claude_tty
  claude_tty=$(ps -p "$claude_pid" -o tty= 2>/dev/null | tr -d '[:space:]')
  if [ -z "$claude_tty" ]; then
    log_line "PANE: claude PID $claude_pid has no tty"
    echo ""; return
  fi

  # tmux exposes pane_tty as /dev/pts/N; ps -o tty shows pts/N
  local pane
  pane=$(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_tty}' 2>/dev/null \
    | awk -v t="/dev/$claude_tty" '$2 == t {print $1; exit}')

  if [ -n "$pane" ]; then
    echo "$pane" > "$PANE_CACHE"
  fi
  echo "$pane"
}

# ── Attempt heal: returns 0 if injection sent, 1 if aborted ────────────
attempt_heal() {
  local pane="$1"
  if [ -z "$pane" ]; then
    log_line "HEAL: no pane available, cannot inject"
    return 1
  fi

  # Mode protection: skip if user is in copy/scroll mode
  local mode
  mode=$(tmux display -p -t "$pane" "#{pane_in_mode}" 2>/dev/null)
  if [ "$mode" = "1" ]; then
    log_line "HEAL: pane $pane in copy/scroll mode, skipping"
    return 1
  fi

  # Race protection: hash-compare buffer twice with 1s delay
  local hash1 hash2
  hash1=$(tmux capture-pane -p -t "$pane" 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [ -z "$hash1" ]; then
    log_line "HEAL: pane $pane not capturable"
    return 1
  fi
  sleep 1
  hash2=$(tmux capture-pane -p -t "$pane" 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [ "$hash1" != "$hash2" ]; then
    log_line "HEAL: pane $pane has activity (hash changed in 1s), skipping injection — will retry next tick"
    return 1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_line "HEAL [DRY-RUN]: would inject /reload-plugins into pane $pane"
    return 0
  fi

  log_line "HEAL: injecting /reload-plugins into pane $pane"
  tmux send-keys -t "$pane" "/reload-plugins" Enter
  return 0
}

# ── Verify recovery: returns 0 on success, 1 on failure ────────────────
verify_recovery() {
  log_line "VERIFY: waiting 30s for CC to process /reload-plugins"
  sleep 30

  # Check bot.pid populated + alive
  local pid_val=""
  [ -f "$BOT_PID_FILE" ] && pid_val=$(cat "$BOT_PID_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$pid_val" ] || ! kill -0 "$pid_val" 2>/dev/null; then
    log_line "VERIFY: FAIL — bot.pid still empty or PID dead after heal"
    return 1
  fi

  # Check fresh "registered" line written recently (within 60s of now)
  find_newest_log
  local now_local
  now_local=$(date +%s)
  local ts_str
  ts_str=$(grep -aoE '"Channel notifications registered"[^}]*"timestamp":"[^"]+"' "$newest_log" 2>/dev/null \
    | tail -1 | grep -oE '"timestamp":"[^"]+"' | sed 's/.*"timestamp":"\([^"]*\)".*/\1/')
  if [ -z "$ts_str" ]; then
    log_line "VERIFY: FAIL — no 'Channel notifications registered' line found in $newest_log"
    return 1
  fi
  local ts_epoch age
  ts_epoch=$(date -d "$ts_str" +%s 2>/dev/null)
  age=$((now_local - ts_epoch))
  if [ "$age" -gt 60 ]; then
    log_line "VERIFY: FAIL — most recent 'registered' is ${age}s old (>60s threshold)"
    return 1
  fi

  log_line "VERIFY: SUCCESS — bot.pid=$pid_val alive, fresh 'registered' at $ts_str (${age}s ago)"
  return 0
}

# ── Send Telegram alert via outbox ─────────────────────────────────────
send_alert() {
  local reason="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    log_line "ALERT [DRY-RUN]: would send: $reason"
    return
  fi
  local alert_file="$OUTBOX_DIR/telegram-doctor-${now}.json"
  python3 - "$JAY_CHAT_ID" "$session_id" "$newest_log" "$reason" "$alert_file" <<'PY'
import json, sys
chat_id, session_id, newest_log, reason, alert_file = sys.argv[1:6]
text = (
    "WARNING: Telegram MCP auto-heal FAILED.\n\n"
    f"Reason: {reason}\n"
    f"Session: {session_id}\n"
    f"Log: {newest_log}\n\n"
    "Auto-heal tried /reload-plugins via tmux but recovery did not complete.\n"
    "Manual fix: switch to your tmux pane and type /reload-plugins.\n"
    "If still broken, restart Claude Code with `claude -r`.\n"
    "This alert will not repeat for 1 hour."
)
with open(alert_file, "w") as f:
    json.dump({"chat_id": int(chat_id), "text": text}, f)
PY
  log_line "ALERT written to $alert_file"
}

# ── Main ───────────────────────────────────────────────────────────────
load_state
find_newest_log
session_id=$(grep -ao '"sessionId":"[^"]*"' "$newest_log" 2>/dev/null | tail -1 | sed 's/.*"sessionId":"\([^"]*\)".*/\1/')
session_id=${session_id:-unknown}

state=$(detect_state)
log_line "DETECT state=$state session=$session_id log=${newest_log:-NONE}"

case "$state" in
  HEALTHY|IDLE|NO_LOG)
    if [ "$state" = "HEALTHY" ] && [ "$heal_failures" -gt 0 ]; then
      heal_failures=0; failure_window_start=0
      save_state
      log_line "RESET: heal_failures cleared after healthy detection"
    fi
    exit 0
    ;;
esac

if [ "$CHECK_ONLY" -eq 1 ]; then
  log_line "CHECK-ONLY: detected state=$state, would attempt heal (no action taken)"
  exit 1
fi

# Reset failure counter if window expired
if [ "$failure_window_start" -gt 0 ] && [ $((now - failure_window_start)) -gt "$FAILURE_WINDOW_SEC" ]; then
  log_line "RESET: failure window expired ($((now - failure_window_start))s ago), clearing"
  heal_failures=0; failure_window_start=0
fi

# 3-strike: stop attempting heal, switch to alert
if [ "$heal_failures" -ge "$FAILURE_THRESHOLD" ]; then
  log_line "STOP: $heal_failures consecutive heal failures — auto-heal disabled, alert-only"
  if [ "$prev_session" = "$session_id" ] && [ $((now - prev_alert_ts)) -lt "$ALERT_COOLDOWN_SEC" ]; then
    log_line "anti-spam: alert sent $((now - prev_alert_ts))s ago, suppressing"
  else
    send_alert "auto-heal disabled after $heal_failures consecutive failures (state=$state)"
    prev_alert_ts=$now
    save_state
  fi
  exit 1
fi

# Heal cooldown
elapsed=$((now - last_heal_ts))
if [ "$elapsed" -lt "$HEAL_COOLDOWN_SEC" ]; then
  log_line "anti-thrash: last heal attempt ${elapsed}s ago (<${HEAL_COOLDOWN_SEC}s), skipping"
  exit 0
fi

# Discover pane (cached or fresh)
pane=$(discover_pane)
log_line "PANE: discovered=${pane:-NONE}"

last_heal_ts=$now
[ "$failure_window_start" = "0" ] && failure_window_start=$now

if attempt_heal "$pane"; then
  if [ "$DRY_RUN" -eq 1 ]; then
    log_line "DRY-RUN complete — skipping verification"
    save_state
    exit 0
  fi
  if verify_recovery; then
    log_line "SELF-HEALED state=$state→HEALTHY (no Telegram alert sent)"
    heal_failures=0; failure_window_start=0
    save_state
    exit 0
  else
    heal_failures=$((heal_failures + 1))
    log_line "HEAL FAILED ($heal_failures/$FAILURE_THRESHOLD)"
    save_state
    exit 1
  fi
else
  log_line "HEAL aborted (pane unsafe or unavailable) — counter NOT incremented"
  save_state
  exit 0
fi
