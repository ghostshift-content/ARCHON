
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/squad-framework.js
// Universal Squad Framework — every squad inherits these capabilities automatically

const fs = require('fs')

const MUST_GATES = `
## MANDATORY VERIFICATION GATES (ALL AGENTS)
You MUST follow these gates. Violation = finding rejected.

**GATE-1 [ASSUME-EXPLOIT]:** Your goal is to discover real exploitable vulnerabilities/issues. If you think something isn't exploitable — DO NOT assume. First, investigate under the assumption that it IS exploitable. Only mark as non-exploitable after concrete proof.

**GATE-2 [NO-HEDGING]:** If your output contains "maybe", "could potentially", "in theory", "might be possible", "depending on", "in certain circumstances", "unclear", "uncertain" — STOP. Immediately verify the claim. Replace hedging language with either CONFIRMED (with proof) or NOT FOUND (with evidence of absence). No unverified claims allowed.

**GATE-3 [PROOF-REQUIRED]:** Every finding MUST include:
- Exact command/request that triggered it
- Exact response/output received
- Why this proves the vulnerability exists
No finding without proof. "I believe X exists" without proof = rejected.

**GATE-4 [CONSISTENCY-CHECK]:** Before finalizing each finding, verify that severity matches description. A description that explains why something is benign MUST NOT carry High/Critical severity. A description showing RCE MUST NOT be marked Low.

**GATE-5 [FULL-COVERAGE]:** Test ALL endpoints/parameters/functions in your scope. Do not sample, estimate, or stop at the first interesting finding. Completeness matters.

**GATE-6 [TRACK-FAILURES]:** Log what you tried that DIDN'T work. Write to activity log: "DISPROVEN: [technique] on [target] — [why it failed]". This prevents other agents from wasting time retrying.

**GATE-7 [SELF-EVAL]:** Before writing COMPLETE or DONE, stop and evaluate your own output:
- Rate yourself 1-10 against the task goal
- If < 7: you MUST improve before submitting. Re-read your output, find gaps, fix them.
- If 7-8: submit but log what gaps remain
- If 9-10: submit confidently
Log to activity: "SELF_EVAL: X/10 — [what's strong, what's missing]"
This is NOT optional. Every agent must self-evaluate before final output.

**GATE-8 [COMMIT-OR-DISCARD]:** Before marking a finding as CONFIRMED, ask yourself:
- Can I prove this is actually exploitable? (not just a config flaw)
- Would a senior pentester / analyst report this?
- Is my evidence conclusive or am I guessing?
If you cannot answer YES to all three → mark as SUSPECTED or DISPROVEN, not CONFIRMED.
"CONFIRMED" means "I exploited it and proved impact" — not "I found a misconfiguration that theoretically could be exploited."

**GATE-9 [THINK-HARDER]:** If your first approach fails, you MUST try at least 2 more different approaches before giving up. Read your lessons.md for what worked before. Combine techniques. Try encoding bypasses, different HTTP methods, alternate paths. If stuck after 3 genuine attempts, THEN mark as DISPROVEN with all 3 attempts logged. One failed curl is not enough to disprove.

**GATE-10 [FRESH-EYES]:** Every target is UNIQUE. Lessons from previous tasks are HYPOTHESES to test, NOT conclusions to apply.
- Do NOT assume what worked on Target A works on Target B
- Do NOT assume what failed on Target A fails on Target B
- FIRST: test this specific target independently with fresh eyes
- THEN: compare your findings with past lessons
- If a lesson says "CORS works on domain X" and you're testing domain Y, verify CORS on Y independently — don't copy the conclusion
- Past lessons help you know WHAT to test, not WHAT the result will be

**GATE-11 [CHAIN-COMPLETE]:** Before claiming any CRITICAL or HIGH severity finding, trace the evidence chain end-to-end in your squad's domain. Local-only evidence (single file, single config value, single packet, single line) is INSUFFICIENT for CRITICAL/HIGH. The chain must cover: input source → every defense layer the input passes through → the sink where the vulnerability manifests. If ANY layer was not inspected, downgrade severity and emit \`evidence_completeness\` metadata (values: "full", "partial", "local_only") plus \`pipeline_trace\` (array of layer names inspected). Squad-specific chain examples live in each squad's skill files. AUDITOR auto-caps severity: full→Critical OK, partial→max Medium, local_only→max Low.

**GATE-12 [THREAT-MODEL]:** Before claiming CRITICAL or HIGH severity, state the realistic attacker model as structured metadata on the candidate: what privilege level does the attacker need (unauth / authenticated / privileged / admin / superuser)? What trust boundary (if any) does the attack cross? Are required runtime dependencies (binaries, services, config flags) verified present? Is this behavior documented as intentional by the target? Severity must match the realistic attack path, not worst-case theoretical impact. AUDITOR applies stacked caps: admin-only → max Medium; working-as-designed → −1 tier; toolchain not verified → max Low; no trust boundary crossed → −1 tier. Cap composition: worst ceiling among applied rules. Missing threat_model field → SAFE defaults that downgrade.

**GATE-13 [CONFIDENCE + REPRODUCTION]:** Every finding logged to live-findings MUST include TWO fields:
- \`"confidence": "high|medium|low"\` — high = I ran the exploit and saw the impact; medium = I reproduced the condition but impact is inferred; low = I saw signals but didn't fully confirm
- \`"reproduction": "EXACT curl command or steps"\` — the specific command you ran that produced evidence
Without these fields, AUDITOR and ARBITER cannot evaluate your finding properly. A finding with confidence="high" and a concrete reproduction command gets priority validation. Low confidence findings get deprioritized. This is not optional.
`;

