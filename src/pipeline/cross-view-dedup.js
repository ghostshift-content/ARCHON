// src/pipeline/cross-view-dedup.js
//
// Deterministic cross-view de-duplication for combined white-box + black-box
// engagements. The merged report otherwise relies entirely on SCRIBE following a
// correlation prompt → risk of double-counting the same vuln found both ways.
// This pre-pass groups findings algorithmically and hands SCRIBE an authoritative
// spine:
//   - exact_duplicate_groups: findings sharing {view, vuln-class, locus, param}
//     → collapse to ONE.
//   - cross_view_candidates: a vuln-class present in BOTH views → merge candidates
//     (white↔black loci differ — file vs URL — so the LLM confirms the match, but
//     ONLY within these scripted groupings, never free-form).
// Pure + fail-soft: all I/O is guarded by the caller; the grouping is deterministic.

'use strict'

const fs = require('fs')

function deriveVulnClass(title) {
  const t = String(title || '').toLowerCase()
  const map = [
    ['sqli', /sql\s*inject|sqli/], ['xss', /xss|cross.?site.?script/],
    ['ssrf', /ssrf|server.?side.?request/], ['rce', /rce|remote.?code|command.?inject|os.?command/],
    ['idor', /idor|insecure.?direct.?object|bola/], ['access-control', /access.?control|authoriz|privilege|broken.?access|missing.?auth/],
    ['ssti', /ssti|template.?inject/], ['xxe', /xxe|xml.?external/], ['lfi', /lfi|local.?file|path.?travers/],
    ['csrf', /csrf|cross.?site.?request.?forg/], ['auth', /authenticat|account.?takeover|session.?fix|\bjwt\b/],
    ['deserialization', /deserializ/], ['secrets', /secret|hardcoded|api.?key|credential/],
    ['redirect', /open.?redirect/], ['info-disclosure', /information.?disclos|info.?leak|sensitive.?data.?expos/],
  ]
  for (const [cls, re] of map) if (re.test(t)) return cls
  return 'other'
}

function findingLocus(f) {
  if (f.file) return String(f.file).split(/[\\/]/).pop().toLowerCase()
  try { return new URL(f.url).pathname.toLowerCase().replace(/\/+$/, '') } catch {}
  return ''
}

function findingParam(f) {
  try { const k = [...new URL(f.url).searchParams.keys()][0]; if (k) return k.toLowerCase() } catch {}
  const m = String(f.title || '').match(/[`'"]([a-z_][a-z0-9_]{1,30})[`'"]\s*(param|parameter|field|arg)/i)
  return m ? m[1].toLowerCase() : ''
}

// Pure grouping over an array of {id,title,severity,kind,cls,locus,param}.
function correlate(findings) {
  const exactGroups = {}
  for (const f of findings) { const k = `${f.kind}|${f.cls}|${f.locus}|${f.param}`; (exactGroups[k] = exactGroups[k] || []).push(f) }
  const exact_duplicate_groups = Object.values(exactGroups).filter(g => g.length > 1)
    .map(g => ({ view: g[0].kind, vuln_class: g[0].cls, locus: g[0].locus, members: g.map(x => x.id), keep: g[0].id, dropped: g.slice(1).map(x => x.id) }))
  const byClass = {}
  for (const f of findings) (byClass[f.cls] = byClass[f.cls] || []).push(f)
  const cross_view_candidates = Object.entries(byClass)
    .filter(([, g]) => g.some(x => x.kind === 'whitebox') && g.some(x => x.kind === 'blackbox'))
    .map(([cls, g]) => ({ vuln_class: cls,
      whitebox: g.filter(x => x.kind === 'whitebox').map(x => ({ id: x.id, locus: x.locus, param: x.param, title: x.title })),
      blackbox: g.filter(x => x.kind === 'blackbox').map(x => ({ id: x.id, locus: x.locus, param: x.param, title: x.title })) }))
  return { exact_duplicate_groups, cross_view_candidates }
}

// Load findings across iterations, group, write correlation-<taskId>.json.
// deps: { intelRoot, log?, now? } — now() injectable for deterministic tests.
function buildCorrelationMap(taskId, iters, deps = {}) {
  const intelRoot = deps.intelRoot
  const log = deps.log || (() => {})
  const now = deps.now || (() => new Date().toISOString())
  const all = []
  for (const it of iters || []) {
    const vf = `${intelRoot}/VALIDATED-FINDINGS-${it.taskId}.jsonl`
    let lines = []
    try { if (fs.existsSync(vf)) lines = fs.readFileSync(vf, 'utf8').trim().split('\n').filter(Boolean) } catch {}
    for (const ln of lines) {
      try {
        const f = JSON.parse(ln)
        all.push({ id: f.id || '', title: f.title || '', severity: f.severity || '', kind: it.kind || 'blackbox',
          cls: deriveVulnClass(f.title), locus: findingLocus(f), param: findingParam(f) })
      } catch {}
    }
  }
  const { exact_duplicate_groups, cross_view_candidates } = correlate(all)
  const map = { taskId, generatedAt: now(), raw_count: all.length, exact_duplicate_groups, cross_view_candidates }
  try { fs.writeFileSync(`${intelRoot}/correlation-${taskId}.json`, JSON.stringify(map, null, 2)) } catch {}
  log(`🔗 Correlation: ${all.length} findings → ${exact_duplicate_groups.length} exact-dup group(s), ${cross_view_candidates.length} cross-view class candidate(s)`)
  return map
}

module.exports = { buildCorrelationMap, correlate, deriveVulnClass, findingLocus, findingParam }
