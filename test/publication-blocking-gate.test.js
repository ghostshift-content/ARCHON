
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/publication-blocking-gate.test.js
//
// FIX 1 (2026-05-09): real ARBITER publication gate. Sprint B.3 added
// an informational banner; this gate makes the block REAL — moves the
// report file out of /root/intel/reports/ and into reports-blocked/, and
// updates tasks.json to status='blocked' so triagers cannot accidentally
// publish unverified work.
//
// Functions under test live in event-bus.js. Two tactics:
//   (a) module-level grep tests — confirms wiring + thresholds
//   (b) functional tests — extract helper bodies into a temp module file,
//       require() it, and call the real implementations against a tmp dir.
//       (event-bus.js doesn't export — module is a server with side-effects.)

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SRC_PATH = path.resolve(__dirname, '..', 'event-bus.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf-8')

// ── Module-level grep tests ────────────────────────────────────────────────

test('event-bus.js defines shouldBlockPublication helper', () => {
  assert.match(SRC, /function shouldBlockPublication\s*\(/,
    'must define a shouldBlockPublication helper')
})

test('event-bus.js defines blockReportPublication helper', () => {
  assert.match(SRC, /function blockReportPublication\s*\(/,
    'must define a blockReportPublication helper')
})

test('shouldBlockPublication uses FALSE_POSITIVE OR PARTIAL<50 thresholds', () => {
  const fnStart = SRC.indexOf('function shouldBlockPublication')
  const fnSlice = SRC.slice(fnStart, fnStart + 800)
  assert.match(fnSlice, /FALSE_POSITIVE/, 'must trigger on FALSE_POSITIVE')
  assert.match(fnSlice, /PARTIAL/, 'must consider PARTIAL verdict')
  assert.match(fnSlice, /passRate\s*<\s*50/,
    'must use 50% threshold for PARTIAL (stricter than banner\'s 70%)')
})

test('blockReportPublication moves to /root/intel/reports-blocked/', () => {
  const fnStart = SRC.indexOf('function blockReportPublication')
  const fnSlice = SRC.slice(fnStart, fnStart + 4000)
  assert.match(fnSlice, /reports-blocked/,
    'must move report into reports-blocked/ subdir')
  assert.match(fnSlice, /reports\//,
    'must reference source reports/ path')
})

test('blockReportPublication writes tasks.json status=blocked', () => {
  const fnStart = SRC.indexOf('function blockReportPublication')
  const fnSlice = SRC.slice(fnStart, fnStart + 4000)
  assert.match(fnSlice, /status\s*=\s*['"]blocked['"]/,
    'must set status="blocked" on the matching task')
  assert.match(fnSlice, /blockedAt|blockReason/,
    'must record blockedAt + blockReason metadata')
})

test('blockReportPublication banner text is more severe than warning banner', () => {
  const fnStart = SRC.indexOf('function blockReportPublication')
  const fnSlice = SRC.slice(fnStart, fnStart + 4000)
  assert.match(fnSlice, /PUBLICATION BLOCKED/,
    'must use PUBLICATION BLOCKED phrasing (not just WARNING)')
})

test('blockReportPublication is idempotent — does not double-move', () => {
  const fnStart = SRC.indexOf('function blockReportPublication')
  const fnSlice = SRC.slice(fnStart, fnStart + 4000)
  // Idempotency check: either skip-if-already-moved or check for prior banner.
  assert.match(fnSlice, /PUBLICATION BLOCKED|already|existsSync/,
    'must short-circuit if report already moved/blocked')
})

test('all 3 verificationLoop call sites invoke shouldBlockPublication', () => {
  // After each prependPublicationStatusBanner call we should call
  // shouldBlockPublication + blockReportPublication.
  const callSites = SRC.match(/shouldBlockPublication\s*\(/g) || []
  // 1 definition + 3 call sites; allow >= 4
  assert.ok(callSites.length >= 4,
    `expected at least 4 references (def + 3 call sites), got ${callSites.length}`)
})

test('all 3 verificationLoop call sites invoke blockReportPublication', () => {
  const callSites = SRC.match(/blockReportPublication\s*\(/g) || []
  assert.ok(callSites.length >= 4,
    `expected at least 4 references (def + 3 call sites), got ${callSites.length}`)
})

// ── Functional tests via extracted helper module ───────────────────────────

function buildHelperModule() {
  // Extract function bodies and write them to a tmp file as a CommonJS module.
  function extractFn(src, name) {
    const idx = src.indexOf(`function ${name}`)
    if (idx < 0) throw new Error(`fn ${name} not found`)
    let depth = 0, started = false, end = idx
    for (let i = idx; i < src.length; i++) {
      const c = src[i]
      if (c === '{') { depth++; started = true }
      else if (c === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
    }
    return src.slice(idx, end)
  }
  const fnShould = extractFn(SRC, 'shouldBlockPublication')
  const fnBlock = extractFn(SRC, 'blockReportPublication')

  const moduleCode = `
const fs = require('node:fs')
const path = require('node:path')
function log(_msg) {}
function logActivity(_a, _m, _o) {}
let TASKS_FILE = '/tmp/_pub-block-test-tasks.json'
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return [] } }
function writeJSON(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)) }
${fnShould}
${fnBlock}
module.exports = {
  shouldBlockPublication, blockReportPublication,
  setTasksFile: (p) => { TASKS_FILE = p },
  getTasksFile: () => TASKS_FILE,
}
`
  const tmpPath = path.join(os.tmpdir(), `_pub-block-helpers-${process.pid}.js`)
  fs.writeFileSync(tmpPath, moduleCode)
  return tmpPath
}

let helpers
let helperPath
test('setup: extract helper module', () => {
  helperPath = buildHelperModule()
  helpers = require(helperPath)
})

test('shouldBlockPublication: FALSE_POSITIVE → true', () => {
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'FALSE_POSITIVE', passRate: 0 }), true)
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'FALSE_POSITIVE', passRate: 100 }), true,
    'FALSE_POSITIVE blocks regardless of passRate')
})

