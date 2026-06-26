#!/bin/bash
# Notify Jay on Telegram when a stock task completes
# Called by sequential-dispatch.sh or can run standalone

STOCK="$1"
TASK_ID="$2"
STATUS="$3" # done or failed
GRADE="$4"

BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN /root/.claude/channels/telegram/.env | cut -d= -f2)
CHAT_ID="487977821"

if [ "$STATUS" = "done" ]; then
    MSG="✅ ${STOCK} analysis complete! Grade: ${GRADE:-pending}%
Dashboard: https://agent.n8nn8n.com/tasks"
else
    MSG="❌ ${STOCK} analysis failed after retries.
Check dashboard for details."
fi

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${MSG}" > /dev/null 2>&1
