'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.join(__dirname, '..')
const paths = require('../paths')
const ownershipDoc = require('../ownership.json')
const ownership = ownershipDoc.map || ownershipDoc
const registry = require('../src/agents/registry')
const focus = require('../src/pipeline/focus-map')
const codeReview = require('../src/dispatch/code-review-dispatcher')
const dashboard = require('../scripts/dashboard')

test('ownership, descriptive registry, and persona files contain the same agent set', () => {
  const owned = Object.keys(ownership).map(x => x.toUpperCase()).sort()
  assert.deepEqual(registry.all().sort(), owned)
  for (const name of Object.keys(ownership)) {
    assert.ok(fs.existsSync(paths.soulPath(name)), `${name}: missing SOUL.md`)
  }
})

test('every black-box focus class resolves to an owned pentest persona with the matching specialty', () => {
  for (const [vulnerabilityClass, agents] of Object.entries(focus.PENTEST_FOCUS_MAP)) {
    assert.ok(agents.length, `${vulnerabilityClass}: no specialist`)
    for (const agent of agents) {
      assert.equal(ownership[agent], 'squads/pentest', `${vulnerabilityClass}: ${agent} is not owned by pentest`)
      assert.ok(registry.specialtiesOf(agent).includes(vulnerabilityClass),
        `${vulnerabilityClass}: ${agent} registry specialty is missing`)
      assert.ok(fs.existsSync(paths.soulPath(agent)), `${vulnerabilityClass}: ${agent} persona missing`)
    }
  }
})

test('every source-review class resolves to an owned code-review persona and skill bundle', () => {
  for (const [vulnerabilityClass, config] of Object.entries(codeReview.CLASS)) {
    assert.equal(ownership[config.agent], 'squads/code-review',
      `${vulnerabilityClass}: ${config.agent} is not owned by code-review`)
    assert.ok(registry.specialtiesOf(config.agent).includes(vulnerabilityClass),
      `${vulnerabilityClass}: ${config.agent} registry specialty is missing`)
    const skills = paths.skillsDir(config.agent)
    assert.ok(fs.existsSync(skills) && fs.readdirSync(skills).length > 0,
      `${vulnerabilityClass}: ${config.agent} has no skill bundle`)
  }
})

test('dashboard accepts every source class the dispatcher can execute without renaming or dropping it', () => {
  for (const vulnerabilityClass of Object.keys(codeReview.CLASS)) {
    const meta = dashboard.buildCodeReviewMeta({
      meta: { sourceDir: ROOT, vulnClasses: [vulnerabilityClass] },
    })
    assert.deepEqual(meta.vulnClasses, [vulnerabilityClass])
  }
})

test('legacy source class aliases normalize to one canonical executable class', () => {
  for (const [legacy, canonical] of Object.entries(codeReview.CLASS_ALIASES)) {
    const meta = dashboard.buildCodeReviewMeta({
      meta: { sourceDir: ROOT, vulnClasses: [legacy] },
    })
    assert.deepEqual(meta.vulnClasses, [canonical])
  }
})

test('conditional focus specialists are selectable but excluded from unconditional core waves', () => {
  const source = fs.readFileSync(path.join(ROOT, 'event-bus.js'), 'utf8')
  assert.match(source, /PENTEST_CONDITIONAL_SPECIALISTS\s*=\s*\['ranger', 'spectre', 'decoy'\]/)
  assert.match(source, /pentestSelectableSpecialists\(\)/)
  assert.match(source, /const _focusedCore = _focus \? _focus\.filter/)
  assert.match(source, /const _dynBatches = _focus \? batchesFromList\(_focusedCore\)/)
})

test('literal spawnAgent targets all resolve to real personas', () => {
  const files = [
    'event-bus.js',
    'src/dispatch/code-review-dispatcher.js',
    'src/runtime/holistic-review.js',
  ]
  const targets = new Set()
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/spawnAgent\(\s*['"]([a-z0-9-]+)['"]/gi)) {
      targets.add(match[1].toLowerCase())
    }
  }
  assert.ok(targets.size > 5, 'spawn target extraction unexpectedly found too few agents')
  const missing = [...targets].filter(agent => !fs.existsSync(paths.soulPath(agent)))
  assert.deepEqual(missing, [], `literal spawn targets without personas: ${missing.join(', ')}`)
})

test('explicit persona skill references resolve on disk', () => {
  const source = fs.readFileSync(path.join(ROOT, 'event-bus.js'), 'utf8')
  const references = []
  const pattern = /agentPaths\.skillsDir\(['"]([a-z0-9-]+)['"]\)\}\/([a-z0-9-]+)\/SKILL\.md/gi
  for (const match of source.matchAll(pattern)) {
    references.push({ agent: match[1], skill: match[2] })
  }
  assert.ok(references.length >= 4, 'explicit skill extraction unexpectedly found too few references')
  const missing = references.filter(({ agent, skill }) =>
    !fs.existsSync(path.join(paths.skillsDir(agent), skill, 'SKILL.md')))
  assert.deepEqual(missing, [], `broken explicit skill references: ${JSON.stringify(missing)}`)
})
