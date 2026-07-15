'use strict'
// Candidate-integrity pipeline (the Gate-3 defects): distinct candidates must never collapse, a triage-omitted
// candidate must be requeued not dropped, the board is rebuilt from ALL candidates by candidate_id, a missing or
// unknown auditor verdict fails CLOSED (quarantined, kept out of the report), and identity/location come from the
// immutable candidate — never the model. Pure pieces are unit-tested; the reconcile is exercised against files.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { identityKey } = require('../src/pipeline/suspected-dedup')
const { nextBatch } = require('../src/pipeline/streaming-triage')
const cr = require('../src/dispatch/code-review-dispatcher')
const INTEL = require('../paths').INTEL_ROOT

// A distinct weakness has a distinct candidate_id even when file+class+title are identical (read vs update IDOR).
test('distinct candidates on the same file/class do NOT collapse (the 12→11 loss)', () => {
  const readIdor = { type: 'candidate', candidate_id: 'user-accounts:access-control:users_controller.rb:show-idor', agent: 'marshal', cwe: 'CWE-639', details: 'IDOR in user-accounts' }
  const updIdor = { type: 'candidate', candidate_id: 'user-accounts:access-control:users_controller.rb:update-ownership', agent: 'marshal', cwe: 'CWE-639', details: 'IDOR in user-accounts' }
  assert.notEqual(identityKey(readIdor), identityKey(updIdor))
  const seen = new Set()
  assert.equal(nextBatch([readIdor, updIdor], seen).length, 2, 'both distinct candidates survive pickup')
})

// A candidate the model omitted is un-seen (RETRYABLE) → the next tick re-picks it.
test('a requeued candidate is re-picked on the next poll (RETRYABLE, not dropped)', () => {
  const c = { type: 'candidate', candidate_id: 'x:y:z', agent: 'marshal', details: 'issue' }
  const seen = new Set()
  assert.equal(nextBatch([c], seen).length, 1, 'first pickup')
  assert.equal(nextBatch([c], seen).length, 0, 'already seen → not re-picked')
  seen.delete(identityKey(c))                                  // requeue (what _requeueOrQuarantine does)
  assert.equal(nextBatch([c], seen).length, 1, 're-picked after requeue')
})

