
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// ════════════════════════════════════════════════════════════════════════════
// Code-review squad dispatcher — phase1-maps white-box methodology
// ════════════════════════════════════════════════════════════════════════════
// Replaces the old 6-framework→chain flow with a two-phase, feature-by-feature
// process (ported from the operator's own GitLab review methodology):
//
//   Phase 0   sourceDir validation
//   Phase 0b  App Blueprint — CURATOR reads inventories + tree + bootstrap/auth/
//             config files → a 1-page architecture/auth/data-flow/shared-infra doc
//             that grounds discovery + every feature mapper (catches cross-feature
//             vulns the feature-by-feature pass would miss in isolation)
//   Phase 0a  Inventories — scripted enumeration (routes/api/graphql/workers/
//             services/finders/policies/serializers/downloads/search/tokens)
//   Phase 0b  Feature discovery — gitlab preset (43) | generic (CURATOR) | meta.features
//   Phase 1   Feature mapping — ONE agent per feature, in RAM-safe waves; each
//             builds features/<slug>.md (Endpoint/Action Ledger + auth/actor/data/
//             worker/same-functionality maps + ranked Phase-2 leads + depth status)
//   Phase 1c  Consolidation — CURATOR aggregates coverage matrices + review queue + gate
//   Phase 2   Vuln assessment — per feature × per class, routed to the class specialist
//             with that class's module + pattern catalog (access-control/IDOR, XSS, …)
//   Phase 2v  AUDITOR reverse-check verdicts (+ PROBER runtime validation if deployUrl)
//   Phase 3   SCRIBE merges per-feature reports into the final report (CVSS)
//
// Agents (current env, working together): CURATOR (discovery+consolidation),
// the 6 specialists (per-feature mappers → per-class assessors), AUDITOR (verify),
// PROBER (runtime), SCRIBE (report).
//
// dispatch.meta:
//   sourceDir   (required, absolute) — the source tree to review
//   preset      'gitlab' | 'generic'  (default: auto-detect gitlab markers, else generic)
//   features    string[] (optional)   — explicit feature-slug queue (overrides discovery)
//   vulnClasses string[] (optional)   — default ['access-control','xss']
//   deployUrl   (optional)            — enables PROBER runtime validation
//   testAccounts(optional)            — { attacker, victim } creds for runtime probing
//   outputDir   (optional)            — default <INTEL>/code-review/<taskId>
//   maxFeatures (optional)            — cap mapped features (default: gitlab=43, generic=10)
//   maxPhase2   (optional)            — cap features taken to Phase 2 (default 6, by queue rank)
//   phasesOnly  (optional)            — subset of PHASES to run (reuse prior artifacts)

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const METH = path.join(__roots.AGENTS_ROOT, 'squads/code-review/methodology')
const PRESET_GITLAB = path.join(METH, 'presets/gitlab-features.json')

// vuln class → { specialist, phase-2 module, pattern catalog }
const CLASS = {
  'access-control': { agent: 'marshal', module: 'phase2_access_control_idor_v1.md', catalog: 'access_control_40_pattern_catalog.md' },
  'xss':            { agent: 'cipher',         module: 'phase2_xss_html_injection_v1.md',  catalog: 'xss_50_pattern_catalog.md' },
  'sqli':           { agent: 'quill',     module: null, catalog: null },
  'ssrf':           { agent: 'beacon',      module: null, catalog: null },
  'rce':            { agent: 'breaker',        module: null, catalog: null },
  'account-takeover': { agent: 'siphon',      module: null, catalog: null },
}
const MAPPER_POOL = ['marshal', 'siphon', 'cipher', 'quill', 'beacon', 'breaker']
const PHASES = ['inventories', 'blueprint', 'discovery', 'mapping', 'consolidate', 'phase2', 'verify', 'report']
const WAVE = 3 // RAM-safe parallelism (mirrors GATE-134 stocks batching)

