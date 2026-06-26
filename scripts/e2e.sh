#!/usr/bin/env bash
# Run the browser e2e suites safely. The seeding suites write tasks.json and queue
# inbox actions, so the daemon (single writer + inbox consumer) is stopped first to
# avoid clobber / accidental VYASA runs, then restarted afterwards.
set +e
cd "$(dirname "$0")/.." || exit 1

echo "▸ stopping daemon for e2e (state seeding + inbox actions)…"
for pid in $(ps -eo pid,args | awk '/[n]ode [e]vent-bus/ {print $1}'); do kill -9 "$pid" 2>/dev/null; done
sleep 1
if ! ss -ltn 2>/dev/null | grep -q ':4000'; then
  echo "▸ starting dashboard…"; nohup node scripts/dashboard.js >/tmp/kuru-dashboard.log 2>&1 & sleep 2
fi

fail=0
for t in test/ui-findings.e2e.js test/ui-smoke.e2e.js test/ui-flows.e2e.js test/ui-engagement.e2e.js test/ui-whitebox.e2e.js; do
  echo "──── $t ────"
  node "$t" || fail=1
done

echo "▸ restarting daemon…"
nohup node event-bus.js >/tmp/kuru-daemon.log 2>&1 & sleep 3
[ "$fail" = 0 ] && echo "✅ e2e: all suites passed" || echo "❌ e2e: a suite failed"
exit $fail
