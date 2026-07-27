'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const strategy = require('../src/runtime/blackbox-strategy')
const dashboard = require('../scripts/dashboard')

test('direct strategy skips infrastructure recon but always retains application mapping', () => {
  const plan = strategy.phasePlan({ scanStrategy: 'direct' })
  assert.equal(plan.strategy, 'direct')
  assert.equal(plan.runInfrastructureRecon, false)
  assert.equal(plan.runReconAgents, false)
  assert.equal(plan.runStandaloneFingerprintProbes, false)
  assert.equal(plan.runApplicationMapping, true)
  assert.equal(plan.runSpecialists, true)
  assert.equal(plan.scopeEnforced, true)
})

test('smart-auto and full-recon retain the expected phase shapes', () => {
  const focused = strategy.phasePlan({ customFocus: 'OAuth state binding abuse' })
  assert.equal(focused.strategy, 'smart_auto')
  assert.equal(focused.runInfrastructureRecon, false)
  assert.equal(focused.runReconAgents, true)
  assert.equal(focused.runApplicationMapping, true)

  const full = strategy.phasePlan({})
  assert.equal(full.strategy, 'full_recon')
  assert.equal(full.runInfrastructureRecon, true)
  assert.equal(full.runReconAgents, true)
  assert.equal(full.runStandaloneFingerprintProbes, true)
  assert.equal(full.runApplicationMapping, true)
})

test('dispatch normalization preserves direct + abuse focus without expanding scope', () => {
  const meta = dashboard.buildPentestMeta({ meta: {
    targetUrl: 'https://app.example.test',
    scanStrategy: 'direct',
    inScope: ['app.example.test'],
    outOfScope: ['payments.example.test'],
    customFocus: 'abuse invite acceptance to cross tenant boundaries',
  } })
  assert.equal(meta.scanStrategy, 'direct')
  assert.equal(meta.skipRecon, true)
  assert.match(meta.customFocus, /cross tenant/)
  assert.deepEqual(meta.inScope, ['app.example.test'])
  assert.deepEqual(meta.outOfScope, ['payments.example.test'])
})

test('dispatch rejects contradictory in-scope and out-of-scope hosts', () => {
  assert.throws(() => dashboard.buildPentestMeta({ meta: {
    targetUrl: 'https://app.example.test',
    inScope: ['app.example.test'],
    outOfScope: ['app.example.test'],
    customFocus: 'attempt an abuse case',
  } }), /scope conflict/)
})

test('daemon direct path maps with TRACER before applying the recon-agent skip', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'event-bus.js'), 'utf8')
  const mapMarker = source.indexOf('Application mapping is mandatory for EVERY black-box strategy')
  const tracer = source.indexOf('await runtracerAgent(targetUrl, taskId)', mapMarker)
  const reconGate = source.indexOf('const _skipRecon = !_blackboxPlan.runReconAgents', mapMarker)
  assert.ok(mapMarker > 0)
  assert.ok(tracer > mapMarker)
  assert.ok(reconGate > tracer, 'TRACER application mapping occurs before direct-mode SCOUT/RANGER gate')
})

test('focused execution and reporting replace the full A-Z mandates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'event-bus.js'), 'utf8')
  assert.match(source, /## FOCUSED COVERAGE MANDATE/)
  assert.match(source, /The full A-Z vulnerability mandate is disabled for this dispatch/)
  assert.match(source, /This was intentionally NOT an A-Z scan/)
  assert.match(source, /Read ONLY the focus-gated validated findings/)
  assert.match(source, /focus-rejected-/)
})

test('UI exposes and serializes direct and abuse-driven controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8')
  const app = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8')
  assert.match(html, /id="ptSkipRecon"/)
  assert.match(html, /Direct application test/)
  assert.match(html, /Custom \/ abuse-driven/)
  assert.match(app, /scanStrategy: skipRecon \? 'direct'/)
  assert.match(app, /meta\.customFocus = customFocus/)
})

test('dummy dispatch writes a direct mission, scope, and abuse brief without network activity', () => {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-direct-dry-'))
  const root = path.join(__dirname, '..')
  const child = spawnSync(process.execPath, ['-e', `
    const dashboard = require('./scripts/dashboard')
    const result = dashboard.createDispatch({
      squad: 'pentest',
      taskTitle: 'Direct abuse dry run',
      meta: {
        targetUrl: 'https://app.example.test',
        scanStrategy: 'direct',
        inScope: ['app.example.test'],
        outOfScope: ['payments.example.test'],
        customFocus: 'test invite acceptance across tenant boundaries'
      }
    })
    process.stdout.write(JSON.stringify(result))
  `], {
    cwd: root,
    env: { ...process.env, KURU_AGENTS_ROOT: root, KURU_INTEL_ROOT: intel },
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)
  const dispatch = JSON.parse(child.stdout)
  assert.ok(dispatch.taskId)

  const scope = JSON.parse(fs.readFileSync(path.join(intel, `scope-${dispatch.taskId}.json`), 'utf8'))
  assert.deepEqual(scope.in_scope, ['app.example.test'])
  assert.deepEqual(scope.out_of_scope, ['payments.example.test'])

  const brief = fs.readFileSync(path.join(intel, `pentest-brief-${dispatch.taskId}.md`), 'utf8')
  assert.match(brief, /Scan strategy:\*\* direct/)
  assert.match(brief, /invite acceptance across tenant boundaries/)
  assert.match(brief, /never expands or overrides the authorized scope/)
  assert.match(brief, /payments\.example\.test/)

  const queuedFiles = fs.readdirSync(path.join(intel, 'inbox', 'task-actions'))
  assert.equal(queuedFiles.length, 1)
  const queued = JSON.parse(fs.readFileSync(path.join(intel, 'inbox', 'task-actions', queuedFiles[0]), 'utf8'))
  assert.equal(queued.meta.scanStrategy, 'direct')
  assert.equal(queued.meta.skipRecon, true)
  assert.equal(queued.meta.customFocus, 'test invite acceptance across tenant boundaries')
})

test('dummy focused dispatch preserves exactly XSS + access-control in the daemon inbox', () => {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-focus-dry-'))
  const root = path.join(__dirname, '..')
  const child = spawnSync(process.execPath, ['-e', `
    const dashboard = require('./scripts/dashboard')
    const result = dashboard.createDispatch({
      squad: 'pentest',
      taskTitle: 'Focused dry run',
      meta: {
        targetUrl: 'https://app.example.test',
        inScope: ['app.example.test'],
        focusClasses: ['xss', 'access-control']
      }
    })
    process.stdout.write(JSON.stringify(result))
  `], {
    cwd: root,
    env: { ...process.env, KURU_AGENTS_ROOT: root, KURU_INTEL_ROOT: intel },
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)
  const queuedFile = fs.readdirSync(path.join(intel, 'inbox', 'task-actions'))[0]
  const queued = JSON.parse(fs.readFileSync(path.join(intel, 'inbox', 'task-actions', queuedFile), 'utf8'))
  assert.deepEqual(queued.meta.focusClasses, ['xss', 'access-control'])
  assert.equal(queued.meta.scanStrategy, 'smart_auto')
})