// The fixed Phase-1 feature-map contract (enforced in the prompt; full template on disk).
const FEATURE_SECTIONS = [
  'Feature Identity', 'Feature Purpose', 'Entry Points', 'Files Reviewed',
  'Endpoint / Action Ledger', 'Full Code Paths', 'Authorization Map',
  'Authentication / Actor Context Map', 'Data Exposure Map', 'Background Job Map',
  'Same-Functionality Map', 'Security-Sensitive Areas for Phase 2 (ranked)', 'Coverage Notes',
]
const LEDGER_COLS = 'Entry Point | Method/Trigger | File | Class/Method | Object Lookup | Auth Check | Object Authorized | Response/State Change | Serializer/Worker | Same-Functionality Siblings | Phase1 Status | Phase2 Priority | Gaps'
const DEPTH = 'Discovered → Mapped → Traced → AuthZ Verified → Deep Complete'

// ── helpers ──────────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

async function runWaves(items, size, fn) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size)
    out.push(...await Promise.all(batch.map((it, j) => fn(it, i + j))))
  }
  return out
}

function detectPreset(sourceDir) {
  // GitLab markers: a Rails app with GitLab's signature layout.
  try {
    if (fs.existsSync(path.join(sourceDir, 'config/routes.rb')) &&
        (fs.existsSync(path.join(sourceDir, 'GITLAB_WORKHORSE_VERSION')) ||
         fs.existsSync(path.join(sourceDir, 'ee')) ||
         fs.existsSync(path.join(sourceDir, 'app/graphql')))) return 'gitlab'
  } catch {}
  return 'generic'
}

// Scripted inventory enumeration (grep — universally available). Each spec writes
// one inventory file; counts feed the coverage denominator. Fail-soft per spec.
function buildInventories(sourceDir, invDir, preset, log) {
  fs.mkdirSync(invDir, { recursive: true })
  const RUBY = ['--include=*.rb']
  const GENERIC_CODE = ['--include=*.rb', '--include=*.py', '--include=*.js', '--include=*.ts', '--include=*.go', '--include=*.java', '--include=*.php', '--include=*.cs', '--include=*.rs']
  const specs = preset === 'gitlab' ? [
    ['01_routes', '(resources?|resource|get|post|put|patch|delete|namespace|scope|draw)\\b', RUBY],
    ['02_rest_api', '(resource|get|post|put|delete|namespace|route_setting|requires|optional)\\b', RUBY],
    ['03_graphql', '(field|mutation|resolver|argument|authorize|type)\\b', RUBY],
    ['04_workers', '(class .*Worker|perform_async|perform_in|perform_at|perform_bulk|sidekiq_options)', RUBY],
    ['05_services_finders_policies', '(class .*(Service|Finder|Policy)|def execute|can\\?|allowed\\?|rule \\{)', RUBY],
    ['06_response_shaping', '(class .*(Serializer|Entity|Presenter)|expose |represent )', RUBY],
    ['07_downloads_exports', '(send_file|send_data|signed_url|object_storage|ExportService|archive|presigned)', RUBY],
    ['08_search_count', '(search|count|aggregate|\\.where\\(|Finder)', RUBY],
    ['09_tokens_actors', '(current_user|access_token|personal_access_token|api_key|impersonat|actor|principal)', RUBY],
  ] : [
    ['01_routes_endpoints', '(@(app|router)\\.(get|post|put|delete|patch)|app\\.(get|post|route)|router\\.|@(Get|Post|Put|Delete|RequestMapping|RestController)|http\\.HandleFunc|def [a-z_]+\\(.*request)', GENERIC_CODE],
    ['02_auth_checks', '(authorize|authenticate|permission|access_control|can\\?|isAuthenticated|@PreAuthorize|require_role|ensure_|before_action)', GENERIC_CODE],
    ['03_db_queries', '(SELECT |find_by|findOne|\\.query\\(|\\.where\\(|prepareStatement|execute\\(|raw\\()', GENERIC_CODE],
    ['04_render_output', '(render|innerHTML|dangerouslySetInnerHTML|\\.html\\(|template|res\\.send|raw\\()', GENERIC_CODE],
    ['05_uploads_downloads', '(upload|download|send_file|sendFile|multipart|res\\.download|presigned|object_storage)', GENERIC_CODE],
    ['06_tokens_actors', '(token|session|cookie|jwt|api_key|current_user|currentUser|principal|actor)', GENERIC_CODE],
  ]
  const counts = {}
  for (const [name, pattern, globs] of specs) {
    const file = path.join(invDir, `${name}.txt`)
    try {
      const cmd = `grep -rEn ${globs.join(' ')} -e ${JSON.stringify(pattern)} . 2>/dev/null | head -8000`
      const out = execSync(cmd, { cwd: sourceDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: '/bin/bash' })
      fs.writeFileSync(file, out)
      counts[name] = out ? out.trimEnd().split('\n').filter(Boolean).length : 0
    } catch (e) {
      // grep exits 1 when no matches — that's a 0, not an error
      try { fs.writeFileSync(file, '') } catch {}
      counts[name] = 0
    }
  }
  const manifest = `# Phase 1 — Source-of-Truth Inventory Manifest

Target: \`${sourceDir}\`
Preset: **${preset}**
Method: scripted grep enumeration (source-parsed; the agents re-grep + read live code during mapping).

## Inventory files

| File | Matches |
|---|---|
${Object.entries(counts).map(([n, c]) => `| \`${n}.txt\` | ${c} |`).join('\n')}

