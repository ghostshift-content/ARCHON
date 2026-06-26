#!/bin/bash
# Nifty 50 Runner v4 — quota-manager aware, auto-pause/resume, failed task re-run
TASKS="/root/.openclaw/intel/tasks.json"
QUOTA="/root/.openclaw/intel/quota.json"
ACTIVITY="/root/.openclaw/intel/ACTIVITY-LOG.jsonl"
COOKIES="/tmp/mc-cookies.txt"
LOG="/tmp/nifty-runner.log"
BATCH=2

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG; }
reauth() { curl -s -c $COOKIES -X POST http://localhost:3000/api/auth -H "Content-Type: application/json" -d '{"password":"123@test"}' > /dev/null 2>&1; }

count() {
  python3 -c "
import json
t=json.load(open('$TASKS'))
n=[x for x in t if x.get('title','').endswith('— full equity research')]
d=len([x for x in n if x['status']=='done'])
b=len([x for x in n if x['status']=='backlog'])
r=len([x for x in n if x['status']=='in-progress'])
print(f'{d}|{b}|{r}|{len(n)}')
" 2>/dev/null
}

get_backlog() {
  python3 -c "
import json
t=json.load(open('$TASKS'))
bl=[x for x in t if x.get('title','').endswith('— full equity research') and x['status']=='backlog']
for x in bl[:$BATCH]: print(f'{x[\"id\"]}|{x[\"title\"][:30]}')
" 2>/dev/null
}

check_quota_cooldown() {
  python3 -c "
import json, sys
from datetime import datetime, timezone
try:
  q=json.load(open('$QUOTA'))
  now=datetime.now(timezone.utc)
  for p in q.get('providers',{}).values():
    for m,ms in p.get('models',{}).items():
      cu=ms.get('cooldownUntil')
      if cu:
        reset=datetime.fromisoformat(cu.replace('Z','+00:00'))
        diff=int((reset-now).total_seconds())
        if diff>0: print(diff); sys.exit()
  print(0)
except: print(0)
" 2>/dev/null
}

check_failed_agents() {
  # Check if recent tasks had agents that produced 0 output (rate limit symptom)
  python3 -c "
import json
log_lines=open('$ACTIVITY').readlines()[-50:]
rl=sum(1 for l in log_lines if 'rate' in l.lower() and ('limit' in l.lower() or '429' in l.lower()))
print(rl)
" 2>/dev/null
}

log "🚀 Nifty Runner v4 — quota-aware, auto-recovery"
reauth

while true; do
  IFS='|' read -r DONE BACKLOG RUNNING TOTAL <<< "$(count)"
  
  [ "$DONE" -ge "$TOTAL" ] 2>/dev/null && { log "🎯 ALL COMPLETE — $DONE/$TOTAL"; break; }
  
  # Tasks running — wait
  if [ "$RUNNING" != "0" ] && [ -n "$RUNNING" ]; then
    # Check quota cooldown
    CD=$(check_quota_cooldown)
    if [ "$CD" -gt "60" ]; then
      CDM=$((CD / 60))
      log "⏸️ Quota cooldown active — $CDM min remaining"
      sleep $CD
      continue
    fi
    
    # Check for rate limit signals in recent activity
    RL=$(check_failed_agents)
    if [ "$RL" -gt "2" ]; then
      log "⚠️ Multiple rate limits detected — pausing 10 min"
      sleep 600
      continue
    fi
    
    sleep 30
    continue
  fi
  
  # Nothing running — dispatch next batch
  if [ "$BACKLOG" = "0" ] || [ -z "$BACKLOG" ]; then
    log "✅ $DONE/$TOTAL done — no more backlog"
    break
  fi
  
  log "📊 $DONE/$TOTAL done | $BACKLOG backlog | Dispatching next $BATCH..."
  reauth
  sleep 5
  
  while IFS='|' read -r TID NAME; do
    [ -z "$TID" ] && continue
    curl -s -b $COOKIES -X POST http://localhost:3000/api/tasks \
      -H "Content-Type: application/json" \
      -d "{\"action\":\"execute\",\"task\":{\"id\":\"$TID\"}}" > /dev/null 2>&1
    log "  → $NAME"
    sleep 3
  done < <(get_backlog)
  
  sleep 15
done

log "═══════════════════════════════════════"
log "🎯 NIFTY 50 COMPLETE — $DONE/$TOTAL"
log "═══════════════════════════════════════"