const MUST_GATES_STOCKS = `
## MANDATORY QUALITY GATES (STOCK ANALYSIS)

**GATE-1 [NO-HEDGING]:** Replace "maybe", "could potentially", "might" with CONFIRMED data or NOT FOUND. Every claim must have a source.

**GATE-2 [PROOF-REQUIRED]:** Every metric (P/E, ROE, price target, etc.) MUST cite its source. No unsourced numbers.

**GATE-3 [FULL-COVERAGE]:** Cover ALL required sections. Do not skip sections or give partial analysis.

**GATE-4 [TRACK-SOURCES]:** Log every data source used. If a source was unavailable or returned stale data, note it explicitly.

**GATE-5 [SELF-EVAL]:** Before writing your final analysis, stop and evaluate:
- Rate your output 1-10 against what a professional equity analyst would produce
- If < 7: improve before submitting. Add missing data, fix unsourced claims, deepen analysis.
- If 7-8: submit but note what data was unavailable
- If 9-10: submit confidently
Log: "SELF_EVAL: X/10 — [strengths, gaps]"

**GATE-6 [THINK-HARDER]:** If you can't find data for a metric, try at least 2 alternate sources before marking as unavailable. Check company website, BSE/NSE filings, screener.in, moneycontrol, trendlyne. One failed search is not enough — dig deeper.

**GATE-7 [FRESH-EYES]:** Every stock is UNIQUE. Lessons from previous analyses are HYPOTHESES, not conclusions.
- Do NOT assume Stock A's valuation pattern applies to Stock B
- Do NOT copy sector bias — "pharma is overvalued" from one stock doesn't mean ALL pharma is overvalued
- FIRST: analyze this specific company's fundamentals independently
- THEN: compare with past lessons and sector patterns
- Past lessons tell you WHAT to analyze, not WHAT the conclusion will be
- A BUY recommendation for Company X does NOT influence Company Y's rating

**GATE-8 [CHAIN-COMPLETE]:** Every valuation or recommendation must trace the full evidence chain: raw filing data → adjustment normalization → peer benchmark → conclusion. Local-only evidence (single ratio, single quarter, single source) is INSUFFICIENT for a BUY/SELL call. If any link in the chain is unverified, mark the conclusion as HYPOTHESIS, not recommendation.

**GATE-9 [THREAT-MODEL]:** Before claiming any strong recommendation, state the realistic decision-maker model: who is this recommendation for, over what time horizon, what prerequisite knowledge/position? A recommendation that requires institutional access to execute is not the same as one any retail investor can act on. Severity of risk/opportunity must match the realistic path, not worst-case theoretical impact.
`;

// ── Budget config file — UI writes here, event bus reads ──
const BUDGET_CONFIG_FILE = (__roots.INTEL_ROOT + '/budget-config.json')
const DEFAULT_BUDGET = 50 // $50 default for all squads

function loadBudgetConfig() {
  try {
    if (fs.existsSync(BUDGET_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(BUDGET_CONFIG_FILE, 'utf-8'))
    }
  } catch {}
  return {}
}

function saveBudgetConfig(config) {
  try {
    fs.mkdirSync(__roots.INTEL_ROOT, { recursive: true })
    fs.writeFileSync(BUDGET_CONFIG_FILE, JSON.stringify(config, null, 2))
  } catch {}
}