## Reconciliation rule
Every inventory item must land in exactly one of: (1) mapped to a feature + ledger row,
(2) shared infrastructure mapped to all consuming features, (3) not security-relevant (with reason),
(4) unclear → Phase 1 gap, (5) dead/unreachable (with evidence). No item disappears silently.
`
  fs.writeFileSync(path.join(invDir, '00_MANIFEST.md'), manifest)
  log(`  📇 Inventories: ${Object.entries(counts).map(([n, c]) => `${n}=${c}`).join(', ')}`)
  return counts
}

// ── prompt builders (self-contained — read the ported methodology pack) ───────
function commonHeader(taskId, sourceDir, outDir, invDir) {
  return `Source tree (read-only target): ${sourceDir}
Phase-1 inventories (grep enumeration, your starting denominator): ${invDir}/
Output dir (write your artifacts here, absolute paths): ${outDir}/
Methodology pack (read these for the exact contract): ${METH}/
Use bash (rg/grep/cat/sed) to enumerate and read source. This is MAPPING + EVIDENCE work — produce files, not chat.`
}

function blueprintPrompt(taskId, sourceDir, outDir, invDir) {
  return `You are CURATOR, code-review squad leader. Produce the APP BLUEPRINT — a one-page architectural orientation that EVERY downstream feature reviewer reads first. Understand the whole system BEFORE the parts.

${commonHeader(taskId, sourceDir, outDir, invDir)}

Read the inventories + the source-tree layout + the key bootstrap/config files (framework entrypoints, routing tables, auth middleware, ORM/models, settings/env, docker/CI). Do NOT map features yet — this is orientation.

Write a concise (~1 page) blueprint to ${outDir}/phase1-maps/app-blueprint.md with EXACTLY these sections:
1. ## What this application is — purpose, domain, primary actors/personas.
2. ## Tech stack & infrastructure — languages, framework(s), datastores, queues/workers, external services, how it deploys.
3. ## Authentication & authorization model — how a request is authenticated (session/JWT/OAuth/API key), how identity → roles, where authZ is enforced (middleware/decorators/policy objects), and how object ownership / tenancy is checked. Name the EXACT files.
4. ## Shared infrastructure & cross-cutting code — middleware, base controllers, serializers, input parsing/sanitization, file storage, payment, rate-limiting, logging — anything MANY features depend on (where cross-feature vulns hide).
5. ## Data flow & trust boundaries — where untrusted input enters, how it reaches sinks (DB/render/shell/HTTP), and which trust boundaries it crosses.
6. ## Highest-risk areas to prioritize — 3-7 architectural hot spots for Phase 2, each with the file/dir and why.

