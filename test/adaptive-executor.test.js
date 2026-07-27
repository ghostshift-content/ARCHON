'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const sdk = require('../agents/runner/adapters/sdk')
const toolGate = require('../src/runtime/tool-scope-gate')
const executor = require('../src/runtime/agentic-executor')
const artifacts = require('../src/runtime/runtime-artifacts')
const runtimeDispatch = require('../src/runtime/runtime-dispatch')

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'archon-executor-')) }
function child(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)))
  })
}
function denied(value) {
  return value && value.hookSpecificOutput && value.hookSpecificOutput.permissionDecision === 'deny'
}
function sdkMessages(result) {
  return (async function * () {
    yield { type: 'system', subtype: 'init', model: 'test-model' }
    yield {
      type: 'result', subtype: 'success', is_error: false,
      result: JSON.stringify(result), usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'test-model': { costUSD: 0 } },
    }
  })()
}

test('tool scope gate denies out-of-scope network calls and source shell execution', async () => {
  const blackbox = toolGate.createToolScopeGate({
    mode: 'blackbox',
    scope: { in_scope: ['app.example.test'], out_of_scope: ['admin.example.test'] },
  })
  assert.strictEqual(denied(await blackbox({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://admin.example.test/private' },
  })), true)
  assert.strictEqual(denied(await blackbox({
    tool_name: 'Bash',
    tool_input: { command: 'curl https://unknown.example.test/' },
  })), true)
  assert.deepStrictEqual(await blackbox({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://app.example.test/api' },
  }), {})

  const pathScoped = toolGate.createToolScopeGate({
    mode: 'blackbox',
    scope: {
      in_scope: ['app.example.test'],
      paths_allow: ['/api/*'],
      paths_deny: ['/api/admin/*'],
      hard_limits: { destructive_actions: false, max_rps_per_host: 1 },
    },
  })
  assert.strictEqual(denied(await pathScoped({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://app.example.test/settings' },
  })), true)
  assert.strictEqual(denied(await pathScoped({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://app.example.test/api/admin/users' },
  })), true)
  assert.deepStrictEqual(await pathScoped({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://app.example.test/api/users' },
  }), {})
  assert.strictEqual(denied(await pathScoped({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://app.example.test/api/orders' },
  })), true)
  assert.strictEqual(denied(await pathScoped({
    tool_name: 'Bash',
    tool_input: { command: 'curl -X DELETE https://app.example.test/api/users/1' },
  })), true)

  const source = toolGate.createToolScopeGate({ mode: 'static', sourceRoots: ['/repo'] })
  assert.strictEqual(denied(await source({
    tool_name: 'Bash',
    tool_input: { command: 'bundle exec rake' },
  })), true)
  assert.strictEqual(denied(await source({
    tool_name: 'Read',
    tool_input: { file_path: '/etc/passwd' },
  })), true)
})

test('SDK combines the production guard with a caller scope hook and tool allowlist', async () => {
  let options
  await sdk.run({
    userPrompt: 'test',
    allowedTools: ['Read', 'WebFetch'],
    preToolUse: async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'test scope deny',
      },
    }),
    _query: ({ options: captured }) => {
      options = captured
      return sdkMessages({ ok: true })
    },
  })
  assert.deepStrictEqual(options.allowedTools, ['Read', 'WebFetch'])
  const hook = options.hooks.PreToolUse[0].hooks[0]
  const result = await hook({ tool_name: 'WebFetch', tool_input: { url: 'https://example.test' } })
  assert.strictEqual(denied(result), true)
})

