#!/usr/bin/env bash
# backup-agent-state.sh — snapshot evicted agent state (var/state) to a rolling
# tarball archive. var/state is gitignored (restructure Phase 2, 2026-06-08), so
# learned lessons/grades/episodes are no longer backed up to GitHub. This is the
# off-git floor. Run from cron for a real backup cadence, e.g.:
#   0 */6 * * * /root/agents/scripts/backup-agent-state.sh >> /root/intel/backup-agent-state.log 2>&1
#
# Keeps the last KEEP archives. Zero LLM, zero network — pure local tar.
set -euo pipefail

SRC="/root/agents/var/state"
DEST="/root/backups/agent-state"
KEEP="${KEEP:-14}"          # how many snapshots to retain
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

[ -d "$SRC" ] || { echo "[backup-agent-state] no $SRC — nothing to back up"; exit 0; }
mkdir -p "$DEST"

ARCHIVE="$DEST/agent-state-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$(dirname "$SRC")" "$(basename "$SRC")"
SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "[backup-agent-state] $STAMP → $ARCHIVE ($SIZE)"

# prune old snapshots, keep newest $KEEP
mapfile -t OLD < <(ls -1t "$DEST"/agent-state-*.tar.gz 2>/dev/null | tail -n +"$((KEEP+1))")
for f in "${OLD[@]:-}"; do [ -n "$f" ] && rm -f "$f" && echo "[backup-agent-state] pruned $(basename "$f")"; done