Cite exact files/dirs. Then reply one line: stack, auth mechanism, top architectural risk.`
}

function featureMapPrompt(agent, feature, taskId, sourceDir, outDir, invDir) {
  const outFile = `${outDir}/phase1-maps/features/${feature.slug}.md`
  return `You are ${agent.toUpperCase()}, a Phase-1 feature-mapping agent on the code-review squad (leader CURATOR).

${commonHeader(taskId, sourceDir, outDir, invDir)}

## Your single feature: ${feature.name} (slug: ${feature.slug})
${feature.keywords ? `Scope keywords/paths: ${feature.keywords}` : ''}

Phase 1 is **mapping, not vulnerability hunting** — do NOT report confirmed vulns. Record security-sensitive
areas, suspicious paths, Phase-2 leads, gaps, assumptions, and required follow-up.

## Method (feature-by-feature, evidence-based)
0. Read the App Blueprint at ${outDir}/phase1-maps/app-blueprint.md FIRST — use its auth/authZ model + shared-infra map when tracing this feature's auth/actor/object-lookup/serializer paths (so you catch where this feature relies on shared, possibly-flawed, infrastructure).
1. grep the inventory files in ${invDir}/ scoped to this feature's keywords, then read the live source under ${sourceDir}.
2. Build the Endpoint/Action Ledger — ONE ROW per route+method / mutation / worker / action. Never merge GET/POST/PUT/DELETE. Never "CRUD reviewed".
3. Trace auth / actor / object-lookup / serializer / worker paths for representative and high-risk rows.
4. Record an honest depth status per row: ${DEPTH}.

## Required output — write the file to: ${outFile}
Use EXACTLY this section order (read ${METH}/templates/phase1_feature_map_template.md for the full table shapes):
${FEATURE_SECTIONS.map((s, i) => `${i + 1}. ## ${s}`).join('\n')}

The Endpoint / Action Ledger table columns (exact):
${LEDGER_COLS}

Ranked Security-Sensitive Areas: for each lead give exact file/method/route, why it matters, what Phase 2 must verify, the likely pattern class (access-control/IDOR, XSS, sqli, ssrf, rce, account-takeover), and which surface (Web/REST/GraphQL/worker/same-functionality) it affects.
Coverage Notes must be honest: what's AuthZ-verified vs mapped-only, assumptions, unmapped files, blockers.

Write the complete markdown file with bash (mkdir -p the dir first). Then reply with a one-line summary: rows mapped, top lead, residual gaps.`
}

function discoveryPrompt(taskId, sourceDir, outDir, invDir, cap) {
  return `You are CURATOR, code-review squad leader. Discover the FEATURE QUEUE for a Phase-1 white-box review.

${commonHeader(taskId, sourceDir, outDir, invDir)}

Read the App Blueprint at ${outDir}/phase1-maps/app-blueprint.md (architecture/auth/shared-infra/data-flow) and the
inventories + source tree layout (top-level dirs, route/controller/module groupings), then propose the
distinct security-relevant FEATURE AREAS to map (e.g. authentication, file-upload, admin, api-keys, search, webhooks…).
Group by business capability, not by file. Cap at ${cap} features (most security-relevant first).

Write the queue to ${outDir}/phase1-maps/feature-queue.json as:
{"features":[{"slug":"kebab-slug","name":"Display Name","keywords":"comma,separated,grep,hints"}, ...]}

Then reply with the JSON array only (no prose) so the orchestrator can parse it.`
}

function consolidationPrompt(taskId, outDir, features) {
  return `You are CURATOR, code-review squad leader. Consolidate Phase 1.

