#!/bin/bash
# Sequential stock dispatch — monitors completion and dispatches next task
# Usage: ./sequential-dispatch.sh

STOCKS=("ACC:1775570923804" "AXISBANK:1775570924041" "IRCTC:1775570924507" "MAHABANK:1775570924623" "NTPC:1775570924738" "PFC:1775570924932" "SILVERBEES:1775570925103" "TCS:1775570925508")
DISPATCH_FILE="/root/intel/dispatch-queue.json"
TASKS_FILE="/root/intel/tasks.json"

echo "🚀 Sequential Stock Dispatch — ${#STOCKS[@]} stocks"
echo "Order: ${STOCKS[*]}"
echo ""

for i in "${!STOCKS[@]}"; do
  IFS=':' read -r STOCK TASK_ID <<< "${STOCKS[$i]}"

  echo "[$((i+1))/${#STOCKS[@]}] Waiting for ${STOCK} (${TASK_ID}) to complete..."

  # Wait for current task to be done
  while true; do
    STATUS=$(python3 -c "
import json
t = next((t for t in json.load(open('${TASKS_FILE}')) if t['id'] == '${TASK_ID}'), None)
print(t['status'] if t else 'not_found')
" 2>/dev/null)

    if [ "$STATUS" = "done" ]; then
      GRADE=$(python3 -c "
import json
t = next((t for t in json.load(open('${TASKS_FILE}')) if t['id'] == '${TASK_ID}'), None)
print(t.get('grade',{}).get('passRate','—') if t else '—')
" 2>/dev/null)
      echo "  ✅ ${STOCK} done! Grade: ${GRADE}%"
      /root/agents/scripts/notify-completion.sh "${STOCK}" "${TASK_ID}" "done" "${GRADE}"
      break
    fi
    sleep 30
  done

  # Dispatch next task if there is one
  NEXT_IDX=$((i+1))
  if [ $NEXT_IDX -lt ${#STOCKS[@]} ]; then
    IFS=':' read -r NEXT_STOCK NEXT_ID <<< "${STOCKS[$NEXT_IDX]}"
    echo "  📋 Dispatching next: ${NEXT_STOCK} (${NEXT_ID})"

    node -e "
const fs = require('fs');
const queue = JSON.parse(fs.readFileSync('${DISPATCH_FILE}', 'utf-8'));
if (!queue.some(d => d.taskId === '${NEXT_ID}' && d.status === 'pending')) {
  queue.push({
    id: 'dispatch-${NEXT_STOCK,,}-' + Date.now(),
    taskId: '${NEXT_ID}',
    taskTitle: '${NEXT_STOCK} Full Stock Analysis',
    assignee: 'CHANAKYA',
    squad: 'stocks-squad',
    priority: 'high',
    status: 'pending',
    retryCount: 0,
    createdAt: new Date().toISOString(),
    goal: 'Full institutional-grade equity research on ${NEXT_STOCK} (NSE: ${NEXT_STOCK}). Cover all 20 sections.'
  });
  fs.writeFileSync('${DISPATCH_FILE}', JSON.stringify(queue, null, 2));
  console.log('Dispatched: ${NEXT_STOCK}');
}
"
  fi
done

echo ""
echo "🎉 All ${#STOCKS[@]} stocks completed!"
