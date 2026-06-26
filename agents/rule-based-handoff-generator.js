// agents/rule-based-handoff-generator.js
//
// 2026-05-11: Closes the A2A handoff prompt-to-action gap.
//
// Empirical context: round-7, round-8c, round-9 all shipped with 0 specialist-
// emitted handoff markers despite prompt + worked example + post-processor
// being wired. Across 18 distinct Phase 2 specialists per pentest, the marker
// pattern produced zero canonical handoffs. See:
//   /root/.claude/projects/-root/memory/feedback_c2_prompt_to_action_gap.md
//
// This module replaces "ask LLM to produce structured output" with
// deterministic pattern matching on VALIDATED-FINDINGS. Same data, same goal,
// but the AGENT is removed from the producer role — pure code creates the
// handoff JSON. No prompt-to-action gap because no prompt is involved.
//
// Anti-sycophancy invariant: evidence_picker copies ONLY raw factual fields
// from the finding (url, reproduction_method, response snippets). It refuses
// to forward analyst commentary fields (notes, false_positive_check,
// rationale, my_analysis, severity_claim) — the cross-squad expert must
// reason from raw evidence, not from the source specialist's pre-formed view.
// Same discipline as judge-verifier + handoff-marker-parser STRIPPED_FIELDS.

'use strict'

// Fields that NEVER reach the cross-squad expert. Mirrors STRIPPED_FIELDS in
// handoff-marker-parser.js — keep these two lists in sync if either changes.
const STRIPPED_FIELDS = Object.freeze([
  'rationale',
  'my_analysis',
  'my_opinion',
  'severity_claim',
  'severity',
  'analyst_note',
  'notes',
  'false_positive_check',
  'conclusion',
  'recommendation',
  'threat_model',
])

// Severity gate: only High/Critical findings get cross-squad attention.
// Medium/Low/Info skip — the cross-squad budget ($2/task) is for confirmed
// high-impact work, not exploration.
const ELIGIBLE_SEVERITIES = new Set(['critical', 'high'])

function normalizeSeverity(s) {
  return String(s || '').toLowerCase().trim()
}

function findingText(finding) {
  // Concat all text fields a rule might want to scan. Lowercase for
  // case-insensitive matching. Includes title, reproduction_method, details,
  // url, etc. — but NOT analyst commentary fields. We're matching evidence,
  // not opinion.
  const parts = [
    finding.title,
    finding.id,
    finding.original_agent,
    finding.url,
    finding.target,
    finding.reproduction_method,
    finding.reproduction_result,
    finding.details,
    finding.affected_url,
    finding.affected_endpoint,
    finding.parent,
  ]
  return parts.filter(Boolean).map(String).join(' | ').toLowerCase()
}

function pickEvidence(finding) {
  // Anti-sycophancy: only raw factual fields. Object copy, not reference,
  // so the source object can't be mutated downstream.
  const out = {}
  for (const k of ['url', 'target', 'affected_url', 'affected_endpoint',
                   'reproduction_method', 'reproduction_result',
                   'cvss_vector', 'evidence_completeness']) {
    if (finding[k] != null) out[k] = finding[k]
  }
  // Drop banned analyst commentary keys, even if a future caller passes them.
  for (const k of STRIPPED_FIELDS) delete out[k]
  return out
}

// ── RULES ──
// Each rule is a pure descriptor: {id, match(text, finding), target_squad,
// target_capability, question(finding), expected_artifacts}.
// match() returns boolean. Patterns are lowercase substring or regex.

