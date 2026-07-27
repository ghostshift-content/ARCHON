export const meta = {
  name: "scan",
  description: "ARCHON canonical team: inventory, coherent holistic research, deterministic dedupe, three-lens verification, and report admission.",
  phases: [
    { title: "Inventory", detail: "Build or validate the mode-appropriate evidence map and coverage ledger." },
    { title: "Plan", detail: "Create context-budget-sized coherent workstreams." },
    { title: "Research", detail: "One holistic researcher per workstream; all applicable skill families in one pass." },
    { title: "Verify", detail: "Three independent verifier lenses over bounded candidate batches." },
    { title: "Admit", detail: "Code-computed dedupe, vote tally, status, and coverage gate." }
  ]
}

let input = args
if (typeof input === "string") {
  try { input = JSON.parse(input) } catch { input = {} }
}
input = input && typeof input === "object" ? input : {}

const MODES = new Set(["static", "blackbox", "whitebox"])
const LENSES = ["REACHABILITY", "IMPACT", "DEFENSES"]
const mode = MODES.has(input.mode) ? input.mode : "static"
const strategy = input.strategy || (mode === "blackbox" ? "smart_auto" : "source")
const effort = ["low", "medium", "high", "max"].includes(input.effort) ? input.effort : "medium"
const batchSize = Math.max(1, Math.min(12, Number(input.verifier_batch_size) || 8))
let workstreams = Array.isArray(input.workstreams) ? input.workstreams : []
let skillFamilies = Array.isArray(input.skill_families) ? input.skill_families : []

if (!input.scope) {
  return {
    started: false,
    reason: "scope-contract-required",
    mode,
    strategy
  }
}

const inventorySchema = {
  type: "object",
  required: ["workstreams", "skill_families", "coverage"],
  properties: {
    workstreams: { type: "array" },
    skill_families: { type: "array" },
    coverage: { type: "array" },
    gaps: { type: "array" }
  }
}
const candidateSchema = {
  type: "object",
  required: ["coverage", "candidates"],
  properties: {
    coverage: { type: "array" },
    candidates: { type: "array" },
    followups: { type: "array" }
  }
}
const voteSchema = {
  type: "object",
  required: ["votes"],
  properties: {
    votes: { type: "array" }
  }
}

let inventoryCoverage = []
if (workstreams.length === 0) {
  phase("Inventory")
  const inventory = await agent(
    `Build the evidence inventory and coherent workstream plan for one authorized
ARCHON mission.

MODE: ${mode}
STRATEGY: ${strategy}
TARGET OR SOURCE ROOT: ${JSON.stringify(input.target || input.source_root || input.inputs || ".")}
SCOPE CONTRACT: ${JSON.stringify(input.scope)}
CONTEXT BUDGET: ${JSON.stringify(input.context_budget || {})}

For static/white-box, map source features, interfaces, identity/authorization,
shared controls, sensitive flows, and dependency locality with file:line evidence.
For black-box direct strategy, map only supplied application/API seeds and do not
force infrastructure recon. For smart_auto, gather only evidence that unlocks
useful testing. For full_recon, inventory the authorized external surface.

Pack the result into context-budget-sized coherent workstreams. A context-fit
target is one workstream. Every inventory item must be mapped, excluded with a
reason, unsupported, or a coverage gap. Return the applicable security skill
families; do not report vulnerabilities.`,
    {
      label: "inventory",
      phase: "Inventory",
      agentType: "archon:archon-inventory",
      schema: inventorySchema,
      effort: effort === "low" ? "medium" : effort
    }
  )
  workstreams = inventory && Array.isArray(inventory.workstreams) ? inventory.workstreams : []
  skillFamilies = inventory && Array.isArray(inventory.skill_families) ? inventory.skill_families : skillFamilies
  inventoryCoverage = inventory && Array.isArray(inventory.coverage) ? inventory.coverage : []
}

if (workstreams.length === 0) {
  return {
    started: false,
    reason: "inventory-produced-no-workstreams",
    mode,
    strategy,
    coverage: inventoryCoverage
  }
}