test('shouldBlockPublication: PARTIAL passRate < 50 → true', () => {
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'PARTIAL', passRate: 45 }), true)
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'PARTIAL', passRate: 0 }), true)
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'PARTIAL', passRate: 49 }), true)
})

test('shouldBlockPublication: PARTIAL passRate >= 50 → false', () => {
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'PARTIAL', passRate: 50 }), false)
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'PARTIAL', passRate: 75 }), false)
})

test('shouldBlockPublication: CONFIRMED → false', () => {
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'CONFIRMED', passRate: 100 }), false)
  assert.strictEqual(helpers.shouldBlockPublication({ verdict: 'CONFIRMED', passRate: 50 }), false)
})

test('shouldBlockPublication: missing/null/empty → false (fail-soft)', () => {
  assert.strictEqual(helpers.shouldBlockPublication(null), false)
  assert.strictEqual(helpers.shouldBlockPublication(undefined), false)
  assert.strictEqual(helpers.shouldBlockPublication({}), false)
})

test('blockReportPublication: moves file, prepends banner, updates tasks.json', () => {
  const taskId = `pub-block-test-${Date.now()}`
  const tasksFile = path.join(os.tmpdir(), `_tasks-${taskId}.json`)
  helpers.setTasksFile(tasksFile)

  const reportsDir = (__roots.INTEL_ROOT + '/reports')
  const blockedDir = (__roots.INTEL_ROOT + '/reports-blocked')
  const srcReport = path.join(reportsDir, `${taskId}.md`)
  const dstReport = path.join(blockedDir, `${taskId}.md`)

  try { fs.mkdirSync(reportsDir, { recursive: true }) } catch {}
  fs.writeFileSync(srcReport, '# Sample Pentest Report\n\nFindings...\n')
  fs.writeFileSync(tasksFile, JSON.stringify([
    { id: taskId, title: 'sample', status: 'in-progress', progress: 50 }
  ], null, 2))

  const arbiter = { verdict: 'FALSE_POSITIVE', passRate: 0 }
  helpers.blockReportPublication(taskId, arbiter, 'ARBITER verdict: FALSE_POSITIVE')

  assert.ok(!fs.existsSync(srcReport), 'src report must be removed from reports/')
  assert.ok(fs.existsSync(dstReport), 'dst must exist in reports-blocked/')
  const dst = fs.readFileSync(dstReport, 'utf-8')
  assert.match(dst, /PUBLICATION BLOCKED/, 'banner must mention PUBLICATION BLOCKED')
  assert.match(dst, /Sample Pentest Report/, 'original report content preserved')

  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'))
  const task = tasks.find(t => t.id === taskId)
  assert.strictEqual(task.status, 'blocked', 'task status must be blocked')
  assert.ok(task.blockedAt, 'task.blockedAt must be set')
  assert.ok(task.blockReason, 'task.blockReason must be set')

  try { fs.unlinkSync(dstReport) } catch {}
  try { fs.unlinkSync(tasksFile) } catch {}
})

test('blockReportPublication: idempotent — second call is a no-op', () => {
  const taskId = `pub-block-idem-${Date.now()}`
  const tasksFile = path.join(os.tmpdir(), `_tasks-idem-${taskId}.json`)
  helpers.setTasksFile(tasksFile)

  const srcReport = `${__roots.INTEL_ROOT}/reports/${taskId}.md`
  const dstReport = `${__roots.INTEL_ROOT}/reports-blocked/${taskId}.md`

  try { fs.mkdirSync((__roots.INTEL_ROOT + '/reports'), { recursive: true }) } catch {}
  fs.writeFileSync(srcReport, '# Test Report Content\n')
  fs.writeFileSync(tasksFile, JSON.stringify([
    { id: taskId, title: 'sample', status: 'in-progress' }
  ], null, 2))

  const r = { verdict: 'FALSE_POSITIVE', passRate: 0 }
  helpers.blockReportPublication(taskId, r, 'reason A')
  const firstContent = fs.readFileSync(dstReport, 'utf-8')

  helpers.blockReportPublication(taskId, r, 'reason B')
  const secondContent = fs.readFileSync(dstReport, 'utf-8')

  const matches = (secondContent.match(/PUBLICATION BLOCKED/g) || []).length
  assert.ok(matches >= 1, 'must have at least one banner')
  assert.ok(matches <= 1, `must NOT double-prepend banner — got ${matches}`)
  assert.strictEqual(firstContent, secondContent, 'second call must be a no-op')

  try { fs.unlinkSync(dstReport) } catch {}
  try { fs.unlinkSync(tasksFile) } catch {}
})

test('cleanup: remove helper module', () => {
  try { fs.unlinkSync(helperPath) } catch {}
})