test('structured executor validates triage partitions and writes a fresh hashed report', async () => {
  const dir = temp()
  const taskId = 'executor-test'
  artifacts.appendCandidates(taskId, [{
    id: 'CAND-1',
    title: 'Candidate',
    class: 'access-control',
    severity: 'high',
    file: 'app/a.rb',
    line: 1,
    sink: 'update',
    evidence_refs: ['source:app/a.rb:1'],
    exploit_hypothesis: 'A user may update another record.',
  }], 'static', dir)
  const outputs = [
    {
      summary: 'triaged',
      evidence_refs: ['source:app/a.rb:1'],
      accepted_ids: ['CAND-1'],
      dropped: [],
      no_issue: false,
    },
    {
      summary: 'reported',
      report_markdown: `# Security report\n\n${'Evidence-backed report content. '.repeat(12)}`,
      evidence_refs: ['source:app/a.rb:1'],
    },
  ]
  const execute = executor.createExecutor({
    taskId,
    runtimeRoot: dir,
    mode: 'static',
    sourceRoots: [dir],
    runAgent: async spec => ({
      text: JSON.stringify(outputs.shift()),
      usage: {},
      model: 'test',
      raw: { spec },
    }),
  })
  const session = { role: 'TRIAGER', heartbeat() {} }
  const triage = await execute({ phase: 'triage', candidate_ids: ['CAND-1'] }, session)
  assert.deepStrictEqual(triage.candidate_updates, [{ id: 'CAND-1', accepted: true }])

  const report = await execute({ phase: 'report', candidate_ids: ['CAND-1'] }, { role: 'SCRIBE', heartbeat() {} })
  assert.strictEqual(report.report_generated, true)
  assert.match(report.report_path, /FINAL-REPORT-executor-test\.md$/)
  assert.strictEqual(report.report_digest.length, 64)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('research candidates resolve labels to immutable hashed evidence', async () => {
  const dir = temp()
  const taskId = 'evidence-test'
  const execute = executor.createExecutor({
    taskId,
    runtimeRoot: dir,
    mode: 'static',
    sourceRoots: [dir],
    runAgent: async () => ({
      text: JSON.stringify({
        summary: 'reviewed',
        evidence: [{
          label: 'src-1',
          kind: 'source_snippet',
          source: 'app/a.rb:1',
          content: 'record.update(params)',
        }],
        evidence_refs: ['src-1'],
        candidates: [{
          title: 'Missing ownership check',
          class: 'access-control',
          severity: 'high',
          file: 'app/a.rb',
          line: 1,
          sink: 'update',
          evidence_refs: ['src-1'],
          exploit_hypothesis: 'A different user may update this record.',
        }],
        followups: [],
        terminal_coverage: [{
          skill_family: 'access-control',
          status: 'candidate',
          reason: 'candidate emitted',
          evidence_refs: ['src-1'],
        }],
        no_issue: false,
      }),
      usage: {},
      model: 'test',
    }),
  })
  const result = await execute({ phase: 'research', candidate_ids: [] }, {
    role: 'ARCHON_RESEARCHER',
    heartbeat() {},
  })
  assert.match(result.candidates[0].evidence_refs[0], /^EVID-/)
  const evidenceFile = path.join(dir, 'runtime-evidence', taskId, `${result.candidates[0].evidence_refs[0]}.json`)
  assert.strictEqual(fs.existsSync(evidenceFile), true)
  assert.strictEqual(fs.statSync(evidenceFile).mode & 0o777, 0o600)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runtime dispatch uses one source session when a repository fits its context budget', () => {
  const dir = temp()
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'app', 'controller.rb'), 'class Controller; end\n')
  const input = runtimeDispatch.buildInput({
    taskId: 'source-small',
    squad: 'code-review',
    meta: { sourceDir: dir },
    goal: 'Review source',
    model: 'opus-4-8',
  })
  assert.strictEqual(input.mode, 'static')
  assert.strictEqual(input.workstreams.length, 1)
  assert.deepStrictEqual(input.workstreams[0].files, ['app/controller.rb'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('parallel model candidate IDs are replaced with unique runtime-owned IDs', () => {
  const dir = temp()
  const first = artifacts.appendCandidates('candidate-ids', [{
    id: 'CAND-1',
    class: 'xss',
    endpoint: '/comments',
    parameter: 'body',
  }], 'blackbox', dir)
  const second = artifacts.appendCandidates('candidate-ids', [{
    id: 'CAND-1',
    class: 'access-control',
    endpoint: '/users/123',
    parameter: 'id',
  }], 'blackbox', dir)
  assert.strictEqual(first.length, 1)
  assert.strictEqual(second.length, 2)
  assert.strictEqual(new Set(second.map(row => row.id)).size, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('parallel agent processes do not lose candidate or mission-journal updates', async () => {
  const dir = temp()
  const artifactsModule = path.join(__dirname, '..', 'src', 'runtime', 'runtime-artifacts.js')
  const journalModule = path.join(__dirname, '..', 'src', 'runtime', 'mission-journal.js')
  const script = `
    const artifacts = require(process.argv[1])
    const journal = require(process.argv[2])
    const dir = process.argv[3]
    const worker = process.argv[4]
    for (let i = 0; i < 12; i++) {
      const marker = String.fromCharCode(97 + i)
      artifacts.appendCandidates('parallel', [{
        id: 'CAND-1',
        class: worker + '-class-' + marker,
        endpoint: '/' + worker + '/' + marker,
        parameter: 'field-' + marker
      }], 'blackbox', dir)
      journal.append('parallel', 'WORKER_EVENT', { worker, i }, {
        dir,
        idempotencyKey: worker + ':' + i
      })
    }
  `
  await Promise.all([
    child(script, [artifactsModule, journalModule, dir, 'alpha']),
    child(script, [artifactsModule, journalModule, dir, 'beta']),
  ])
  const journal = require('../src/runtime/mission-journal').load('parallel', dir)
  const candidates = artifacts.candidates('parallel', dir)
  assert.strictEqual(candidates.length, 24)
  assert.strictEqual(new Set(candidates.map(row => row.id)).size, 24)
  assert.strictEqual(journal.length, 24)
  assert.deepStrictEqual(journal.map(row => row.seq).sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1))
  fs.rmSync(dir, { recursive: true, force: true })
})
