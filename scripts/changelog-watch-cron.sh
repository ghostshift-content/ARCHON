#!/bin/bash
# Daily SDK/binary/gate drift check (GATE-102 changelog-watcher).
# Runs breaks-only; on any alert, appends to /root/intel/changelog-alerts.jsonl and
# drops a telegram-outbox note so drift is SEEN, not silent. Cron-installed (see crontab).
set -uo pipefail
cd /root/agents || exit 0
LOG=/root/intel/changelog-watcher.log
ALERTS=/root/intel/changelog-alerts.jsonl
OUTBOX=/root/intel/telegram-outbox
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

OUT=$(timeout 180 node agents/changelog-watcher.js breaks-only 2>&1)
echo "[$TS] $(echo "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const bad=(j.breakChecks||[]).filter(r=>!r.ok);console.log("checks="+(j.breakChecks||[]).length+" failing="+bad.length+" alerts="+(j.alerts||[]).length)}catch{console.log("watcher-output-unparseable")}})')" >> "$LOG"

# Act on failures/alerts
echo "$OUT" | node -e '
const fs=require("fs");let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  let j; try{ j=JSON.parse(d) }catch{ process.exit(0) }
  const bad=(j.breakChecks||[]).filter(r=>!r.ok);
  const alerts=(j.alerts||[]);
  if(!bad.length && !alerts.length) process.exit(0);
  const ts=new Date().toISOString();
  const rec={ ts, failing: bad.map(r=>({name:r.name,message:r.message})), alerts };
  try{ fs.appendFileSync("'"$ALERTS"'", JSON.stringify(rec)+"\n") }catch{}
  // visible telegram note (relay picks up files in the outbox dir)
  try{
    fs.mkdirSync("'"$OUTBOX"'",{recursive:true});
    const msg="⚠️ ARCHON drift detected ("+ts+"): "+bad.map(r=>r.name).concat(alerts.map(a=>a.name||"alert")).join(", ");
    fs.writeFileSync("'"$OUTBOX"'/changelog-drift-"+Date.now()+".txt", msg);
  }catch{}
});
'
