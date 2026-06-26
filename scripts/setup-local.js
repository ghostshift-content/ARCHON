#!/usr/bin/env node
// Local data-layer scaffolder for Kurukshetra.
//
// Recreates the parts of the production /root/intel data layer needed for the
// daemon to boot and the gate suite to run, under whatever KURU_INTEL_ROOT
// points at (default: <repo>/var/intel). Idempotent: existing files are left
// untouched, so re-running never clobbers local state you've built up.
//
//   node scripts/setup-local.js
//
// Reads roots through paths.js (which autoloads .env.local), so it always agrees
// with the daemon about where the data layer lives.
const fs = require('fs')
const path = require('path')
const agentPaths = require('../paths')

const INTEL = agentPaths.INTEL_ROOT
const AGENTS = agentPaths.AGENTS_ROOT

function info(msg) { console.log('  ' + msg) }

// Refuse to scaffold on top of the real production root unless explicitly forced —
// a guard so running this on the server can't accidentally seed defaults over live data.
if (INTEL === '/root/intel' && !process.env.KURU_FORCE_PROD_SEED) {
  console.error('Refusing to seed the production data layer (/root/intel).')
  console.error('Set KURU_INTEL_ROOT (e.g. in .env.local) to a local path first, or')
  console.error('export KURU_FORCE_PROD_SEED=1 to override. Aborting.')
  process.exit(1)
}

console.log(`Kurukshetra local setup`)
console.log(`  AGENTS_ROOT = ${AGENTS}`)
console.log(`  INTEL_ROOT  = ${INTEL}`)

// ── 1. Directory skeleton ──
const DIRS = [
  '', 'reports', 'tasks', 'orchestrator', 'streams', 'handoffs', 'pentest',
  'code-review', 'episodes', 'trajectory', 'archive', 'poc-evidence', 'scope',
  'logs', 'quarantine',
]
console.log('\n[1/3] Directories')
for (const d of DIRS) {
  const p = path.join(INTEL, d)
  if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); info('created ' + (d || '.')) }
}

