#!/bin/bash
# Midcap monitor - check every 10 min, send Telegram update, restart if down

TOKEN=$(python3 -c "import json; d=json.load(open('/root/.openclaw/openclaw.json')); print(d['channels']['telegram']['botToken'])")

while true; do
    # Check and restart dead services
    if ! ps aux | grep "node server.js" | grep -v grep > /dev/null; then
        cd /root/mission-control && NODE_ENV=production PORT=3000 nohup node server.js &>/tmp/sanjay.log &
        sleep 3
    fi
    if ! ps aux | grep "event-bus.js" | grep -v grep > /dev/null; then
        nohup node /root/agents/event-bus.js &>/tmp/event-bus.log &
        sleep 2
    fi
    if ! ps aux | grep "auto-dispatch-stocks" | grep -v grep > /dev/null; then
        nohup /root/agents/scripts/auto-dispatch-stocks.sh &>/tmp/auto-dispatch.log &
    fi

    # Get stats
    STATS=$(python3 -c "
import json
tasks = json.load(open('/root/.openclaw/intel/tasks.json'))
midcap = [t for t in tasks if t.get('projectId','').startswith('proj-midcap')]
done = [t for t in midcap if t.get('status')=='done']
active = [t for t in midcap if t.get('status') in ('pending','in-progress')]
backlog = [t for t in midcap if t.get('status')=='backlog']
active_str = ', '.join([t['title'].split('—')[0].strip() + ' ' + str(t.get('progress',0)) + '%' for t in active])
print(f'Midcap: {len(done)}/100 done | {len(active)} active | {len(backlog)} backlog')
if active_str: print(f'Running: {active_str}')
")

    # Send update
    curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
        -d "chat_id=487977821" \
        -d "text=📊 10-min update ($(date +'%H:%M'))
$STATS" > /dev/null 2>&1

    sleep 600  # 10 minutes
done
