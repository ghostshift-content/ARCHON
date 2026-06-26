#!/bin/bash
# Generate missing dossiers 2 at a time

MISSING=$(python3 -c "
import json
data = json.load(open('/tmp/missing-dossiers.json'))
for d in data:
    print(f\"{d['id']}|{d['name']}|{d['title']}|{d['projectId']}\")
")

count=0
total=$(echo "$MISSING" | wc -l)
pids=()

while IFS='|' read -r TASK_ID NAME TITLE PROJECT_ID; do
    count=$((count + 1))
    echo "[$(date +%H:%M)] ($count/$total) Generating dossier: $NAME"
    
    PROMPT="You are CHANAKYA, CIO. Write a COMPLETE Final Dossier for: $TITLE. TaskID: $TASK_ID.

STEP 1: Read all analyst findings for this task:
grep '$TASK_ID' /root/.openclaw/intel/ACTIVITY-LOG.jsonl | grep -v NEXUS | grep -v 'Quality Score' | grep -v 'Cost:' | grep -v 'Auto-repair' | grep -v 'Auto-recovery'

STEP 2: Read your skill file for the golden template:
cat /root/agents/chanakya/skills/stock-analysis/SKILL.md

STEP 3: Write a COMPLETE 20-section Final Dossier. ALL sections required:
1. Executive Summary 2. Company Snapshot 3. Business Model 4. Industry Structure
5. Competitive Moat 6. Management Quality 7. Financial Quality 8. Valuation
9. Technical Analysis 10. Scuttlebutt Intel 11. Earnings Call Intel 12. Innovation
13. Momentum & Flow 14. Risk Map 15. Bull/Base/Bear Scenarios 16. Investment Thesis
17. Anti-Thesis 18. What Would Change Our Mind 19. Monitoring Checklist 20. Final Decision

MUST INCLUDE: confidence levels (HIGH/MEDIUM/LOW), specific INR prices, RSI value, 52-week high/low, FII/DII data, CVSS-style risk score, sentiment score, overvaluation/undervaluation statement, anti-thesis, ESG notes, monitoring KPIs.

Write the dossier as ONE JSON entry:
echo '{\"ts\":\"'\$(date -u +%Y-%m-%dT%H:%M:%SZ)'\",\"agent\":\"CHANAKYA\",\"action\":\"Final Dossier [v3.0-golden] — $TITLE\",\"details\":\"YOUR_FULL_DOSSIER_HERE\",\"taskId\":\"$TASK_ID\",\"projectId\":\"$PROJECT_ID\",\"squad\":\"stocks-squad\"}' >> /root/.openclaw/intel/ACTIVITY-LOG.jsonl

Execute now. Read files first, then write."

    openclaw agent --agent chanakya --session-id "dossier-$TASK_ID" --message "$PROMPT" --json > /tmp/dossier-$TASK_ID.log 2>&1 &
    pids+=($!)
    
    # Run 2 at a time
    if [ ${#pids[@]} -ge 2 ]; then
        for pid in "${pids[@]}"; do
            wait $pid
        done
        pids=()
        echo "[$(date +%H:%M)] Batch complete, checking..."
    fi
    
done <<< "$MISSING"

# Wait for remaining
for pid in "${pids[@]}"; do
    wait $pid
done

echo "[$(date +%H:%M)] ALL DONE"