// Squad type definitions — each type defines its pipeline behavior.
// ADDED 2026-04-19: leaderAgent, gateStyle, memoryNamespace, dispatchType fields.
// These make event-bus.js squad-generic — no more hardcoded pentest/stocks checks.
// Adding a new squad = adding an entry here + the agent directories. Zero code changes elsewhere.
// reportDirs: per-squad list of directories where agents may write dossier
// files (in addition to the canonical /root/intel/reports/<taskId>.md). Used by
// saveAgentReport() / extractAndSaveSquadReport() / grader fallback scan to
// locate dossiers when an agent writes to a file rather than to stdout.
// finalReportName: optional well-known filename teamleader writes (e.g. SCRIBE's
// FINAL-REPORT.md for pentest). Absent = canonical /reports/<taskId>.md only.
const SQUAD_TYPES = {
  'pentest': {
    type: 'security-testing',
    leaderAgent: 'atlas',       // who runs chain analysis + coordinates
    gateStyle: 'security',        // 'security' = MUST_GATES / 'analysis' = MUST_GATES_STOCKS
    memoryNamespace: 'pentest',   // drives /root/intel/squad-memory-<ns>.json
    dispatchType: 'parallel-phases', // 'parallel-phases' = pentest flow, 'parallel-challenger' = stocks flow
    validationModel: 'multi-stage',
    chainAnalysis: true,
    arbiterVerification: true,
    costBudget: 50,
    phases: ['recon', 'exploit', 'validate', 'chain', 'report', 'verify'],
    reportFormat: 'pentest-report',
    priorityOrder: ['secrets', 'rce', 'injection', 'auth', 'crypto', 'config'],
    reportDirs: [(__roots.INTEL_ROOT + '/pentest')],
    finalReportName: 'FINAL-REPORT.md',
    evidenceCompleteness: { enabled: false, provider: 'attack-chain' },
    threatModel: { enabled: false, provider: 'threat-model' },
  },
  'stocks': {
    type: 'analysis',
    leaderAgent: 'chanakya',
    gateStyle: 'analysis',
    memoryNamespace: 'stocks',
    dispatchType: 'parallel-challenger',
    validationModel: 'challenger',
    chainAnalysis: true,
    arbiterVerification: false, // Skip — SELF_EVAL + grading sufficient for stocks, saves 15-22 min
    costBudget: 50,
    phases: ['research', 'analyze', 'challenge', 'synthesize', 'report', 'verify'],
    reportFormat: 'stock-analysis',
    priorityOrder: ['risk', 'opportunity', 'technical', 'fundamental', 'sentiment'],
    reportDirs: [(__roots.INTEL_ROOT + '/stocks/reports'), (__roots.INTEL_ROOT + '/stocks')],
    finalReportName: null, // stocks dossiers are task-keyed, not a single file
    evidenceCompleteness: { enabled: false, provider: 'none' },
    threatModel: { enabled: false, provider: 'threat-model' },
  },
  'red-team': {
    type: 'security-testing',
    leaderAgent: 'parashurama',
    gateStyle: 'security',
    memoryNamespace: 'red-team',
    dispatchType: 'parallel-phases', // same as pentest for now; override when red-team flow diverges
    validationModel: 'multi-stage',
    chainAnalysis: true,
    arbiterVerification: true,
    costBudget: 50,
    phases: ['recon', 'exploit', 'lateral', 'validate', 'chain', 'report', 'verify'],
    reportFormat: 'pentest-report',
    priorityOrder: ['initial-access', 'lateral', 'persistence', 'exfil', 'cleanup'],
    reportDirs: [(__roots.INTEL_ROOT + '/red-team')],
    finalReportName: 'FINAL-REPORT.md',
    evidenceCompleteness: { enabled: false, provider: 'inherit' },
    threatModel: { enabled: false, provider: 'threat-model' },
  },
  'cloud-security': {
    type: 'security-testing',
    leaderAgent: 'varuna',
    gateStyle: 'security',
    memoryNamespace: 'cloud-security',
    dispatchType: 'cloud-security',
    validationModel: 'multi-stage',
    chainAnalysis: true,
    arbiterVerification: true,
    costBudget: 50,
    phases: ['enumerate', 'assess', 'validate', 'chain', 'report', 'verify'],
    reportFormat: 'cloud-security-report',
    priorityOrder: ['iam', 'network', 'storage', 'compute', 'logging', 'encryption'],
    reportDirs: [(__roots.INTEL_ROOT + '/cloud-security')],
    finalReportName: 'FINAL-REPORT.md',
    evidenceCompleteness: { enabled: false, provider: 'iam-chain' },
    threatModel: { enabled: false, provider: 'threat-model' },
  },
  'network-pentest': {
    type: 'security-testing',
    leaderAgent: 'shalya',
    gateStyle: 'security',
    memoryNamespace: 'network-pentest',
    dispatchType: 'network-pentest',
    validationModel: 'multi-stage',
    chainAnalysis: true,
    arbiterVerification: true,
    costBudget: 50,
    phases: ['discovery', 'enumerate', 'exploit', 'validate', 'chain', 'report', 'verify'],
    reportFormat: 'pentest-report',
    priorityOrder: ['rce', 'auth-bypass', 'default-creds', 'misconfig', 'info-disclosure'],
    reportDirs: [(__roots.INTEL_ROOT + '/network-pentest')],
    finalReportName: 'FINAL-REPORT.md',
    evidenceCompleteness: { enabled: false, provider: 'cve-banner' },
    threatModel: { enabled: false, provider: 'threat-model' },
  },
  'code-review': {
    type: 'security-testing',
    leaderAgent: 'curator',
    gateStyle: 'security',
    memoryNamespace: 'code-review',
    dispatchType: 'code-review',
    validationModel: 'multi-stage',
    chainAnalysis: true,
    arbiterVerification: true,
    costBudget: 50,
    phases: ['blueprint', 'trace', 'deploy', 'validate', 'chain', 'report', 'verify'],
    reportFormat: 'code-review-report',
    priorityOrder: ['access-control', 'account-takeover', 'xss', 'sqli', 'ssrf', 'rce'],
    reportDirs: [(__roots.INTEL_ROOT + '/code-review')],
    finalReportName: 'FINAL-REPORT.md',
    evidenceCompleteness: { enabled: true, provider: 'pipeline' },
    threatModel: { enabled: true, provider: 'threat-model' },
  },
  'ai-security': {
    type: 'security-testing',
    leaderAgent: 'atlas', // reuse until ai-security gets its own leader
    gateStyle: 'security',
    memoryNamespace: 'ai-security',
    dispatchType: 'parallel-phases',
    validationModel: 'multi-stage',
    chainAnalysis: true,
    arbiterVerification: true,
    costBudget: 50,
    phases: ['probe', 'inject', 'validate', 'chain', 'report', 'verify'],
    reportFormat: 'ai-security-report',
    priorityOrder: ['jailbreak', 'data-leak', 'prompt-injection', 'model-extraction', 'dos'],
    reportDirs: [(__roots.INTEL_ROOT + '/ai-security')],
    finalReportName: 'FINAL-REPORT.md',
    evidenceCompleteness: { enabled: false, provider: 'model-chain' },
    threatModel: { enabled: false, provider: 'threat-model' },
  },
};