Read every feature map in ${outDir}/phase1-maps/features/*.md (${features.length} features: ${features.map(f => f.slug).join(', ')}).
Read the consolidated templates: ${METH}/templates/phase1_consolidated_templates.md and the gate ${METH}/checklists/phase1_completion_gate.md.

Write these files under ${outDir}/phase1-maps/consolidated/ (use bash, follow the templates):
- 00_INDEX.md
- feature_coverage_matrix.md          (per-feature depth-status rollup)
- source_inventory_coverage_matrix.md (inventory items reconciled vs gaps — the denominator vs numerator)
- same_functionality_cross_feature_map.md (recurring patterns reviewed as classes, not one-offs)
- phase2_review_queue.md              (ranked, evidence-backed Phase-2 leads aggregated from each map's top risks + gaps, each pointing back to features/<slug>.md)
- phase1_completion_gate.md           (honest: incomplete reconciliation / unresolved rows = blockers; evidence not confidence)

Then reply with a one-line summary: features consolidated, total ledger rows, top Phase-2 classes, open blockers.`
}

function phase2Prompt(cls, agent, feature, taskId, sourceDir, outDir) {
  const c = CLASS[cls]
  const mapFile = `${outDir}/phase1-maps/features/${feature.slug}.md`
  const outFile = `${outDir}/phase2/${cls}/${feature.slug}.md`
  const moduleLine = c.module ? `Vuln module (follow it exactly): ${METH}/prompts/${c.module}` : `(no dedicated module for ${cls} — use your ${cls}-review skill)`
  const catalogLine = c.catalog ? `Pattern catalog (apply EVERY pattern): ${METH}/catalogs/${c.catalog}` : `(no catalog — apply your skill's full pattern set for ${cls})`
  return `You are ${agent.toUpperCase()}, Phase-2 ${cls} assessor on the code-review squad.

Source tree: ${sourceDir}
Phase-1 feature map (your input — read it fully): ${mapFile}
${moduleLine}
${catalogLine}
Router + anti-drift contract: ${METH}/prompts/phase2_vulnerability_assessment_router.md , ${METH}/checklists/anti_drift_execution_contract.md
Report template + CVSS: ${METH}/templates/phase2_feature_report_template.md , ${METH}/templates/cvss_scoring_guide.md

## Execution (per-feature, row-by-row — NOT batch/coordinator output)
1. Load the feature map's Endpoint/Action Ledger, files, gaps, required follow-up, same-functionality notes, ranked leads.
2. Build a reverse-check matrix: review EVERY ledger row + EVERY listed file + EVERY unresolved Mapped/Traced/Discovered/GAP/Verify item + same-functionality siblings — ranked leads set ORDER, not scope.
3. Re-read the source behind each row. Apply the full ${cls} pattern catalog.
4. Produce a source-backed per-feature report (evidence tables, review matrix, findings with file:line traces + CVSS, gaps). NOT an orchestration log.

Write the report to: ${outFile} (mkdir -p first). Then reply one line: rows reverse-checked, findings (by severity), residual gaps.`
}

function auditorPrompt(taskId, outDir, features, classes) {
  return `You are AUDITOR, the independent verifier. Reverse-check the Phase-2 code-review findings — never trust the assessor's claim.

Read the Phase-2 reports under ${outDir}/phase2/**/*.md (classes: ${classes.join(', ')}; features: ${features.map(f => f.slug).join(', ')}).
For each reported finding: re-read the cited source path, confirm the auth/object-lookup/sink claim is real, and issue a verdict
(CONFIRMED / NEEDS-LIVE / DISPROVEN) with a one-line evidence reason. Demote anything you cannot substantiate from source.

Write verdicts to ${outDir}/phase2/AUDITOR-VERDICTS.md (a table: feature | class | finding | verdict | evidence). Reply one line: confirmed/needs-live/disproven counts.`
}

function scribePrompt(taskId, projectId, squad, sourceDir, outDir, features, classes) {
  return `You are SCRIBE, the reporter. Merge the per-feature Phase-2 reports into ONE final code-review report.

