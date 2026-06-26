#!/bin/bash
# DEPRECATED 2026-04-21. Do not use.
# - Reads from /root/.openclaw/intel/ (abandoned path — current intel lives in /root/intel/).
# - Hardcoded 'anthropic/claude-sonnet-4-6' in dispatch payload, which bypasses
#   modelRouter and forces CHANAKYA onto sonnet instead of Opus 4.7. This is the
#   exact shadow-routing class of bug we eliminated elsewhere.
# - Not referenced by cron, systemd, or pm2 (verified 2026-04-21) — no live callers.
# If you need batch stocks dispatch, use mission-control UI or drop entries directly
# into /root/intel/dispatch-queue.json with NO `model` field so modelRouter decides.
echo "auto-dispatch-stocks.sh is deprecated. See the header comment for what replaced it." >&2
exit 1
