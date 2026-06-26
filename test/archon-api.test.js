#!/usr/bin/env node
// Unit tests for the ARCHON portal API helpers (scripts/dashboard.js).
// Requires the module directly (server is guarded by require.main) and drives
// the pure helpers against a temp taskId in the real INTEL_ROOT, cleaning up after.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const d = require('../scripts/dashboard')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)

const TID = 'test-archon-' + process.pid
const F = (n) => path.join(d.INTEL, n)
const cleanup = () => {
  for (const f of [`VALIDATED-FINDINGS-${TID}.jsonl`, `JUDGED-FINDINGS-${TID}.jsonl`, `triage-${TID}.json`, `findings-detail-${TID}.json`]) {
    try { fs.unlinkSync(F(f)) } catch {}
  }
  try { for (const f of fs.readdirSync(F('inbox/task-actions'))) if (f.includes(TID)) fs.unlinkSync(F('inbox/task-actions/' + f)) } catch {}
}

;(async () => {
  console.log('ARCHON API helpers:')
  cleanup()

  // ── hostOf (the scope-block bug fix: strip port) ──
  ok('hostOf strips port (localhost:4000 → localhost)', d.hostOf('http://localhost:4000/') === 'localhost', d.hostOf('http://localhost:4000/'))
  ok('hostOf bare host:port → host', d.hostOf('localhost:4000') === 'localhost')
  ok('hostOf full url → host', d.hostOf('https://app.example.com/a/b?x=1') === 'app.example.com')
  ok('hostOf lowercases', d.hostOf('HTTPS://API.Example.COM:8443') === 'api.example.com')

  // ── titleSev normalization ──
  ok('titleSev critical', d.titleSev('CRITICAL') === 'Critical')
  ok('titleSev hi→High', d.titleSev('high') === 'High')
  ok('titleSev med', d.titleSev('Medium') === 'Medium')
  ok('titleSev unknown→Info', d.titleSev('whatever') === 'Info')

  // ── synthRawRequest (build a raw HTTP request from method+url+curl) ──
  const raw = d.synthRawRequest('GET', 'http://localhost:8929/api/v4/projects?x=1', "curl -s 'http://localhost:8929/api/v4/projects?x=1' -H 'Authorization: Bearer abc' -b 'session=zzz'")
  ok('rawRequest request line', raw.startsWith('GET /api/v4/projects?x=1 HTTP/1.1'), raw.split('\n')[0])
  ok('rawRequest Host header', /\r\nHost: localhost:8929/.test(raw))
  ok('rawRequest carries -H header', /Authorization: Bearer abc/.test(raw))
  ok('rawRequest carries cookie', /Cookie: session=zzz/.test(raw))
  const rawPost = d.synthRawRequest('POST', 'https://x.test/login', "curl -X POST 'https://x.test/login' --data 'u=a&p=b'")
  ok('rawRequest POST body', /\r\n\r\nu=a&p=b$/.test(rawPost), JSON.stringify(rawPost.slice(-30)))
  ok('rawRequest bad url → empty', d.synthRawRequest('GET', 'not a url', '') === '')

  // ── findingsForTask: normalize + merge triage + enrichment + counts + sort ──
  fs.writeFileSync(F(`VALIDATED-FINDINGS-${TID}.jsonl`), [
    JSON.stringify({ id: 'A-1', severity: 'medium', title: 'Med finding', cvss_score: 5.3, cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', url: 'http://t/api', method: 'GET', reproduction_method: "curl 'http://t/api'", reproduction_result: 'HTTP 200', taskId: TID }),
    JSON.stringify({ id: 'A-2', severity: 'high', title: 'High finding', cvss_score: 7.5, url: 'http://t/admin', method: 'GET', taskId: TID }),
    JSON.stringify({ id: 'A-3', severity: 'info', title: 'Info finding', taskId: TID }),
  ].join('\n') + '\n')
  fs.writeFileSync(F(`findings-detail-${TID}.json`), JSON.stringify({ 'A-1': { description: 'desc here', impact: 'impact here', remediation: 'fix here', raw_request: 'RAW REQ', poc: 'poc steps' } }))
  let res = d.findingsForTask(TID)
  ok('findings: 3 total', res.total === 3, 'got ' + res.total)
  ok('findings: counts', res.counts.High === 1 && res.counts.Medium === 1 && res.counts.Info === 1, JSON.stringify(res.counts))
  ok('findings: sorted High→Med→Info', res.findings.map(f => f.severity).join(',') === 'High,Medium,Info', res.findings.map(f => f.severity).join(','))
  const a1 = res.findings.find(f => f.id === 'A-1')
  ok('findings: enrichment merged (impact)', a1.impact === 'impact here')
  ok('findings: enrichment merged (raw_request)', a1.rawRequest === 'RAW REQ')
  ok('findings: enriched flag', a1.enriched === true)
  const a2 = res.findings.find(f => f.id === 'A-2')
  ok('findings: raw request synthesized when absent', a2.rawRequest.startsWith('GET /admin HTTP/1.1'), a2.rawRequest.split('\n')[0])
  ok('findings: cvss + vector exposed', a1.cvss === 5.3 && a1.cvssVector.startsWith('CVSS:3.1/'))

  // ── saveTriage: persist verdict/severity/cvss/cvssVector/notes + clamp + validate ──
  let r = d.saveTriage({ taskId: TID, verdicts: {
    'A-1': { verdict: 'confirmed', severity: 'high', cvss: 7.5, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', notes: 'raised to high' },
    'A-2': { verdict: 'rejected' },
    'A-3': { verdict: 'confirmed', cvss: 99 }, // clamp
    'A-4': { verdict: 'confirmed', cvssVector: 'not-a-vector' }, // invalid vector dropped
  } })
  ok('saveTriage returns count', r.triaged === 4, JSON.stringify(r))
  const saved = JSON.parse(fs.readFileSync(F(`triage-${TID}.json`), 'utf8')).verdicts
  ok('triage persists severity (titlecased)', saved['A-1'].severity === 'High')
  ok('triage persists cvss', saved['A-1'].cvss === 7.5)
  ok('triage persists cvssVector', saved['A-1'].cvssVector === 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N')
  ok('triage persists notes', saved['A-1'].notes === 'raised to high')
  ok('triage rejected verdict kept', saved['A-2'].verdict === 'rejected')
  ok('triage cvss clamped to 10', saved['A-3'].cvss === 10)
  ok('triage invalid vector dropped', saved['A-4'].cvssVector === undefined)

  // findingsForTask now reflects triage override
  res = d.findingsForTask(TID)
  ok('findings: triage merged onto finding', res.findings.find(f => f.id === 'A-1').triage.severity === 'High')

  // ── inbox actions: generate-report / amend / enrich-findings ──
  const inboxFiles = () => { try { return fs.readdirSync(F('inbox/task-actions')) } catch { return [] } }
  d.generateReport({ taskId: TID })
  ok('generate-report queues inbox action', inboxFiles().some(f => { try { const j = JSON.parse(fs.readFileSync(F('inbox/task-actions/' + f), 'utf8')); return j.action === 'generate-report' && j.taskId === TID } catch { return false } }))
  d.amendRun({ taskId: TID, instructions: 'test more', addScope: ['api2.test.com', 'http://b.test/x'] })
  ok('amend queues inbox action w/ normalized scope', inboxFiles().some(f => { try { const j = JSON.parse(fs.readFileSync(F('inbox/task-actions/' + f), 'utf8')); return j.action === 'amend' && j.addScope.includes('api2.test.com') && j.addScope.includes('b.test') } catch { return false } }))
  d.enrichFindings({ taskId: TID })
  ok('enrich-findings queues inbox action', inboxFiles().some(f => { try { const j = JSON.parse(fs.readFileSync(F('inbox/task-actions/' + f), 'utf8')); return j.action === 'enrich-findings' && j.taskId === TID } catch { return false } }))

  // validation: empty taskId rejected
  ok('saveTriage requires taskId', (() => { try { d.saveTriage({ verdicts: {} }); return false } catch { return true } })())
  ok('amend requires something to change', (() => { try { d.amendRun({ taskId: TID }); return false } catch { return true } })())

  // ── buildPentestMeta: comprehensive profile + triage gate + scope host normalization ──
  const pm = d.buildPentestMeta({ meta: { targetUrl: 'http://localhost:4000/', inScope: ['localhost:4000', 'https://api.example.com/x'], credentials: [{ username: 'admin', password: 'p', role: 'admin' }] } })
  ok('pentest meta: severityProfile comprehensive', pm.severityProfile === 'comprehensive')
  ok('pentest meta: triageGate on', pm.triageGate === true)
  ok('pentest meta: scope host-normalized (no ports)', pm.inScope.includes('localhost') && pm.inScope.includes('api.example.com'), JSON.stringify(pm.inScope))
  ok('pentest meta: target host auto-added to scope', pm.inScope.includes('localhost'))
  ok('pentest meta: credentials carried', Array.isArray(pm.credentials) && pm.credentials.length === 1)
  ok('pentest meta: rejects missing url', (() => { try { d.buildPentestMeta({ meta: {} }); return false } catch { return true } })())
  // skip-recon + focused scan
  const pmFocus = d.buildPentestMeta({ meta: { targetUrl: 'https://app.example.com', skipRecon: true, focusClasses: ['access-control', 'API', 'bogus-class', 'xss'] } })
  ok('pentest meta: skipRecon carried', pmFocus.skipRecon === true)
  ok('pentest meta: focusClasses validated+lowercased (bogus dropped)', JSON.stringify(pmFocus.focusClasses) === JSON.stringify(['access-control', 'api', 'xss']), JSON.stringify(pmFocus.focusClasses))
  ok('pentest meta: defaults skipRecon=false, focus=[]', (() => { const x = d.buildPentestMeta({ meta: { targetUrl: 'https://x.test' } }); return x.skipRecon === false && Array.isArray(x.focusClasses) && x.focusClasses.length === 0 })())
  ok('pentest meta: rejects non-http url', (() => { try { d.buildPentestMeta({ meta: { targetUrl: 'ftp://x' } }); return false } catch { return true } })())

  cleanup()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW:', e.stack); cleanup(); process.exit(1) })