const RULES = [
  {
    id: 'cloud-provider-touched',
    target_squad: 'cloud-security',
    target_capability: 'cloud-misconfig',
    match(text /* lowercased */) {
      return /\b(amazonaws\.com|s3 bucket|s3:\/\/|azure blob|blob\.core\.windows\.net|googleapis\.com|gs:\/\/|cloudfront\.net|elb\.amazonaws|ec2-\d+|aws iam)\b/.test(text)
    },
    question(finding) {
      return `Web-side finding references cloud-provider surface. Confirm: is the cloud resource publicly exposed beyond what's documented, and does its IAM/bucket-policy match the access pattern observed in evidence? Affected: ${finding.affected_url || finding.url || finding.target || '(see evidence)'}`
    },
    expected_artifacts: ['cloud-resource-identifier', 'iam-or-bucket-policy', 'exposure-verdict'],
  },
  {
    id: 'supply-chain',
    target_squad: 'cloud-security',
    target_capability: 'supply-chain',
    match(text) {
      return /\b(supply chain|supply-chain|third[- ]party|dependency|transitive|subdomain takeover|npm package|package\.json|requirements\.txt|cdn\.jsdelivr|unpkg|cdnjs|jsdelivr|cube\.zhaopin\.com|chinese third-party|cdn-hosted js)\b/.test(text)
    },
    question(finding) {
      return `Web-side finding suggests third-party / supply-chain exposure. Confirm: which external entity controls the dependency, what data flows to it, and is there a known compromise or untrusted-provenance indicator? Affected: ${finding.affected_url || finding.url || finding.target || '(see evidence)'}`
    },
    expected_artifacts: ['external-entity-id', 'data-flow-summary', 'provenance-verdict'],
  },
  {
    id: 'data-residency',
    target_squad: 'cloud-security',
    target_capability: 'data-residency',
    match(text) {
      return /\b(data residency|cross-border|gdpr|costa rica|costa-rica|cn-north|china region|eu region|eu-(west|east|central)-\d|us-(east|west)-\d|us-east|us-west|ap-(northeast|southeast|south)-\d|me-(south|central)|sa-east|af-south|region without consent)\b/.test(text)
    },
    question(finding) {
      return `Web-side finding implies cross-border data residency risk. Confirm: which jurisdiction hosts the affected resource, and does the data flow violate stated residency commitments? Affected: ${finding.affected_url || finding.url || finding.target || '(see evidence)'}`
    },
    expected_artifacts: ['region-identifier', 'residency-policy-citation', 'compliance-verdict'],
  },
  {
    id: 'network-attribution',
    target_squad: 'network-pentest',
    target_capability: 'network-attribution',
    match(text) {
      return /\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|dns rebinding|ssrf to internal|internal-ip|\.local\/|\.lan\/|\.internal\/|\.corp\.local|reachable from external|reverse-dns)\b/.test(text)
    },
    question(finding) {
      return `Web-side finding references internal/private network range. Confirm: is the address reachable from public-facing surface, what infrastructure owns it, and what services are listening? Affected: ${finding.affected_url || finding.url || finding.target || '(see evidence)'}`
    },
    expected_artifacts: ['external-reachability-test', 'asset-owner', 'open-port-list'],
  },
  {
    id: 'framework-cve',
    target_squad: 'code-review',
    target_capability: 'framework-cve',
    match(text) {
      return /\b(cve-\d{4}-\d+|outdated framework|outdated library|vulnerable library|wp-includes|drupal|joomla|spring boot \d|struts|vtex io|actuator endpoint|composer\.json|laravel \^?\d|package\.json|react-scripts|npm package [\w-]+@)\b/.test(text)
    },
    question(finding) {
      return `Web-side finding fingerprints a framework/library with known CVE exposure. Confirm: which exact version is deployed, does the deployment include patches/mitigations, and is the vulnerable code path reachable? Affected: ${finding.affected_url || finding.url || finding.target || '(see evidence)'}`
    },
    expected_artifacts: ['exact-version', 'cve-applicability-verdict', 'patch-status'],
  },
]

function isEligibleFinding(finding) {
  if (!finding || typeof finding !== 'object') return false
  const sev = normalizeSeverity(finding.severity)
  return ELIGIBLE_SEVERITIES.has(sev)
}