// Default config for unknown/new squads — inherits everything
const DEFAULT_SQUAD_TYPE = {
  type: 'general',
  leaderAgent: 'atlas',
  gateStyle: 'security',
  memoryNamespace: 'general',
  dispatchType: 'parallel-phases',
  validationModel: 'multi-stage',
  chainAnalysis: true,
  arbiterVerification: true,
  costBudget: 50,
  phases: ['analyze', 'validate', 'report', 'verify'],
  reportFormat: 'general-report',
  priorityOrder: ['critical', 'high', 'medium', 'low', 'info'],
  reportDirs: [], // falls back to /root/intel/reports/<taskId>.md only
  finalReportName: null,
  evidenceCompleteness: { enabled: false, provider: 'none' },
  threatModel: { enabled: false, provider: 'none' },
};

function getSquadConfig(squadId) {
  const normalized = squadId.replace('-squad', '').replace('_squad', '');
  return SQUAD_TYPES[normalized] || DEFAULT_SQUAD_TYPE;
}

function getSquadType(squadId) {
  return getSquadConfig(squadId).type;
}

// NEW (2026-04-19) — squad-generic accessors. Use these from event-bus.js instead of
// squad.includes('pentest') / squad.includes('stocks') conditionals. Any new squad added
// to SQUAD_TYPES above automatically gets correct behavior without code changes.

function getSquadLeader(squadId) {
  return getSquadConfig(squadId).leaderAgent || 'atlas'
}

function getSquadGateStyle(squadId) {
  return getSquadConfig(squadId).gateStyle || 'security'
}

