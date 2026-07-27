'use strict'
// Step 4: holistic review — one session per coherent workstream, emits candidates. Offline (stub spawnAgent).
const { test } = require('node:test'); const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const H = require('../src/runtime/holistic-review')

function srcDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'holi-'))
  fs.mkdirSync(path.join(d, 'app'))
  fs.writeFileSync(path.join(d, 'app', 'a.rb'), 'class A; def show; User.find(params[:id]); end; end')
  fs.writeFileSync(path.join(d, 'app', 'b.rb'), 'class B; def q; execute("... #{params[:q]}"); end; end')
  return d
}

test('small project → ONE holistic session that emits candidates (no feature×class fan-out)', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-'))
  let spawns = 0, emitted = 0
  const deps = {
    spawnAgent: async (agent, taskId, prompt, suffix) => {
      spawns++
      const m = prompt.match(/one per line\) to: (\S+)/)
      if (m) { fs.mkdirSync(path.dirname(m[1]), { recursive: true }); fs.writeFileSync(m[1],
        JSON.stringify({ feature: 'show', vuln_class: 'access-control', file: 'app/a.rb', line: 1, source: 'params[:id]', sink: 'User.find', status: 'SOURCE_CONFIRMED' }) + '\n' +
        JSON.stringify({ feature: 'q', vuln_class: 'sql-injection', file: 'app/b.rb', line: 1, source: 'params[:q]', sink: 'execute', status: 'SOURCE_CONFIRMED' }) + '\n') }
      return { agentName: agent, code: 0, cost: { totalCost: 0, tokens: { total: 1 } }, output: 'done' }
    },
    log: () => {}, trackCosts: () => {},
    emitFromFile: (file) => { const n = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length; emitted += n; return n },
  }
  const features = [{ slug: 'show', domain: 'app' }, { slug: 'q', domain: 'app' }]
  const res = await H.runHolistic(deps, { taskId: 't-holo', sourceDir: sd, features, vulnClasses: ['access-control', 'sqli'], outDir })
  assert.equal(res.plan.session_count, 1, 'small project → 1 holistic session')
  assert.equal(spawns, 1, 'exactly ONE session spawned (not features×classes)')
  assert.equal(emitted, 2, 'both candidates emitted from the one session')
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})

test('holistic prompt covers all lenses + authz/logic reasoning', () => {
  const p = H.buildHolisticPrompt({ id: 'workstream-1', domains: ['app'] }, { sourceDir: '/x', files: ['a.rb'], outFile: '/o/c.jsonl' })
  assert.match(p, /access-control/); assert.match(p, /business logic/i); assert.match(p, /CSRF/); assert.match(p, /mass-assignment/)
  assert.match(p, /who is allowed/i); assert.match(p, /SOURCE_CONFIRMED/)
})

test('focused holistic review instructs and accounts for only selected classes', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-focus-'))
  let promptSeen = ''
  const deps = {
    spawnAgent: async (agent, taskId, prompt) => {
      promptSeen = prompt
      const m = prompt.match(/one per line\) to: (\S+)/)
      fs.mkdirSync(path.dirname(m[1]), { recursive: true })
      fs.writeFileSync(m[1],
        JSON.stringify({ feature: 'search-query', vuln_class: 'sql-injection', file: 'app/b.rb', line: 1, status: 'SOURCE_CONFIRMED' }) + '\n' +
        JSON.stringify({ feature: 'show', vuln_class: 'access-control', file: 'app/a.rb', line: 1, status: 'SOURCE_CONFIRMED' }) + '\n')
      return { code: 0, cost: { totalCost: 0, tokens: { total: 1 } } }
    },
    log: () => {}, trackCosts: () => {},
    emitFromFile: () => 1,
  }
  const res = await H.runHolistic(deps, {
    taskId: 't-focus', sourceDir: sd,
    features: [{ slug: 'show', domain: 'app' }, { slug: 'search-query', domain: 'app' }],
    vulnClasses: ['sqli'], outDir,
  })
  assert.match(promptSeen, /Review ONLY the vulnerability lenses/)
  assert.match(promptSeen, /\n  - sqli\n/)
  assert.doesNotMatch(promptSeen, /\n  - access-control \(IDOR\/BOLA\)\n/)
  assert.equal(res.coverage.find((c) => c.feature === 'search-query').candidate_count, 1)
  assert.equal(res.coverage.find((c) => c.feature === 'show').candidate_count, 0)
  assert.deepEqual(res.coverage[0].classes_reviewed, ['sqli'])
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})
