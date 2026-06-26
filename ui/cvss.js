/* CVSS 3.1 base-score calculator — dual-mode (browser global + node module).
   Pure functions; unit-tested in test/cvss.test.js. */
const CVSS_METRICS = {
  AV: { label: 'Attack Vector', opts: [['N', 'Network'], ['A', 'Adjacent'], ['L', 'Local'], ['P', 'Physical']] },
  AC: { label: 'Attack Complexity', opts: [['L', 'Low'], ['H', 'High']] },
  PR: { label: 'Privileges Required', opts: [['N', 'None'], ['L', 'Low'], ['H', 'High']] },
  UI: { label: 'User Interaction', opts: [['N', 'None'], ['R', 'Required']] },
  S: { label: 'Scope', opts: [['U', 'Unchanged'], ['C', 'Changed']] },
  C: { label: 'Confidentiality', opts: [['N', 'None'], ['L', 'Low'], ['H', 'High']] },
  I: { label: 'Integrity', opts: [['N', 'None'], ['L', 'Low'], ['H', 'High']] },
  A: { label: 'Availability', opts: [['N', 'None'], ['L', 'Low'], ['H', 'High']] },
}
function cvssRoundup(x) { const i = Math.round(x * 100000); return (i % 10000 === 0) ? i / 100000 : (Math.floor(i / 10000) + 1) / 10 }
function cvss31(m) {
  const AVv = { N: .85, A: .62, L: .55, P: .2 }[m.AV]
  const ACv = { L: .77, H: .44 }[m.AC]
  const UIv = { N: .85, R: .62 }[m.UI]
  const sc = m.S === 'C'
  const PRv = m.PR === 'N' ? .85 : m.PR === 'L' ? (sc ? .68 : .62) : (sc ? .5 : .27)
  const imp = { N: 0, L: .22, H: .56 }
  const isc = 1 - ((1 - imp[m.C]) * (1 - imp[m.I]) * (1 - imp[m.A]))
  const impact = sc ? 7.52 * (isc - 0.029) - 3.25 * Math.pow(isc - 0.02, 15) : 6.42 * isc
  const expl = 8.22 * AVv * ACv * PRv * UIv
  const score = impact <= 0 ? 0 : cvssRoundup(Math.min((sc ? 1.08 : 1) * (impact + expl), 10))
  return { score, vector: `CVSS:3.1/AV:${m.AV}/AC:${m.AC}/PR:${m.PR}/UI:${m.UI}/S:${m.S}/C:${m.C}/I:${m.I}/A:${m.A}` }
}
function sevFromScore(s) { s = +s; if (s >= 9) return 'Critical'; if (s >= 7) return 'High'; if (s >= 4) return 'Medium'; if (s > 0) return 'Low'; return 'Info' }
function parseVector(v) { const m = { AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'N', I: 'N', A: 'N' }; String(v || '').split('/').forEach(p => { const [k, val] = p.split(':'); if (k && val && k in m) m[k] = val }); return m }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CVSS_METRICS, cvssRoundup, cvss31, sevFromScore, parseVector }
}