function getSquadGates(squadId) {
  return getSquadGateStyle(squadId) === 'analysis' ? MUST_GATES_STOCKS : MUST_GATES
}

function getSquadMemoryNamespace(squadId) {
  return getSquadConfig(squadId).memoryNamespace || squadId.replace('-squad', '') || 'general'
}

function getSquadMemoryFile(squadId) {
  const ns = getSquadMemoryNamespace(squadId)
  return `${__roots.INTEL_ROOT}/squad-memory-${ns}.json`
}

function getSquadDispatchType(squadId) {
  return getSquadConfig(squadId).dispatchType || 'parallel-phases'
}

function listKnownSquads() {
  return Object.keys(SQUAD_TYPES)
}

// (2026-04-20) Squad-generic report path accessors — callers must NEVER
// hardcode /root/intel/<squad>/ paths. Adding a new squad only requires
// adding reportDirs + finalReportName in SQUAD_TYPES above.
function getSquadReportDirs(squadId) {
  const cfg = getSquadConfig(squadId)
  return Array.isArray(cfg.reportDirs) ? cfg.reportDirs : []
}

function getSquadFinalReportPath(squadId, taskId) {
  const cfg = getSquadConfig(squadId)
  if (!cfg.finalReportName || !cfg.reportDirs?.length) return null
  return `${cfg.reportDirs[0]}/${cfg.finalReportName}`
}

function getSquadTaskReportPath(squadId, taskId) {
  const cfg = getSquadConfig(squadId)
  if (!cfg.finalReportName || !cfg.reportDirs?.length) return null
  // Task-specific variant: "FINAL-REPORT-<taskId>.md" next to FINAL-REPORT.md
  const base = cfg.finalReportName.replace(/\.md$/, '')
  return `${cfg.reportDirs[0]}/${base}-${taskId}.md`
}

// Canonical-author ROLE per squad (2026-06-09 canonical-selection fix).
// analysis squads (stocks) → the squad LEADER writes the dossier (CHANAKYA).
// security squads → the universal REPORTER (SCRIBE) writes it, NOT teamleader.
// The dossier-selector + saveAgentReport use this to pick/stamp the right
// author's file. Resolving by ROLE (not getSquadLeader) closes the latent trap
// where the security-squad leader (ATLAS/VARUNA/...) writes side artifacts.
function canonicalReportRole(squadId) {
  return getSquadType(squadId) === 'analysis' ? 'leader' : 'reporter'
}

// Orchestrator-OWNED canonical draft path. Distinct 'CANONICAL-<taskId>.md'
// namespace so it can never collide with an agent-self-named file
// (CHANAKYA-*/NARAD-*). The synthesizer prompt dictates this path; saveAgentReport
// stamps the marker/sidecar regardless, so correctness never depends on the agent
// actually obeying it (reinforcing layer, not load-bearing).
function getSquadCanonicalDraftPath(squadId, taskId) {
  const cfg = getSquadConfig(squadId)
  const dir = (Array.isArray(cfg.reportDirs) && cfg.reportDirs[0]) || (__roots.INTEL_ROOT + '/reports')
  return `${dir}/CANONICAL-${taskId}.md`
}

// Aggregate report candidates across ALL known squads — used by grader fallback
// when it doesn't know which squad's dir to scan (legacy tasks, cross-squad
// dossier handoffs). Returns absolute paths only.
function getAllSquadReportDirs() {
  const seen = new Set()
  for (const id of Object.keys(SQUAD_TYPES)) {
    for (const d of (SQUAD_TYPES[id].reportDirs || [])) seen.add(d)
  }
  return Array.from(seen)
}

// Target-profile-aware priority (2026-04-19). Thin wrapper over target-classifier —
// lives here so event-bus always imports one squad-generic accessor. Returns an ordered
// list of specialist agent names (lowercase) to run FIRST, not a filter. Agents absent
// from the list still run at default priority. Never returns a "skip" or "exclude" list.
let _targetClassifier = null
function _getClassifier() {
  if (_targetClassifier) return _targetClassifier
  try { _targetClassifier = require('../routing/target-classifier') } catch { _targetClassifier = null }
  return _targetClassifier
}

function getTargetPriorityOrder(squadId, profile) {
  const tc = _getClassifier()
  if (!tc || !profile) return []
  try { return tc.getPriorityOrderForSquad(squadId, profile) } catch { return [] }
}