phase("Research")
const researchResults = await parallel(workstreams.map(ws => () => agent(
  `Review exactly one authorized ${mode} workstream holistically.

MODE: ${mode}
STRATEGY: ${strategy}
WORKSTREAM: ${JSON.stringify(ws)}
APPLICABLE SKILL FAMILIES: ${JSON.stringify(skillFamilies)}
SCOPE CONTRACT: ${JSON.stringify(input.scope)}

Apply every applicable family as a lens in this same session. Include access control,
authentication, business invariants, missing controls, trust boundaries, dangerous
operations, and freehand chain reasoning. Do not create one child per class. You may
use no more than two Explore children for bounded evidence questions.

Return one terminal coverage row per applicable family and evidence-backed candidate
records only. Static evidence is not runtime proof. Deduplicate within this workstream.`,
  {
    label: `research:${ws.id || "workstream"}`,
    phase: "Research",
    agentType: "archon:archon-researcher",
    schema: candidateSchema,
    effort
  }
)))

const rawCandidates = []
const coverage = [...inventoryCoverage]
for (const result of researchResults.filter(Boolean)) {
  for (const row of result.coverage || []) coverage.push(row)
  for (const candidate of result.candidates || []) rawCandidates.push(candidate)
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/\d+/g, "{id}").replace(/\s+/g, " ")
}
function candidateKey(c) {
  return JSON.stringify([
    normalized(c.class || c.category),
    normalized(c.file || c.asset),
    Number(c.line) || 0,
    normalized(c.method),
    normalized(c.endpoint || c.path),
    normalized(c.parameter),
    normalized(c.sink || c.signature)
  ])
}

const deduped = new Map()
for (const candidate of rawCandidates) {
  const key = candidateKey(candidate)
  const current = deduped.get(key)
  if (!current) deduped.set(key, { ...candidate, observation_count: 1 })
  else current.observation_count += 1
}
const candidates = Array.from(deduped.values()).map((candidate, index) => ({
  ...candidate,
  id: candidate.id || `CAND-${index + 1}`
}))

const batches = []
for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize))

phase("Verify")
const panelResults = await parallel(batches.flatMap((batch, batchIndex) =>
  LENSES.map(lens => () => agent(
    `Independently challenge this bounded candidate batch.

MODE: ${mode}
LENS: ${lens}
SCOPE CONTRACT: ${JSON.stringify(input.scope)}
CANDIDATES: ${JSON.stringify(batch)}

Return exactly one vote per candidate. Use TRUE_POSITIVE only when this lens is
supported by cited evidence; otherwise FALSE_POSITIVE or NEEDS_MORE_EVIDENCE.
Do not tally votes and do not trust candidate prose as evidence.`,
    {
      label: `verify:${batchIndex + 1}:${lens.toLowerCase()}`,
      phase: "Verify",
      agentType: "archon:archon-verifier",
      schema: voteSchema,
      effort: effort === "low" ? "medium" : effort
    }
  ))
))

const votesByCandidate = new Map(candidates.map(c => [c.id, new Map()]))
for (const result of panelResults.filter(Boolean)) {
  for (const vote of result.votes || []) {
    if (!votesByCandidate.has(vote.candidate_id) || !LENSES.includes(vote.lens)) continue
    const byLens = votesByCandidate.get(vote.candidate_id)
    if (!byLens.has(vote.lens)) byLens.set(vote.lens, vote)
  }
}

const findings = []
const votes = {}
for (const candidate of candidates) {
  const byLens = votesByCandidate.get(candidate.id)
  const rows = LENSES.map(lens => byLens.get(lens)).filter(Boolean)
  const trueVotes = rows.filter(v => v.verdict === "TRUE_POSITIVE").length
  const complete = rows.length === 3
  const admitted = complete && trueVotes >= 2
  votes[candidate.id] = {
    complete,
    true_votes: trueVotes,
    false_votes: rows.filter(v => v.verdict === "FALSE_POSITIVE").length,
    needs_more_evidence: rows.filter(v => v.verdict === "NEEDS_MORE_EVIDENCE").length,
    rows
  }
  if (admitted) {
    findings.push({
      ...candidate,
      validation_status: mode === "static" ? "SOURCE_CONFIRMED" : (candidate.runtime_evidence ? "RUNTIME_CONFIRMED" : "NEEDS_LIVE_VALIDATION"),
      verifier_confidence: trueVotes === 3 ? "high" : "medium"
    })
  }
}

return {
  started: true,
  mode,
  strategy,
  plan: {
    workstream_count: workstreams.length,
    researcher_count: workstreams.length,
    max_explore_children_per_parent: 2,
    verifier_batches: batches.length,
    verifier_agents: batches.length * 3
  },
  coverage,
  candidates,
  votes,
  findings
}
