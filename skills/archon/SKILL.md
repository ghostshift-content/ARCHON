---
name: archon
description: "Run an authorized ARCHON black-box, static, or white-box security mission using one Lead, coherent holistic workstreams, and an independent verifier panel."
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
  - Workflow
  - Workflow(archon:scan)
  - Agent(archon:archon-inventory, archon:archon-researcher, archon:archon-verifier, archon:archon-explore)
  - Bash(date *)
  - Bash(ls *)
  - Bash(wc *)
  - Bash(find *)
  - Bash(git *)
  - Bash(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 git *)
---

# ARCHON

Read [the operating role](role.md), then read and follow [the scan job](jobs/scan.md).

ARCHON supports three modes through the same team:

- `static`: source evidence only
- `blackbox`: authorized live testing, with `direct`, `smart_auto`, or `full_recon` strategy
- `whitebox`: static review followed by source-guided live validation and correlation

Do not translate modes into hardcoded agent sequences. The selected strategy changes evidence acquisition; the Lead, coherent workstreams, candidate gate, verifier panel, and coverage accounting remain the same.