Inputs (read all):
- ${outDir}/phase1-maps/consolidated/phase1_completion_gate.md and phase2_review_queue.md
- ${outDir}/phase2/**/*.md  (per-feature reports, classes: ${classes.join(', ')})
- ${outDir}/phase2/AUDITOR-VERDICTS.md  (only report AUDITOR-CONFIRMED or NEEDS-LIVE findings as findings; note disproven separately)

Produce an executive white-box code-review report: scope + coverage (features mapped, depth-status rollup), confirmed findings
ordered by CVSS (each with file:line trace, impact, fix), a recurring-pattern section (same-functionality classes), and honest gaps.
Do NOT include orchestration logs. Keep per-feature structure traceable.

Write the report to ${outDir}/FINAL-REPORT-${taskId}.md AND to ${__roots.INTEL_ROOT}/code-review/FINAL-REPORT-${taskId}.md.
Reply one line: features covered, confirmed findings by severity, top risk.`
}

// ── main ──────────────────────────────────────────────────────────────────────
async function runCodeReview(dispatch, deps) {
  const { spawnAgent, trackCosts, updateProgress, log, logActivity } = deps
  const { taskId, projectId, squad } = dispatch
  const meta = dispatch.meta || {}
  const sourceDir = meta.sourceDir

  const runPhase = (p) => !Array.isArray(meta.phasesOnly) || meta.phasesOnly.length === 0 || meta.phasesOnly.includes(p)
  const outDir = meta.outputDir || `${__roots.INTEL_ROOT}/code-review/${taskId}`
  const deployUrl = meta.deployUrl || null

  // Phase 0 — validate
  updateProgress(4, 'Phase 0: sourceDir validation')
  const p0 = validateSourceDir(sourceDir)
  if (!p0.ok) {
    log(`🚫 Phase 0 failed: ${p0.reason}`)
    logActivity('NEXUS', `🚫 Phase 0 failed: ${p0.reason}`, { taskId, squad, projectId: projectId || '' })
    return { error: p0.reason, phase: 0 }
  }
  const preset = (meta.preset === 'gitlab' || meta.preset === 'generic') ? meta.preset : detectPreset(sourceDir)
  const vulnClasses = (Array.isArray(meta.vulnClasses) && meta.vulnClasses.length
    ? meta.vulnClasses : ['access-control', 'xss']).filter(c => CLASS[c])
  const maxFeatures = meta.maxFeatures || (preset === 'gitlab' ? 43 : 10)
  const maxPhase2 = meta.maxPhase2 || 6
  fs.mkdirSync(`${outDir}/phase1-maps/features`, { recursive: true })
  fs.mkdirSync(`${outDir}/phase1-maps/consolidated`, { recursive: true })
  for (const c of vulnClasses) fs.mkdirSync(`${outDir}/phase2/${c}`, { recursive: true })
  const invDir = `${outDir}/phase1-maps/inventories`
  log(`✅ Phase 0: sourceDir=${sourceDir} (${p0.fileCount} code files) · preset=${preset} · classes=${vulnClasses.join(',')}`)
  logActivity('NEXUS', `✅ Phase 0: source valid (${preset})`, {
    taskId, squad, projectId: projectId || '',
    details: `Path: ${sourceDir}\nFiles: ${p0.fileCount}\nPreset: ${preset}\nVuln classes: ${vulnClasses.join(', ')}\nOutput: ${outDir}\nDeploy URL: ${deployUrl || '(none — runtime validation skipped)'}`,
  })

  // Phase 0a — inventories
  if (runPhase('inventories')) {
    updateProgress(10, 'Phase 0a: scripted inventory enumeration')
    buildInventories(sourceDir, invDir, preset, log)
  }

  // Phase 0b — App Blueprint (understand the whole system before mapping the parts).
  // Produces app-blueprint.md (architecture / auth model / shared infra / data flow)
  // that discovery + every feature mapper read first — surfaces cross-feature vulns
  // (shared serializer, global middleware, one auth gate) that per-feature passes miss.
  if (runPhase('blueprint')) {
    updateProgress(13, 'Phase 0b: CURATOR app blueprint')
    logActivity('CURATOR', `🧭 Phase 0b: app blueprint (architecture / auth / shared infra / data flow)`, { taskId, squad, projectId: projectId || '' })
    const bRes = await spawnAgent('curator', taskId, blueprintPrompt(taskId, sourceDir, outDir, invDir), `task-${taskId}-blueprint`, null)
    trackCosts([bRes])
  }

  // Phase 0c — feature queue
  let features = []
  if (Array.isArray(meta.features) && meta.features.length) {
    features = meta.features.map(f => typeof f === 'string' ? { slug: slugify(f), name: f } : f).slice(0, maxFeatures)
    log(`📋 Feature queue from meta.features: ${features.length}`)
  } else if (preset === 'gitlab') {
    try { features = JSON.parse(fs.readFileSync(PRESET_GITLAB, 'utf8')).features.slice(0, maxFeatures) } catch { features = [] }
    log(`📋 GitLab preset feature queue: ${features.length}`)
  } else if (runPhase('discovery')) {
    updateProgress(16, 'Phase 0c: CURATOR feature discovery')
    const dRes = await spawnAgent('curator', taskId, discoveryPrompt(taskId, sourceDir, outDir, invDir, maxFeatures), `task-${taskId}-discovery`, null)
    trackCosts([dRes])
    try {
      const qf = `${outDir}/phase1-maps/feature-queue.json`
      if (fs.existsSync(qf)) features = JSON.parse(fs.readFileSync(qf, 'utf8')).features || []
      else { const m = (dRes.output || dRes.stdout || '').match(/\[[\s\S]*\]/); if (m) features = JSON.parse(m[0]) }
    } catch (e) { log(`  ⚠️ discovery parse failed: ${e.message}`) }
    features = (features || []).map(f => ({ ...f, slug: slugify(f.slug || f.name) })).slice(0, maxFeatures)
    log(`📋 Discovered ${features.length} features`)
  }
  if (!features.length) {
    log(`🚫 No feature queue — aborting (provide meta.features or enable discovery)`)
    return { error: 'empty feature queue', phase: 'discovery' }
  }

  // Phase 1 — per-feature mapping (one agent per feature, RAM-safe waves)
  if (runPhase('mapping')) {
    updateProgress(25, `Phase 1: mapping ${features.length} features (waves of ${WAVE})`)
    logActivity('CURATOR', `🗺️ Phase 1: ${features.length} feature-mapping agents`, { taskId, squad, projectId: projectId || '', details: features.map(f => f.slug).join(', ') })
    const results = await runWaves(features, WAVE, async (feature, idx) => {
      const agent = MAPPER_POOL[idx % MAPPER_POOL.length]
      const r = await spawnAgent(agent, taskId, featureMapPrompt(agent, feature, taskId, sourceDir, outDir, invDir), `task-${taskId}-map-${feature.slug}`, null)
      return r
    })
    trackCosts(results)
  }

  // Phase 1c — consolidation
  if (runPhase('consolidate')) {
    updateProgress(55, 'Phase 1c: CURATOR consolidation')
    const cRes = await spawnAgent('curator', taskId, consolidationPrompt(taskId, outDir, features), `task-${taskId}-consolidate`, null)
    trackCosts([cRes])
  }

  // Phase 2 — vuln assessment (top-N features × each class, routed to specialists)
  const p2Features = features.slice(0, maxPhase2)
  if (maxPhase2 < features.length) log(`ℹ️ Phase 2 capped to top ${maxPhase2}/${features.length} features (raise meta.maxPhase2 for full coverage)`)
  if (runPhase('phase2')) {
    updateProgress(62, `Phase 2: ${p2Features.length} features × ${vulnClasses.length} classes`)
    const jobs = []
    for (const cls of vulnClasses) for (const feature of p2Features) jobs.push({ cls, feature })
    const results = await runWaves(jobs, WAVE, async ({ cls, feature }) => {
      const agent = CLASS[cls].agent
      return spawnAgent(agent, taskId, phase2Prompt(cls, agent, feature, taskId, sourceDir, outDir), `task-${taskId}-p2-${cls}-${feature.slug}`, null)
    })
    trackCosts(results)
  }

  // Phase 2v — AUDITOR verify (+ PROBER runtime if deployUrl)
  if (runPhase('verify')) {
    if (deployUrl) {
      updateProgress(82, 'Phase 2v: PROBER runtime validation')
      const uRes = await spawnAgent('prober', taskId,
        `You are PROBER, runtime validator. Probe the deployed instance at ${deployUrl} (testAccounts: ${JSON.stringify(meta.testAccounts || null)}) to confirm/refute the Phase-2 candidates under ${outDir}/phase2/. Write runtime verdicts to ${outDir}/phase2/PROBER-RUNTIME.md.`,
        `task-${taskId}-prober`, null)
      trackCosts([uRes])
    }
    updateProgress(86, 'Phase 2v: AUDITOR reverse-check')
    const kRes = await spawnAgent('auditor', taskId, auditorPrompt(taskId, outDir, p2Features, vulnClasses), `task-${taskId}-auditor`, null)
    trackCosts([kRes])
  }

  // Phase 3 — SCRIBE report
  if (runPhase('report')) {
    updateProgress(94, 'Phase 3: SCRIBE final report')
    const vRes = await spawnAgent('scribe', taskId, scribePrompt(taskId, projectId, squad, sourceDir, outDir, p2Features, vulnClasses), `task-${taskId}-scribe`, null)
    trackCosts([vRes])
  }

  updateProgress(100, 'Complete')
  return {
    preset, sourceDir, fileCount: p0.fileCount,
    features: features.map(f => f.slug),
    featuresMapped: features.length,
    phase2Features: p2Features.map(f => f.slug),
    vulnClasses,
    outputDir: outDir,
  }
}

// ── Phase 0 source validation (unchanged contract) ────────────────────────────
function validateSourceDir(sourceDir) {
  if (!sourceDir) return { ok: false, reason: 'missing dispatch.meta.sourceDir' }
  if (typeof sourceDir !== 'string') return { ok: false, reason: 'dispatch.meta.sourceDir must be a string' }
  if (!path.isAbsolute(sourceDir)) return { ok: false, reason: `sourceDir must be absolute path, got: ${sourceDir}` }
  let stat
  try { stat = fs.statSync(sourceDir) } catch (e) {
    return { ok: false, reason: `sourceDir not accessible: ${String(e.message || e).slice(0, 120)}` }
  }
  if (!stat.isDirectory()) return { ok: false, reason: `sourceDir is not a directory: ${sourceDir}` }
  const CODE_EXTS = [
    '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.svelte',
    '.py', '.pyw', '.rb', '.pl', '.pm', '.go', '.rs', '.zig',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.m', '.mm',
    '.java', '.kt', '.kts', '.scala', '.groovy', '.cs', '.fs', '.vb',
    '.swift', '.dart', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.hs', '.ml', '.mli',
    '.php', '.phtml', '.html', '.htm', '.ejs', '.hbs', '.lua', '.r', '.tf', '.hcl',
    '.sh', '.bash', '.zsh', '.ps1', '.proto', '.thrift', '.gql', '.graphql', '.sql',
  ]
  let fileCount = 0
  function walk(dir, depth) {
    if (depth > 3) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (fileCount > 100) return
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && CODE_EXTS.some(ext => e.name.endsWith(ext))) fileCount++
    }
  }
  walk(sourceDir, 0)
  if (fileCount === 0) {
    return { ok: false, reason: `sourceDir has no recognized code files (~50 extensions checked). Is this a source tree?` }
  }
  return { ok: true, fileCount }
}

module.exports = {
  runCodeReview,
  validateSourceDir,
  // exported for tests/introspection
  detectPreset,
  buildInventories,
  CLASS,
  MAPPER_POOL,
  PHASES,
}