// ── 2. Config files (sane, gate-valid defaults) ──
// Only written if absent. Sources: module fallbacks (model-router._hardcodedFallback)
// + the field requirements asserted by verify-framework.js gates.
const CONFIGS = {
  'model-config.json': {
    enabled: true,
    rollback_mode: 'disabled',
    families: { fast: 'claude-haiku-4-5', balanced: 'claude-sonnet-4-6', powerful: 'claude-opus-4-8' },
    effort_defaults: { fast: 'medium', balanced: 'high', powerful: 'xhigh' },
    role_defaults: {
      phase0_waf_auth: { family: 'balanced', effort: 'high' },
      recon: { family: 'fast', effort: 'medium' },
      vuln_specialist: { family: 'balanced', effort: 'high' },
      conditional: { family: 'balanced', effort: 'medium' },
      validation: { family: 'balanced', effort: 'high' },
      chain_analysis: { family: 'powerful', effort: 'xhigh' },
      report: { family: 'balanced', effort: 'high' },
      verification: { family: 'balanced', effort: 'high' },
      stock_leader: { family: 'powerful', effort: 'xhigh' },
      stock_analyst: { family: 'fast', effort: 'medium' },
      stock_challenger: { family: 'fast', effort: 'high' },
      grading: { family: 'fast', effort: 'low' },
      compliance: { family: 'fast', effort: 'high' },
      api_security: { family: 'balanced', effort: 'medium' },
    },
    // agent → role map (lowercase). Recon agents must stay on the fast family at
    // all complexity levels (GATE-15); leaders/judges/verifiers carry their roles.
    // Extend this as you wire up more personas; unmapped agents fall to
    // 'vuln_specialist' (balanced/high) — a safe default.
    agent_roles: {
      arjun: 'recon', rudra: 'recon', eklavya: 'recon',
      krishna: 'chain_analysis', chanakya: 'stock_leader',
      kripa: 'verification', dharmaraj: 'validation', vyasa: 'report',
    },
    complexity_scoring: { signals: [], tiers: [] },
    deny_family_downgrade_for: ['kripa', 'krishna', 'chanakya', 'vyasa', 'dharmaraj'],
  },
  'grader-config.json': {
    enabled: true,
    rollback_mode: 'disabled',
    llm_fallback: {
      enabled: true,
      model_family: 'fast',
      effort: 'low',
      use_batch_api: false,
      min_expectations_for_batch: 10,
      batch_max_wait_seconds: 60,
    },
    squad_grading_notes: {
      _default: 'Grade the published report against the eval expectations. Reward evidence-backed, in-scope findings; penalise hallucinated or unverifiable claims.',
    },
  },
  'prompts-config.json': {
    enabled: true,
    rollback_mode: 'disabled',
    versions: { specialist: 'v1', 'chain-analysis': 'v1' },
  },
  'target-profile-rules.json': {
    non_restriction_disclaimer: 'Profile is a hint, not a scope fence — a hypothesis to guide testing, never a restriction. It does not narrow the authorised scope; all in-scope targets remain testable regardless of inferred profile.',
    // Signature tables (header/body/hostname patterns → dimension value). Empty
    // by default → the classifier returns 'unknown' for every dimension (safe,
    // non-restrictive). Populate per dimension to enable real profiling.
    signatures: {},
    dimensions: {
      surface_shape: ['unknown', 'spa', 'mpa', 'api', 'graphql', 'mobile-backend'],
      tech_stack: ['unknown', 'node', 'python', 'java', 'php', 'dotnet', 'ruby', 'go'],
      auth_model: ['unknown', 'none', 'session', 'jwt', 'oauth', 'apikey', 'mtls'],
      hosting: ['unknown', 'aws', 'azure', 'gcp', 'onprem', 'cloudflare', 'vercel'],
      environment: ['unknown', 'production', 'staging', 'sandbox', 'local'],
      domain: ['unknown', 'fintech', 'ecommerce', 'saas', 'healthcare', 'gov', 'social'],
    },
    per_squad_strategy: {
      pentest: { emphasise: ['auth_model', 'surface_shape'] },
      'code-review': { emphasise: ['tech_stack'] },
    },
  },
}

console.log('\n[2/3] Config files')
for (const [name, body] of Object.entries(CONFIGS)) {
  const p = path.join(INTEL, name)
  if (fs.existsSync(p)) { info('kept ' + name); continue }
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n')
  info('seeded ' + name)
}

// ── 3. State files (empty collections the daemon reads/writes) ──
const STATE = {
  'tasks.json': [],
  'dispatch-queue.json': [],
  'projects.json': [],
  'pentest-batch-queue.json': [],
  'agent-status.json': {},
  'task-heartbeats.json': {},
  'quota.json': { providers: {}, history: [] },
  'manual-review-queue.json': [],
  'agent-model-overrides.json': { overrides: {} },
  'orchestrator/checkpoint.json': { ts: 0, tasks: [] },
}
const TOUCH = [
  'ACTIVITY-LOG.jsonl', 'suppression-ledger.jsonl', 'verification-log.jsonl',
  'learning-proposals.jsonl', 'episodes/episodes.jsonl', 'orchestrator/events.jsonl',
  'trajectory/observations.jsonl',
]

console.log('\n[3/3] State files')
for (const [name, body] of Object.entries(STATE)) {
  const p = path.join(INTEL, name)
  if (fs.existsSync(p)) { info('kept ' + name); continue }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n')
  info('seeded ' + name)
}
for (const name of TOUCH) {
  const p = path.join(INTEL, name)
  if (fs.existsSync(p)) { info('kept ' + name); continue }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '')
  info('touched ' + name)
}

console.log('\n✅ Local data layer ready at ' + INTEL)
console.log('   Next: npm run verify   (gate suite)   ·   npm start   (daemon)')