// reconcileBoardFromVerdicts: rebuild from ALL candidates, fail-closed on missing/unknown, identity from candidate.
test('reconcile rebuilds from ALL candidates: N candidates = N terminal verdicts, fail-closed, identity immutable', () => {
  const taskId = `test-integrity-${process.pid}`
  const VF = path.join(INTEL, `VALIDATED-FINDINGS-${taskId}.jsonl`)
  const LEDGER = path.join(INTEL, `candidate-ledger-${taskId}.jsonl`)
  const FLAG = path.join(INTEL, `VALIDATED-AUTHORITATIVE-${taskId}.flag`)
  const VERDICTS = path.join(INTEL, `verdicts-${taskId}.jsonl`)
  const cleanup = () => { for (const f of [VF, LEDGER, FLAG, VERDICTS]) { try { fs.unlinkSync(f) } catch {} } }
  cleanup()
  try {
    // 5 distinct candidates
    const cand = (id, feature, cls, file) => ({ candidate_id: id, feature, vulnerability_class: cls, file, line: 3, source: 'params', sink: 'exec', agent: 'marshal' })
    const candidates = [
      cand('c1', 'search', 'sql-injection', 'search.rb'),
      cand('c2', 'comments', 'xss', 'comments.rb'),
      cand('c3', 'comments', 'csrf', 'sessions.rb'),     // distinct from c2 even though model tried to relabel it XSS
      cand('c4', 'user-accounts', 'access-control', 'users.rb'),
      cand('c5', 'admin', 'access-control', 'admin.rb'),
    ]
    // triage writeups — note c4 is MISSING (triage omitted it), and c3 carries a WRONG (XSS) title/file the model tried
    fs.writeFileSync(VF, [
      { id: 'T-1', candidate_id: 'c1', title: 'SQLi', severity: 'High', code_block: 'q(raw)' },
      { id: 'T-2', candidate_id: 'c2', title: 'Stored XSS', severity: 'Medium', code_block: '<%= x %>' },
      { id: 'T-3', candidate_id: 'c3', title: 'Stored XSS', severity: 'Medium', file: 'WRONG.rb', vulnerability_class: 'xss', code_block: 'csrf' },
      { id: 'T-5', candidate_id: 'c5', title: 'Weak admin', severity: 'High', code_block: 'if admin' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n')
    // auditor verdicts — c1 confirmed, c2 needs-live, c3 disproven, c4 MISSING (no verdict), c5 UNKNOWN status
    fs.writeFileSync(VERDICTS, [
      { candidate_id: 'c1', status: 'SOURCE_CONFIRMED', evidence: 'search.rb:3' },
      { candidate_id: 'c2', status: 'NEEDS_LIVE_VALIDATION', evidence: 'render path unknown' },
      { candidate_id: 'c3', status: 'DISPROVEN', evidence: 'protect_from_forgery present' },
      { candidate_id: 'c5', status: 'MAYBE_PROBABLY', evidence: 'garbled' },   // unknown → must be rejected
    ].map(r => JSON.stringify(r)).join('\n') + '\n')

    const res = cr.reconcileBoardFromVerdicts(taskId, VERDICTS, candidates, () => {})

    // ledger accounts for ALL 5 candidates (12=12 accounting)
    const ledger = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(ledger.length, 5, 'every candidate reaches a terminal ledger row')
    const term = Object.fromEntries(ledger.map(r => [r.candidate_id, r.terminal_status]))
    assert.equal(term.c1, 'SOURCE_CONFIRMED')
    assert.equal(term.c2, 'NEEDS_LIVE_VALIDATION')
    assert.equal(term.c3, 'DISPROVEN')
    assert.equal(term.c4, 'AUDIT_QUARANTINED', 'no verdict → fail-closed quarantine, NOT fail-open')
    assert.equal(term.c5, 'AUDIT_QUARANTINED', 'unknown status → rejected, NOT promoted to SOURCE_CONFIRMED')

    // board = only the report-worthy set (confirmed + needs-live); disproven/quarantined excluded from Judge/report
    const board = fs.readFileSync(VF, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const boardIds = board.map(r => r.candidate_id).sort()
    assert.deepEqual(boardIds, ['c1', 'c2'], 'only c1(confirmed)+c2(needs-live) reach the board')

    // identity immutable — c3 was excluded, but had it been kept, file/class come from the candidate, not the model.
    // Verify via c2: the board record keeps the candidate's file/class, not any model override.
    const c2rec = board.find(r => r.candidate_id === 'c2')
    assert.equal(c2rec.file, 'comments.rb', 'file from the immutable candidate')
    assert.equal(c2rec.vulnerability_class, 'xss')
    assert.equal(c2rec.requires_runtime_validation, true, 'needs-live derives the boolean')
    const c1rec = board.find(r => r.candidate_id === 'c1')
    assert.equal(c1rec.requires_runtime_validation, false, 'source-confirmed → false (no contradiction)')

    // authoritative sentinel written → downstream cr-normalize / triager skip
    assert.ok(fs.existsSync(FLAG), 'authoritative-board sentinel written')
    assert.equal(res.board, 2); assert.equal(res.ledger, 5)
  } finally { cleanup() }
})

// Round-2 enforcement: runtime status is code-enforced, duplicate/foreign verdicts rejected, title from candidate.
test('reconcile enforces runtime status, rejects duplicate/foreign verdicts, and takes title from the candidate', () => {
  const taskId = `test-integrity2-${process.pid}`
  const VF = path.join(INTEL, `VALIDATED-FINDINGS-${taskId}.jsonl`)
  const LEDGER = path.join(INTEL, `candidate-ledger-${taskId}.jsonl`)
  const FLAG = path.join(INTEL, `VALIDATED-AUTHORITATIVE-${taskId}.flag`)
  const VERDICTS = path.join(INTEL, `verdicts2-${taskId}.jsonl`)
  const cleanup = () => { for (const f of [VF, LEDGER, FLAG, VERDICTS]) { try { fs.unlinkSync(f) } catch {} } }
  cleanup()
  try {
    const cand = (id, feature, cls, file, title) => ({ candidate_id: id, feature, vulnerability_class: cls, file, title, agent: 'marshal' })
    const candidates = [
      cand('r1', 'search', 'sql-injection', 'search.rb', 'SQL injection via search param'),
      cand('r2', 'admin', 'access-control', 'admin.rb'),          // auditor emits RUNTIME_CONFIRMED (static → invalid)
      cand('r3', 'comments', 'xss', 'comments.rb'),               // two verdicts (ambiguous)
    ]
    // triage record for r1 tries to RENAME the finding — must be ignored (title comes from the candidate)
    fs.writeFileSync(VF, [{ id: 'T-1', candidate_id: 'r1', title: 'Totally Different Name', severity: 'High' }].map(r => JSON.stringify(r)).join('\n') + '\n')
    fs.writeFileSync(VERDICTS, [
      { candidate_id: 'r1', status: 'SOURCE_CONFIRMED', evidence: 'search.rb:3' },
      { candidate_id: 'r2', status: 'RUNTIME_CONFIRMED', evidence: 'claims live' },       // static → quarantine
      { candidate_id: 'r3', status: 'SOURCE_CONFIRMED', evidence: 'a' },
      { candidate_id: 'r3', status: 'DISPROVEN', evidence: 'b' },                          // duplicate → ambiguous
      { candidate_id: 'ghost', status: 'SOURCE_CONFIRMED', evidence: 'foreign' },          // foreign → ignored
    ].map(r => JSON.stringify(r)).join('\n') + '\n')

    // STATIC (deployUrl='') → RUNTIME_CONFIRMED must be quarantined
    cr.reconcileBoardFromVerdicts(taskId, VERDICTS, candidates, () => {}, '')
    const ledger = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const term = Object.fromEntries(ledger.map(r => [r.candidate_id, r.terminal_status]))
    assert.equal(ledger.length, 3, 'foreign verdict did NOT add a phantom row')
    assert.equal(term.r1, 'SOURCE_CONFIRMED')
    assert.equal(term.r2, 'AUDIT_QUARANTINED', 'static + RUNTIME_CONFIRMED → quarantined, not promoted')
    assert.equal(term.r3, 'AUDIT_QUARANTINED', 'duplicate verdicts → ambiguous → quarantined')

    const board = fs.readFileSync(VF, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.deepEqual(board.map(r => r.candidate_id), ['r1'], 'only r1 reaches the board')
    assert.equal(board[0].title, 'SQL injection via search param', 'title from the candidate, NOT the triager rename')

    // WHITE-BOX (deployUrl set) → RUNTIME_CONFIRMED demotes to NEEDS_LIVE (deferred pentest confirms)
    cleanup(); fs.writeFileSync(VF, ''); fs.writeFileSync(VERDICTS, JSON.stringify({ candidate_id: 'r2', status: 'RUNTIME_CONFIRMED', evidence: 'x' }) + '\n')
    cr.reconcileBoardFromVerdicts(taskId, VERDICTS, [candidates[1]], () => {}, 'https://staging.test')
    const wl = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(wl[0].terminal_status, 'NEEDS_LIVE_VALIDATION', 'white-box RUNTIME_CONFIRMED (no proof) → demoted to NEEDS_LIVE')
  } finally { cleanup() }
})