function getTargetSeverityMultiplier(profile) {
  const tc = _getClassifier()
  if (!tc || !profile) return 1.0
  try { return tc.getSeverityMultiplier(profile) } catch { return 1.0 }
}

function shouldRunChainAnalysis(squadId) {
  return getSquadConfig(squadId).chainAnalysis;
}

function shouldRunarbiter(squadId) {
  return getSquadConfig(squadId).arbiterVerification;
}

function getCostBudget(squadId) {
  // Priority: UI config file > squad default > global default
  const budgetConfig = loadBudgetConfig()
  const normalized = squadId.replace('-squad', '').replace('_squad', '');
  
  // Check agent-level budget override first, then squad-level, then default
  if (budgetConfig.squads && budgetConfig.squads[normalized] !== undefined) {
    return budgetConfig.squads[normalized]
  }
  if (budgetConfig.global !== undefined) {
    return budgetConfig.global
  }
  const config = getSquadConfig(squadId)
  return config.costBudget || DEFAULT_BUDGET
}

function setCostBudget(squadId, budget) {
  const budgetConfig = loadBudgetConfig()
  if (!budgetConfig.squads) budgetConfig.squads = {}
  const normalized = squadId.replace('-squad', '').replace('_squad', '');
  budgetConfig.squads[normalized] = budget
  saveBudgetConfig(budgetConfig)
  return budget
}

function setGlobalBudget(budget) {
  const budgetConfig = loadBudgetConfig()
  budgetConfig.global = budget
  saveBudgetConfig(budgetConfig)
  return budget
}

function getPriorityOrder(squadId) {
  return getSquadConfig(squadId).priorityOrder;
}

// Re-export feedback context functions for prompt builders
const feedbackLoop = (() => {
  try { return require('../learning/feedback-loop') } catch { return null }
})()

function getDisprovenContext(squad, target) {
  try { return feedbackLoop ? feedbackLoop.getDisprovenContext(squad, target) : '' } catch { return '' }
}

function getSquadLessons(squad) {
  try { return feedbackLoop ? feedbackLoop.getSquadLessons(squad) : '' } catch { return '' }
}

// (2026-04-23) Evidence-completeness config per squad. Universal meta-discipline
// (GATE-11) applies to all; the per-squad provider (pipeline for code-review,
// extensible to iam-chain/cve-banner/attack-chain) is gated by enabled flag.
// See docs/superpowers/specs/2026-04-23-evidence-completeness-design.md.
function getEvidenceCompletenessConfig(squadId) {
  const cfg = getSquadConfig(squadId)
  return (cfg && cfg.evidenceCompleteness) || { enabled: false, provider: 'none' }
}

// (2026-04-23 v2) Threat-model discipline config. Stacks with evidenceCompleteness.
// See docs/superpowers/specs/2026-04-23-threat-model-discipline-design.md.
function getThreatModelConfig(squadId) {
  const cfg = getSquadConfig(squadId)
  return (cfg && cfg.threatModel) || { enabled: false, provider: 'none' }
}

module.exports = {
  MUST_GATES,
  MUST_GATES_STOCKS,
  SQUAD_TYPES,
  DEFAULT_SQUAD_TYPE,
  BUDGET_CONFIG_FILE,
  getSquadConfig,
  getSquadType,
  shouldRunChainAnalysis,
  shouldRunarbiter,
  getCostBudget,
  setCostBudget,
  setGlobalBudget,
  getPriorityOrder,
  loadBudgetConfig,
  saveBudgetConfig,
  getDisprovenContext,
  getSquadLessons,
  // NEW 2026-04-19 squad-generic accessors:
  getSquadLeader,
  getSquadGateStyle,
  getSquadGates,
  getSquadMemoryNamespace,
  getSquadMemoryFile,
  getSquadDispatchType,
  listKnownSquads,
  // Evidence-completeness discipline (2026-04-23):
  getEvidenceCompletenessConfig,
  // Threat-model discipline v2 (2026-04-23):
  getThreatModelConfig,
  // Target-profile accessors (2026-04-19) — inform specialist priority, never filter:
  getTargetPriorityOrder,
  getTargetSeverityMultiplier,
  // Squad-generic report path accessors (2026-04-20) — universal audit fix:
  getSquadReportDirs,
  getSquadFinalReportPath,
  getSquadTaskReportPath,
  // Canonical-author resolution (2026-06-09 canonical-selection fix):
  canonicalReportRole,
  getSquadCanonicalDraftPath,
  getAllSquadReportDirs,
};
