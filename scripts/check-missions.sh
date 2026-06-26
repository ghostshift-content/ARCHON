#!/bin/bash
# Mission Control Task Checker
# Each agent runs this to check for new tasks

AGENT_NAME="${1:-UNKNOWN}"
TASKS_FILE="/root/.openclaw/intel/tasks.json"
ACTIVITY_LOG="/root/.openclaw/intel/ACTIVITY-LOG.jsonl"

# Check for tasks assigned to this agent
PENDING=$(python3 -c "
import json
with open('$TASKS_FILE') as f:
    tasks = json.load(f)
pending = [t for t in tasks if t.get('assignedTo','').upper() == '$AGENT_NAME'.upper() and t.get('status') in ('backlog','active','in-progress')]
for t in pending:
    print(f'{t[\"id\"]}|{t[\"title\"]}|{t[\"status\"]}')
" 2>/dev/null)

if [ -z "$PENDING" ]; then
    echo "[$AGENT_NAME] No pending tasks"
    exit 0
fi

echo "[$AGENT_NAME] Found tasks:"
echo "$PENDING"