function matchedRulesFor(finding) {
  const text = findingText(finding)
  const matched = []
  const seenTargets = new Set()
  for (const rule of RULES) {
    if (!rule.match(text, finding)) continue
    // Per-target dedup within one finding: if two rules point at the same
    // squad+capability, fire only the first. Two cloud-security rules for
    // the same High finding would burn the 3-handoff budget instantly.
    const k = `${rule.target_squad}|${rule.target_capability}`
    if (seenTargets.has(k)) continue
    seenTargets.add(k)
    matched.push(rule)
  }
  return matched
}

// Build the createHandoff() argument object for one (finding, rule) pair.
// Pure function — does no I/O, only returns the object the caller will pass
// to handoff-protocol.createHandoff.
function buildHandoffArgs({ finding, rule, sourceTaskId, sourceSquad, sourceAgent }) {
  if (!finding) throw new Error('buildHandoffArgs: finding required')
  if (!rule) throw new Error('buildHandoffArgs: rule required')
  if (!sourceTaskId) throw new Error('buildHandoffArgs: sourceTaskId required')

  const sourceFindingId = finding.id || finding.findingId
    || `unidentified-${rule.id}-${Date.now()}`

  return {
    sourceTaskId: String(sourceTaskId),
    sourceSquad: sourceSquad || 'pentest',
    sourceAgent: String(sourceAgent || finding.original_agent || 'RULE-BASED-GENERATOR').toUpperCase(),
    sourceFindingId,
    targetSquad: rule.target_squad,
    targetCapability: rule.target_capability,
    request: {
      question: rule.question(finding),
      evidence: pickEvidence(finding),
      expected_artifacts: rule.expected_artifacts.slice(),
    },
  }
}

// Main entry: iterate findings, run rules, call createHandoff for each match.
// Idempotence is delegated to handoff-protocol.createHandoff which enforces
// MAX_HANDOFFS_PER_FINDING by walking inbox+done+failed. We never check
// existence ourselves — the protocol is the single source of truth.
//
// Returns {created: [...], skipped: [...], errors: [...]} so callers (and
// tests) can verify outcomes. Fail-soft per rule+finding pair: one bad
// match never drops siblings.
function generateHandoffsForTask({
  findings,
  sourceTaskId,
  sourceSquad,
  sourceAgent,
  createHandoff,
}) {
  if (!Array.isArray(findings)) throw new Error('findings must be an array')
  if (!sourceTaskId) throw new Error('sourceTaskId required')
  if (typeof createHandoff !== 'function') throw new Error('createHandoff must be a function')

  const result = { created: [], skipped: [], errors: [] }

  for (const finding of findings) {
    if (!isEligibleFinding(finding)) {
      result.skipped.push({ finding_id: finding?.id, reason: 'severity-not-eligible' })
      continue
    }
    const rules = matchedRulesFor(finding)
    if (rules.length === 0) {
      result.skipped.push({ finding_id: finding.id, reason: 'no-rule-matched' })
      continue
    }
    for (const rule of rules) {
      try {
        const args = buildHandoffArgs({
          finding, rule, sourceTaskId, sourceSquad, sourceAgent,
        })
        const created = createHandoff(args)
        result.created.push({
          handoff_id: created?.handoff_id,
          rule_id: rule.id,
          finding_id: finding.id,
          target_squad: rule.target_squad,
          target_capability: rule.target_capability,
        })
      } catch (e) {
        // Per-pair fail-soft. Per-finding-cap rejection from createHandoff
        // (MAX_HANDOFFS_PER_FINDING) lands here too — it's not an error
        // condition, it's the protocol enforcing the cap. We surface it via
        // errors[] for telemetry but DO NOT throw.
        result.errors.push({
          rule_id: rule.id,
          finding_id: finding.id,
          error: e.message,
        })
      }
    }
  }
  return result
}

module.exports = {
  generateHandoffsForTask,
  buildHandoffArgs,
  matchedRulesFor,
  isEligibleFinding,
  pickEvidence,
  findingText,
  RULES,
  STRIPPED_FIELDS,
  ELIGIBLE_SEVERITIES,
}
