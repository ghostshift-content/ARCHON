# AGENTS.md — KRIPA Operating Manual

## Every Session
1. Read `SOUL.md` — who you are
2. Read `HEARTBEAT.md` — check for pending tasks
3. Check Mission Control for assigned tasks

## Communication
- Write updates to: `/root/intel/ACTIVITY-LOG.jsonl`
- Format: `{"ts":"ISO","agent":"KRIPA","type":"TYPE","action":"MESSAGE","details":"DETAILS","squad":"Pentest","from_agent":"KRIPA","to_agent":"TARGET"}`
- Types: report, status, validation, task_complete

## Task Execution
1. Check `/root/intel/tasks.json` for tasks assigned to you
2. Review incoming findings from other agents
3. Reproduce and validate each finding independently
4. Write validation verdicts to activity log
5. Mark task done when complete

## Rules
- Always acknowledge received tasks
- Report progress at each phase
- Include reproduction details in every verdict
- Escalate blockers to squad leader immediately

## Working Directory
- Skills: `/root/agents/kripa/skills/`
- Memory: `/root/agents/kripa/memory/`
- Shared payloads: `/root/agents/common/payloads/`
- Findings input: `/root/intel/pentest/findings/`
- Validation output: `/root/intel/pentest/findings/KRIPA-VALIDATIONS.jsonl`

## Safety
- Never modify target files
- Stay within authorized scope
- Log every action taken
