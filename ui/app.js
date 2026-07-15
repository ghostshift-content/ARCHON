/* ARCHON operator console — SPA logic (no framework, no build). */
'use strict'
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fmtTime = ts => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch { return '' } }

let SQUADS = [], SQUAD_BY = {}
let REPORTS = [], lastState = null
const reportCache = {}          // rel → raw markdown (fetched once)

// find the report file that belongs to a task (by taskId in path/name)
function reportForTask(t) {
  if (!t || !t.id) return null
  const id = String(t.id)
  const hits = REPORTS.filter(r => r.rel.includes(id) || r.name.includes(id))
  if (!hits.length) return null
  // prefer the canonical reports/<id>.md, else the most recent match
  return (hits.find(r => r.rel === `reports/${id}.md`) || hits.sort((a, b) => b.mtime - a.mtime)[0]).rel
}
async function loadReport(rel) {
  if (reportCache[rel] != null) return
  try { reportCache[rel] = await fetch('/api/report?f=' + encodeURIComponent(rel)).then(r => r.text()) }
  catch { reportCache[rel] = '_Could not load report._' }
}

const SQUAD_HUE = {
  pentest: '#ff5d8f', stocks: '#3ddc97', 'cloud-security': '#2fd9e8',
  'network-pentest': '#9b8cff', 'code-review': '#f6a623', 'red-team': '#ff6b81',
  'ai-security': '#ffcf5c', universal: '#9aa8c2',
}
const squadHue = id => SQUAD_HUE[String(id).replace(/-squad$/, '')] || '#f6a623'

/* deterministic avatar color from a name */
function avatarColor(name) {
  let h = 0; const s = String(name || '?')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return `hsl(${h} 70% 62%)`
}
function avatar(name, size = 28) {
  const init = String(name || '?').slice(0, 2).toUpperCase()
  return `<span class="av" title="${esc(name)}" style="background:${avatarColor(name)};width:${size}px;height:${size}px">${esc(init)}</span>`
}
function avatarStack(names, max = 5) {
  const shown = names.slice(0, max)
  let html = '<div class="avs">' + shown.map(n => avatar(n)).join('')
  if (names.length > max) html += `<span class="av more">+${names.length - max}</span>`
  return html + '</div>'
}

/* progress ring */
function ring(pct, color = 'url(#ringGrad)') {
  const r = 24, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, pct)) / 100)
  return `<div class="ring"><svg width="56" height="56" viewBox="0 0 56 56">
    <circle class="track" cx="28" cy="28" r="${r}" fill="none" stroke-width="5"/>
    <circle class="fill" cx="28" cy="28" r="${r}" fill="none" stroke-width="5" stroke="${color}"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
  </svg><span class="pct">${Math.round(pct)}<small style="font-size:8px">%</small></span></div>`
}

/* ── routing ── */
let currentView = 'overview'
function show(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view))
  $$('.nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view))
  currentView = view
  const main = document.querySelector('.main'); if (main) main.scrollTop = 0
  if (view === 'studio') renderStudio()
}

// M12: Studio — create/list custom personas & patterns (no code edit). All rendered values esc()'d.
async function renderStudio() {
  let per = { builtin: [], custom: [] }, pat = { classes: [], custom: [] }
  try { per = await api('GET', '/api/personas') } catch {}
  try { pat = await api('GET', '/api/patterns') } catch {}
  const pl = $('#studioPersonaList')
  if (pl) pl.innerHTML = [
    ...(per.builtin || []).map(p => `<div class="studio-row"><b>${esc(p.name)}</b> <span class="badge">built-in</span><span class="hint"> ${esc(p.report_style || '')}</span></div>`),
    ...(per.custom || []).map(p => `<div class="studio-row"><b>${esc(p.name)}</b> <span class="badge" style="background:var(--accent-2,#8b9dff)">custom</span> <button class="btn sm" data-del-persona="${esc(p.id)}">delete</button></div>`),
  ].join('') || '<div class="hint">none</div>'
  const ql = $('#studioPatternList')
  if (ql) ql.innerHTML = `<div class="hint">${(pat.classes || []).length} classes loaded</div>` +
    (pat.custom || []).map(f => `<div class="studio-row"><b>${esc(f)}</b> <span class="badge" style="background:var(--accent-2,#8b9dff)">custom pack</span></div>`).join('')
  $$('#studioPersonaList [data-del-persona]').forEach(b => b.onclick = async () => {
    await api('DELETE', '/api/personas?id=' + encodeURIComponent(b.dataset.delPersona)); renderStudio()
  })
}
function _bindStudio() {
  const save = $('#pfSave'); if (save) save.onclick = async () => {
    const body = { id: $('#pfId').value, name: $('#pfName').value, report_style: $('#pfReport').value,
      evidence_strictness: $('#pfStrict').value, scan_depth: $('#pfDepth').value, description: $('#pfDesc').value,
      preferred_patterns: $('#pfPref').value.split(',').map(s => s.trim()).filter(Boolean) }
    const r = await api('POST', '/api/personas', body)
    $('#pfMsg').textContent = r && r.ok ? '✓ created' : ('✕ ' + ((r && r.error) || 'failed'))
    if (r && r.ok) { $('#pfId').value = $('#pfName').value = ''; renderStudio() }
  }
  const qsave = $('#qfSave'); if (qsave) qsave.onclick = async () => {
    const body = { class: $('#qfClass').value, name: $('#qfName').value, mode: $('#qfMode').value,
      patterns: [{ id: $('#qfPid').value, name: $('#qfPname').value, description: $('#qfPdesc').value }] }
    const r = await api('POST', '/api/patterns', body)
    $('#qfMsg').textContent = r && r.ok ? '✓ created' : ('✕ ' + ((r && r.error) || 'failed'))
    if (r && r.ok) { $('#qfPid').value = $('#qfPname').value = ''; renderStudio() }
  }
}
_bindStudio()
$$('[data-view]').forEach(b => b.addEventListener('click', () => show(b.dataset.view)))

/* ── full-page report ── */
let reportBackTo = 'tasks'
async function openReportPage(rel, title) {
  if (currentView !== 'report') reportBackTo = currentView
  $('#repTitle').textContent = title || 'Report'
  $('#repPath').textContent = rel
  $('#repBody').innerHTML = '<div class="skel"></div>'
  show('report')
  await loadReport(rel)
  $('#repBody').innerHTML = md(reportCache[rel] || '_Could not load report._')
}

/* ── toasts ── */
function toast(title, sub, kind = '') {
  const el = document.createElement('div')
  el.className = 'toast ' + kind
  el.innerHTML = `<div class="ttl">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`
  $('#toasts').appendChild(el)
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.4s'; setTimeout(() => el.remove(), 400) }, 4400)
}

/* ── markdown → html ── */
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n')
  let out = '', i = 0, inUl = false, inOl = false
  const closeLists = () => { if (inUl) { out += '</ul>'; inUl = false } if (inOl) { out += '</ol>'; inOl = false } }
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  while (i < lines.length) {
    let l = lines[i]
    if (/^```/.test(l)) { closeLists(); i++; let code = ''; while (i < lines.length && !/^```/.test(lines[i])) code += lines[i++] + '\n'; i++; out += `<pre><code>${esc(code)}</code></pre>`; continue }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeLists(); const head = l.split('|').slice(1, -1).map(c => `<th>${inline(c.trim())}</th>`).join(''); i += 2
      let body = ''
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body += '<tr>' + lines[i].split('|').slice(1, -1).map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>'; i++ }
      out += `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`; continue
    }
    let m
    if (m = l.match(/^(#{1,6})\s+(.*)/)) { closeLists(); const n = m[1].length; out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue }
    if (/^\s*>\s?/.test(l)) { closeLists(); out += `<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>`; i++; continue }
    if (/^\s*([-*+])\s+/.test(l)) { if (!inUl) { closeLists(); out += '<ul>'; inUl = true } out += `<li>${inline(l.replace(/^\s*[-*+]\s+/, ''))}</li>`; i++; continue }
    if (/^\s*\d+\.\s+/.test(l)) { if (!inOl) { closeLists(); out += '<ol>'; inOl = true } out += `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`; i++; continue }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { closeLists(); out += '<hr>'; i++; continue }
    if (/^\s*$/.test(l)) { closeLists(); i++; continue }
    closeLists(); out += `<p>${inline(l)}</p>`; i++
  }
  closeLists(); return out
}

/* ── status + phases ── */
const statusClass = s => 's-' + String(s || 'pending').toLowerCase().replace(/\s+/g, '-')
function phaseSteps(task) {
  const sq = SQUAD_BY[String(task.squad || '').replace(/-squad$/, '')]
  const phases = (sq && sq.phases) || []
  if (!phases.length) return ''
  const prog = Math.max(0, Math.min(100, task.progress || 0))
  const done = ['completed', 'done'].includes(task.status) ? phases.length : Math.floor(prog / 100 * phases.length)
  const running = task.status === 'in-progress'
  const stateOf = idx => idx < done ? 'done' : (running && idx === done ? 'active' : '')
  // Triage-hub layout: recon · exploit · validate · chain sit on a rail that FEEDS a continuous
  // `triage` node below — triage runs the whole scan, fed one-by-one by every phase above it.
  // The rail flows (animates) while the run is live. Linear squads (code-review) keep the stepper.
  if (phases.includes('triage')) {
    const flow = phases.filter(p => p !== 'triage')
    const tIdx = phases.indexOf('triage')
    const tState = tIdx < done ? 'done' : (running ? 'live' : '')
    return `<div class="stepper hub">
      <div class="flowrow">${flow.map((p, idx) => `<span class="ph ${stateOf(idx)}"><b>${esc(p)}</b></span>`).join('')}</div>
      <div class="bus ${running ? 'flowing' : ''}"></div>
      <div class="hubrow"><span class="triage ${tState}">triage</span></div>
    </div>`
  }
  return `<div class="stepper">${phases.map((p, idx) =>
    `<div class="step ${stateOf(idx)}">${esc(p)}</div>`).join('')}</div>`
}

/* ── task card ── */
// Unified dispatch band for a task card — the ATLAS/lead → specialists → TRIAGER waves.
// Animated while running, static-green when done; falls back to phaseSteps(t) for
// queued/failed cards and empty rosters. Purely presentational (reads t.status/squad +
// the squad roster; no API, no state writes).
function cardPhaseArt(t) {
  const st = String(t.status || '').toLowerCase()
  const done = ['completed', 'done'].includes(st)
  const live = ['in-progress', 'awaiting-triage', 'generating-report'].includes(st)   // actively working
  // terminal-but-not-successful — show the band muted/greyed, never the green "done" state
  const stopped = ['cancelled', 'failed', 'blocked', 'aborted', 'error', 'stopped', 'killed', 'timeout'].includes(st)
  const queued = ['queued', 'pending', 'backlog'].includes(st)   // created, not yet dispatched
  if (!done && !live && !stopped && !queued) return phaseSteps(t)   // truly unknown → normal stepper
  const SPEC_HUE = { SCOUT:'#22d3ee', VIPER:'#fb7185', DRILL:'#fbbf24', RELAY:'#9ba2ff',
    WARDEN:'#34d399', GATEWAY:'#b08cff', RANGER:'#22d3ee', SENTRY:'#9ba2ff',
    CURATOR:'#f6a623', MARSHAL:'#f6a623', CIPHER:'#fb7185', PROBER:'#22d3ee',
    AUDITOR:'#34d399', SCRIBE:'#b08cff' }
  const sq = SQUAD_BY[String(t.squad || '').replace(/-squad$/, '')]
  const lead = (sq && sq.leader) || 'ATLAS'
  const roster = ((sq && sq.agents) || Object.keys(SPEC_HUE))
    .filter(a => String(a).toUpperCase() !== String(lead).toUpperCase()).slice(0, 6)
  if (!roster.length) return phaseSteps(t)
  const role = a => (sq && sq.roles && sq.roles[a]) || ''
  const specs = roster.map((a, i) => {
    const hue = SPEC_HUE[String(a).toUpperCase()] || '#9ba2ff'
    const delay = live ? `;animation-delay:${(i*.3).toFixed(2)}s` : ''
    return `<div class="dvz-spec" style="--sp:${hue}${delay}"><b>${esc(a)}</b><span>${esc(role(a))}</span></div>`
  }).join('')
  const pkts = live ? roster.map((_, i) =>
    `<span class="pkt" style="left:${8 + i*(72/Math.max(1,roster.length-1))}%;animation-delay:${(i*.35).toFixed(2)}s"></span>`).join('') : ''
  const stopLabel = { cancelled: '■ CANCELLED', failed: '✕ FAILED', blocked: '✕ BLOCKED',
    aborted: '■ ABORTED', error: '✕ ERROR', timeout: '✕ TIMED OUT' }[st] || '■ STOPPED'
  const stage = live
    ? `<span class="rd-stage s1">▸ DISPATCH · scope gate passed</span>
       <span class="rd-stage s2">▸ LIVE PROGRESS · specialist waves</span>
       <span class="rd-stage s3">▸ FINDINGS · streaming in</span>
       <span class="rd-stage s4">▸ ${st === 'generating-report' ? 'GENERATING REPORT · SCRIBE writing' : 'VALIDATED · on your board'}</span>`
    : done
    ? `<span class="rd-stage done">✓ COMPLETE · report generated</span>`
    : queued
    ? `<span class="rd-stage queue">◷ QUEUED · waiting for the daemon</span>`
    : `<span class="rd-stage stop">${stopLabel} · run ended early</span>`
  const triage = live
    ? `<div class="dvz-triage"><span class="dot"></span><span>every finding → validated live → your board</span></div>`
    : done
    ? `<div class="dvz-triage done"><span class="dot"></span><span>findings → verified → report published</span></div>`
    : queued
    ? `<div class="dvz-triage queue"><span class="dot"></span><span>waiting to dispatch — nothing tested yet</span></div>`
    : `<div class="dvz-triage stop"><span class="dot"></span><span>run stopped before completion — no report</span></div>`
  const leadSub = done ? ' · consolidated the review' : live ? ' · plans the attack walk' : queued ? ' · queued' : ' · run ended early'
  return `<div class="run-dispatch${done ? ' done' : ''}${stopped ? ' stopped' : ''}${queued ? ' queued' : ''}">
    <div class="rd-stagewrap">${stage}</div>
    <div class="dvz dvz-embed${done ? ' dvz-done' : ''}${stopped ? ' dvz-stopped' : ''}${queued ? ' dvz-queued' : ''}">
      <div class="dvz-lead-row"><div class="dvz-lead"><b>${esc(lead)}</b><span>lead${leadSub}</span></div></div>
      <div class="dvz-rail"><span class="down"></span><span class="flow"></span>${pkts}</div>
      <div class="dvz-specs">${specs}</div>
      <div class="dvz-triage-row">${triage}</div>
    </div>
  </div>`
}
function taskCard(t) {
  const running = t.status === 'in-progress'
  const completed = ['completed', 'done'].includes(t.status)
  const prog = completed ? 100 : (t.progress || 0)
  const c = squadHue(t.squad)
  const agentNames = t.costByAgent ? Object.keys(t.costByAgent) : (t.assignee ? [t.assignee] : [])
  const sq = SQUAD_BY[String(t.squad || '').replace(/-squad$/, '')]
  const phases = (sq && sq.phases) || []
  const done = completed ? phases.length : Math.floor(prog / 100 * phases.length)
  const phaseLabel = phases.length
    ? (completed ? `Complete · ${phases.length} phases` : `Phase ${Math.min(done + 1, phases.length)} of ${phases.length}`)
    : (t.statusMessage || '')
  const tick2 = phases.length ? (t.statusMessage || '') : ''
  const metric = (k, v, cls = '') => `<div class="metric"><span class="mk">${k}</span><span class="mv ${cls}">${v}</span></div>`
  const metrics = [
    t.cacheHitRate ? metric('cache', t.cacheHitRate + '%') : '',
    t.tokens ? metric('output', (t.tokens.output || 0).toLocaleString()) : '',
  ].filter(Boolean).join('')
  const awaiting = t.status === 'awaiting-triage'
  const opener = awaiting ? 'Triage findings →' : (completed ? 'View findings & report →' : 'Open run →')
  return `<div class="tcard clickable ${running ? 'running' : ''}" style="--c:${c}" data-taskopen="${esc(t.id)}" title="Open run">
    <div class="pad">
      <div class="thead">
        <div class="readout"><span class="val">${Math.round(prog)}</span><span class="pc">%</span></div>
        <div class="hstatus">
          ${running ? `<span class="runtag"><span class="dot"></span>Running</span>` : ''}
          <span class="badge ${statusClass(t.status)}">${esc(t.status || '?')}</span>
        </div>
      </div>
      <div class="pbar"><div class="pfill" style="width:${Math.max(2, Math.min(100, prog))}%"></div></div>
      <div class="ticks"><span>${esc(phaseLabel)}</span><span>${esc(tick2)}</span></div>
      <div class="ttl">${esc(t.title || t.id)}</div>
      <div class="tid">${esc(t.id)}</div>
      <div class="row">
        ${t.squad ? `<span class="badge squad">${esc(String(t.squad).replace(/-squad$/, ''))}</span>` : ''}
        ${sq && sq.type ? `<span class="badge">${esc(sq.type)}</span>` : ''}
      </div>
      ${cardPhaseArt(t)}
      ${agentNames.length ? `<div style="margin-top:13px">${avatarStack(agentNames)}</div>` : ''}
      ${metrics ? `<div class="sep-line"></div><div class="footgrid">${metrics}</div>` : ''}
      <div class="card-open">${opener}</div>
    </div>
  </div>`
}

/* ── render ── */
let lastTaskSig = '', lastRepSig = '', lastTdOvSig = '', lrunSevFilter = ''
function render(s) {
  lastState = s
  REPORTS = s.reports || []
  const up = s.daemon
  $('#daemonPill').className = 'pill ' + (up ? 'live' : 'down')
  $('#daemonText').textContent = up ? 'operational' : 'standby'
  $('#clock').textContent = fmtTime(s.now)
  $('#footMeta').innerHTML = `intel ▸<br>${esc(s.intel.replace(/^.*?(var\/intel.*)$/, '…/$1'))}`
  $('#cTasks').textContent = s.tasks.length
  $('#cReports').textContent = s.reports.length
  // if the detail page is open, keep its header (status + Cancel) and overview / live logs current
  if (currentView === 'task') updateTdHeader((s.tasks || []).find(x => String(x.id) === String(tdTaskId)))
  if (currentView === 'task' && tdSub === 'overview') {
    const t = (s.tasks || []).find(x => String(x.id) === String(tdTaskId))
    // stream findings into the live board ONLY while scanning; a done run never re-fetches
    if (t && t.status === 'in-progress') loadFindings()
    renderTaskOverview() // gated internally — a done/unchanged run short-circuits (no re-render)
  }
  if (currentView === 'task' && tdSub === 'log') renderTaskLogs()
  // findings tab: refresh live ONLY while the run is in-progress (no triage yet to clobber),
  // so validated findings appear on the tab as they land
  if (currentView === 'task' && tdSub === 'findings') {
    const t = (s.tasks || []).find(x => String(x.id) === String(tdTaskId))
    if (t && t.status === 'in-progress') loadFindings()
  }
  // report tab: while SCRIBE is generating (or once it finishes), keep the tab current
  if (currentView === 'task' && tdSub === 'report') {
    const t = (s.tasks || []).find(x => String(x.id) === String(tdTaskId))
    if (t && (/generating/i.test(t.status || '') || !reportForTask(t))) renderTaskReport()
  }

  const active = s.tasks.filter(t => t.status === 'in-progress').length
  const done = s.tasks.filter(t => ['completed', 'done'].includes(t.status)).length
  const queued = s.queue.filter(d => d.status === 'pending').length
  $('#stats').innerHTML = [
    ['acc', active, 'active tasks'],
    ['cyan', queued, 'queued'],
    ['ok', done, 'completed'],
    ['violet', s.tasks.length, 'total tasks'],
  ].map(([cls, n, l]) => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')
  $('#ovSub').textContent = `${SQUADS.filter(x => x.id !== 'universal' && !x.hidden).length} squads · live ${fmtTime(s.now)}`
  $('#ovActivity').innerHTML = actList(s.activity.slice(0, 16))
  $('#activityFull').innerHTML = actList(s.activity)

  renderTasks(s)
  renderReports(s)
}
// Overview empty-state: an animated preview of what a run looks like (dispatch →
// progress → findings stream → report). Uses only .demo-* classes (in app.css); the
// sample findings are illustrative — rendered ONLY when state.tasks is empty.
const DEMO_LOOP_HTML = `<div class="demo-inline">
  <div class="demo-body">
    <p class="empty" style="text-align:left;margin:0 0 16px;font-size:14px">No runs yet. Queue a target from <b>New dispatch</b> — every run moves through the same pipeline:</p>
    <div class="demo-stage">
      <div class="demo-s1"><b>▸ DISPATCH</b><small>target accepted · scope gate passed</small></div>
      <div class="demo-s2"><b>▸ LIVE PROGRESS</b><small>recon → fingerprint → plan → specialist waves</small></div>
      <div class="demo-s3"><b>▸ FINDINGS</b><small>independently verified live as they land</small></div>
      <div class="demo-s4"><b>▸ REPORT GENERATED</b><small>SCRIBE writes one de-duplicated report</small></div>
    </div>
  </div>
</div>`
// task-card render — skipped when nothing changed so an inline-open report survives the poll
function renderTasks(s, force) {
  const sig = JSON.stringify(s.tasks.map(t => [t.id, t.status, t.progress, t.totalCost])) + '|' + REPORTS.length
  if (!force && sig === lastTaskSig) return
  lastTaskSig = sig
  const recent = s.tasks.slice(0, 4)
  $('#ovTasks').innerHTML = recent.length ? `<div class="grid" style="gap:14px">${recent.map(taskCard).join('')}</div>` : DEMO_LOOP_HTML
  $('#taskList').innerHTML = s.tasks.length ? s.tasks.map(taskCard).join('') : '<div class="empty">No tasks yet.</div>'
  bindDynamic()
}
// reports tab — each row opens the full-page report (no popup)
function renderReports(s, force) {
  const sig = (s.reports || []).map(r => r.rel + r.mtime).join('|')
  if (!force && sig === lastRepSig) return
  lastRepSig = sig
  $('#reportList').innerHTML = s.reports.length ? s.reports.map(r =>
    `<div class="r" data-ropen="${esc(r.rel)}" data-title="${esc(r.name)}">
      <span class="ic"><svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5M9 13h7M9 17h7"/></svg></span>
      <span class="nm">${esc(r.name)}</span>
      <span class="meta">${esc(r.dir)} · ${(r.size / 1024).toFixed(1)} KB · ${fmtTime(r.mtime)}</span>
    </div>`).join('') : '<div class="empty">No reports yet. Run a task to completion.</div>'
  bindDynamic()
}
function actList(acts) {
  if (!acts || !acts.length) return '<div class="empty">No activity yet.</div>'
  return acts.map(a => `<div class="act"><span class="t">${a.ts ? fmtTime(a.ts) : ''}</span><span class="ag">${esc(a.agent || '·')}</span><span class="msg">${esc((a.action || a.raw || '').slice(0, 170))}</span></div>`).join('')
}
function bindDynamic() {
  // clicking a task card opens its per-run page (Overview / Findings / Report)
  $$('[data-taskopen]').forEach(el => el.onclick = () => openTaskPage(el.dataset.taskopen))
  // Reports-tab rows open the full-page report
  $$('[data-ropen]').forEach(el => el.onclick = () => openReportPage(el.dataset.ropen, el.dataset.title))
}
$('#repBack').onclick = () => show(reportBackTo || 'tasks')

/* ── findings & triage ── */
const SEV = ['Critical', 'High', 'Medium', 'Low', 'Info']

/* ── CVSS 3.1 base-score calculator — defined in cvss.js (loaded before app.js) ── */
let fnTaskId = '', fnFindings = [], fnVerdicts = {}
let tdTaskId = '', tdBackTo = 'tasks', tdSub = 'overview', tdLogLoaded = false

/* ── per-run detail page (Overview / Findings / Report) ── */
async function openTaskPage(taskId) {
  // resolve to the engagement root so iterations all open the same aggregated page — but only if the
  // root actually has a run. A combined white-box engagement's root is the *deferred* black-box
  // iteration (no task record until it starts), which would render "Run not found." In that case fall
  // back to an iteration that has a live run (e.g. the white-box code review).
  try {
    const ir = await api('GET', '/api/iterations?taskId=' + encodeURIComponent(taskId))
    if (ir && ir.engagementId) {
      const tasks = (lastState && lastState.tasks) || []
      const has = id => tasks.some(x => String(x.id) === String(id))
      taskId = has(ir.engagementId) ? ir.engagementId
        : ((ir.iterations || []).map(it => it.taskId).find(has) || ir.engagementId)
    }
  } catch {}
  tdBackTo = currentView === 'task' ? tdBackTo : currentView
  tdTaskId = taskId; fnTaskId = taskId; tdLogLoaded = false; lrunSevFilter = ''
  const t = (lastState ? lastState.tasks : []).find(x => String(x.id) === String(taskId)) || { id: taskId }
  $('#tdTitle').textContent = t.title || taskId
  $('#tdId').textContent = taskId
  updateTdHeader(t)
  // Land on the Overview (the live-run review) first for every card click — including
  // "View findings & report" and "Open run"; only a run waiting on YOU jumps straight to
  // Findings to triage (matches its "Triage findings →" opener).
  const sub = t.status === 'awaiting-triage' ? 'findings' : 'overview'
  show('task'); setTdSub(sub)
  if (sub !== 'findings') loadFindings() // populate the Findings count + summary even when landing elsewhere
}
function setTdSub(sub) {
  tdSub = sub
  $$('#tdTabs button').forEach(b => b.classList.toggle('on', b.dataset.td === sub))
  ;['overview', 'findings', 'log', 'report'].forEach(s => { const el = $('#td-' + s); if (el) el.style.display = s === sub ? '' : 'none' })
  if (sub === 'overview') renderTaskOverview(true)
  else if (sub === 'findings') loadFindings()
  else if (sub === 'log') renderTaskLogs()
  else if (sub === 'report') renderTaskReport()
}
$$('#tdTabs button').forEach(b => b.onclick = () => setTdSub(b.dataset.td))
$('#tdBack').onclick = () => show(tdBackTo || 'tasks')
// Keep the run-page header (status badge + Cancel) current on every tab. The Cancel button
// lives in the header so it's reachable while running no matter which tab you landed on
// (in-progress opens on Logs) — same for black-box and code-review.
function updateTdHeader(t) {
  if (!t) return
  $('#tdStatus').textContent = t.status || ''
  $('#tdStatus').className = 'badge ' + statusClass(t.status)
  const cb = $('#tdCancelHdr'); if (cb) cb.style.display = t.status === 'in-progress' ? '' : 'none'
}
$('#tdCancelHdr').onclick = async () => {
  const cb = $('#tdCancelHdr'); cb.disabled = true
  const r = await api('POST', '/api/cancel', { taskId: tdTaskId })
  toast(r && !r.error ? 'Cancel sent' : 'Cancel failed', tdTaskId, r && !r.error ? 'ok' : 'err')
}

// Run-detail Overview as a live-run panel: stage strip → (live run card + squad viz | streaming
// findings) → Goal + model routing. All values come from the task object + the already-loaded
// fnFindings (the Findings tab's array) — no new API calls.
function renderTaskOverview(force) {
  const t = (lastState ? lastState.tasks : []).find(x => String(x.id) === String(tdTaskId))
  if (!t) { $('#td-overview').innerHTML = '<div class="empty">Run not found.</div>'; return }
  const running = t.status === 'in-progress'
  const done = ['completed', 'done'].includes(t.status)
  const prog = done ? 100 : (t.progress || 0)
  const clamp = n => Math.max(0, Math.min(100, Math.round(n)))
  const sq = SQUAD_BY[String(t.squad || '').replace(/-squad$/, '')]
  const squadName = esc(String(t.squad || '').replace(/-squad$/, ''))
  const lead = (sq && sq.leader) || t.assignee || 'ATLAS'

  // stage strip: 5 fixed phases; done/active derived exactly like phaseSteps(t) (floor of progress)
  const STAGES = [['DISPATCH', 'scope gate passed'], ['RECON', 'surface fingerprinted'],
    ['SPECIALISTS', 'waves attacking'], ['TRIAGE', 'validated live'], ['REPORT', 'de-duplicated dossier']]
  const nDone = done ? STAGES.length : Math.floor(prog / 100 * STAGES.length)
  const stagesHtml = STAGES.map((s, i) => {
    const cls = i < nDone ? 'done' : (running && i === nDone ? 'active' : '')
    return `<div class="st ${cls}"><b>${s[0]}</b><small>${s[1]}</small></div>`
  }).join('')

  // three progress bars — reuse the overall % (recon/plan finish early, waves ≈ overall)
  const barPct = (lo, hi) => prog <= lo ? 0 : (prog >= hi ? 100 : clamp((prog - lo) / (hi - lo) * 100))
  const bars = [['Recon & fingerprint', done ? 100 : barPct(0, 18)],
    ['ATLAS attack plan', done ? 100 : barPct(12, 34)], ['Specialist waves', done ? 100 : clamp(prog)]]
  const barsHtml = bars.map(([label, pct]) =>
    `<div class="p"><div class="pl"><b>${label}</b><span class="pc">${pct >= 100 ? 'done' : pct + '%'}</span></div>` +
    `<div class="bar"><i style="width:${pct}%${pct >= 100 ? ';background:var(--emerald)' : ''}"></i></div></div>`).join('')

  // squad-dispatch viz (reuse squadDispatchViz), greened to the done state when finished
  let viz = squadDispatchViz(sq)
  if (done) viz = viz.replace('class="dvz"', 'class="dvz dvz-done"').replace('class="dvz-triage"', 'class="dvz-triage done"')

  // findings board — reuse the Findings tab's already-loaded array (no new fetch), top 6 by severity
  const findings = (String(fnTaskId) === String(tdTaskId)) ? fnFindings : []
  const sevOf = f => (fnVerdicts[f.key] || {}).severity || f.severity || 'Info'
  const active = findings.filter(f => (fnVerdicts[f.key] || {}).verdict !== 'rejected')
  const verified = active.filter(f => ['validated', 'scored'].includes(f.stage) || f.confirmation_status === 'RUNTIME_CONFIRMED').length
  // Only a live scan needs to refresh: skip the re-render when nothing moved. A done run's
  // signature is stable, so after the final render it stops re-rendering (no .stream re-flash).
  // force=true (tab open/switch) always renders.
  // Live agents on THIS run (from agent-status) + focused test-plan status — drive the indicators below.
  const _as = (lastState && lastState.agentStatus) || {}
  const workingAgents = Object.entries(_as)
    .filter(([, v]) => v && String(v.status).toLowerCase() === 'working' && String(v.taskId) === String(t.id))
    .map(([a]) => a.toUpperCase())
  const _tplanSig = (t.testPlan || []).map(p => p.status).join('')
  const ovSig = [tdTaskId, t.status, t.progress || 0, active.length, verified, t.statusMessage || '', _tplanSig, workingAgents.join(',')].join('|')
  if (!force && ovSig === lastTdOvSig) return
  lastTdOvSig = ovSig
  const SEV_ABBR = { Critical: 'CRIT', High: 'HIGH', Medium: 'MED', Low: 'LOW', Info: 'INFO' }
  // severity filter chips — counts per severity; clicking one narrows the board to it
  const sevCounts = {}; for (const f of active) { const s = sevOf(f); sevCounts[s] = (sevCounts[s] || 0) + 1 }
  if (lrunSevFilter && !sevCounts[lrunSevFilter]) lrunSevFilter = ''   // drop a filter that no longer matches
  const distinctSev = SEV.filter(s => sevCounts[s])
  const filterChips = distinctSev.length > 1
    ? `<div class="lrun-sevfilter"><button class="lrun-sev${lrunSevFilter === '' ? ' on' : ''}" data-sev="">All · ${active.length}</button>` +
      distinctSev.map(s => `<button class="lrun-sev${lrunSevFilter === s ? ' on' : ''}" data-sev="${s}"><span class="d" style="background:var(--sev-${s.toLowerCase()})"></span>${SEV_ABBR[s]} · ${sevCounts[s]}</button>`).join('') + '</div>'
    : ''
  const sorted = active.slice().sort((a, b) => SEV.indexOf(sevOf(a)) - SEV.indexOf(sevOf(b)))
  const shown = lrunSevFilter ? sorted.filter(f => sevOf(f) === lrunSevFilter) : sorted   // render ALL (filtered); .lrun-scroll scrolls
  const rowsHtml = shown.map(f => {
    const sev = sevOf(f), v = fnVerdicts[f.key] || {}
    const score = v.cvss != null ? v.cvss : f.cvss
    return `<div class="row stream" data-fkey="${esc(f.key)}" title="Open finding"><span class="badge sev-${String(sev).toLowerCase()}">${esc(SEV_ABBR[sev] || sev)}</span>` +
      `<span class="t">${esc(f.title || '(untitled)')}</span>${score != null ? `<span class="sc">${esc(String(score))}</span>` : ''}<span class="lrun-open">→</span></div>`
  }).join('')
  const spinRow = running ? `<div class="row" style="border-style:dashed;opacity:.6"><span class="spin" style="margin:0"></span><span class="t" style="color:var(--fg-mut)">specialists testing…</span></div>` : ''
  const findBody = (active.length || running)
    ? `${filterChips}<div class="lrun-scroll">${rowsHtml}${spinRow}</div><div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:18px;color:var(--fg-mut);font-size:12px"><span>${active.length} found</span><span style="color:var(--emerald)">${verified} verified</span>${lrunSevFilter ? `<span>· ${shown.length} shown</span>` : ''}${running ? '<span>testing…</span>' : ''}</div>`
    : `<div class="empty" style="padding:18px 0">No findings recorded${done ? '' : ' yet'}.</div>`

  // cost/model table (unchanged content, relocated below)
  let costRows = ''
  if (t.costByAgent && Object.keys(t.costByAgent).length) {
    costRows = '<table class="costtable"><tr><th>Agent</th><th>Model</th></tr>' +
      Object.keys(t.costByAgent).map((a) => { const cm = (t.costs || []).find(x => x.agent === a); return `<tr><td><span class="mini-av">${avatar(a, 20)} ${esc(a)}</span></td><td style="color:var(--fg-dim)">${esc(cm ? cm.model : '')}</td></tr>` }).join('') + '</table>'
  } else {
    costRows = '<div class="hint">Agent + model routing appears here once specialists run.</div>'
  }

  const statusTxt = done ? 'report generated' : running ? `running · ${clamp(prog)}%` : esc(t.status || '')
  const accent = done ? 'var(--emerald)' : 'var(--accent)'
  const glow = done ? 'rgba(52,211,153,.22)' : 'rgba(124,131,255,.22)'
  const cacheBit = t.cacheHitRate ? ` · cache ${t.cacheHitRate}%` : ''

  // Engagement / dispatch config — the structured dispatch summary lives in the goal string
  // (target, coverage, test-account count); the full scope/creds/focus is in the engagement brief.
  const goalRaw = t.goal || ''
  const engUrl = (goalRaw.match(/https?:\/\/[^\s)]+/) || [])[0] || ''
  const engCov = (goalRaw.match(/full end-to-end|feature[- ]driven|feature[- ]focused|white-box code review|static analysis/i) || [''])[0]
  const engAcct = goalRaw.match(/(\d+)\s+test account/i)
  const engObjective = goalRaw.split(/[;.]?\s*scope \+ credentials in engagement brief:/i)[0].trim() || goalRaw
  const engLink = /^https?:\/\/[^\s"'<>]+$/.test(engUrl)
  const engRows = [
    `<div class="rrow"><span class="rk">Squad</span><div class="rv">${squadName || '—'} · lead ${esc(lead)}</div></div>`,
    engUrl ? `<div class="rrow"><span class="rk">Target</span><div class="rv">${engLink ? `<a href="${esc(engUrl)}" target="_blank" rel="noopener noreferrer" class="fmono" style="color:var(--accent-2)">${esc(engUrl)}</a>` : `<span class="fmono">${esc(engUrl)}</span>`}</div></div>` : '',
    engCov ? `<div class="rrow"><span class="rk">Coverage</span><div class="rv">${esc(engCov)}</div></div>` : '',
    engAcct ? `<div class="rrow"><span class="rk">Test accounts</span><div class="rv">${esc(engAcct[1])}</div></div>` : '',
    `<div class="rrow"><span class="rk">Status</span><div class="rv">${esc(statusTxt)}</div></div>`,
  ].filter(Boolean).join('')

  // Test plan (what's being tested + what's remaining): focused scan → selected classes + live status;
  // full scan → "all classes". Working-now strip → the agents actively testing THIS run right now.
  const tplanChips = (t.testPlan && t.testPlan.length)
    ? t.testPlan.map(p => { const icon = p.status === 'done' ? '✓' : p.status === 'running' ? '▶' : '⏳'; return `<span class="tplan-chip ${esc(p.status)}" title="${esc(p.specialist)} · ${esc(p.status)}">${icon} ${esc(p.label)}</span>` }).join('')
    : `<span class="tplan-chip full">Full scan — all classes</span>`
  const workingHtml = (running && workingAgents.length)
    ? `<div class="lrun-working"><span class="lrun-working-dot"></span>Working now: ${workingAgents.map(a => `<b>${esc(a)}</b>`).join(' · ')}</div>`
    : ''
  $('#td-overview').innerHTML = `
    <div class="lrun-stages">${stagesHtml}</div>
    <div class="lrun-cols">
      <div class="card lrun-card${done ? ' done' : ''}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="min-width:0">
            <div style="font-weight:650;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title || t.id)}</div>
            <div style="font-family:var(--mono);font-size:11px;color:var(--fg-dim);margin-top:3px">${squadName} · lead ${esc(lead)}${cacheBit}</div>
          </div>
          <span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:500;color:${done ? 'var(--emerald)' : 'var(--accent-2)'};white-space:nowrap"><span style="width:6px;height:6px;border-radius:50%;background:${accent};box-shadow:0 0 0 3px ${glow}"></span>${statusTxt}</span>
        </div>
        <div class="lrun-prog">${barsHtml}</div>
        <div style="margin-top:16px">${viz}</div>
        ${workingHtml}
        <div class="tplan"><div class="tplan-h">Test plan</div><div class="tplan-row">${tplanChips}</div></div>
        ${t.statusMessage ? `<div class="hint" style="margin-top:12px">${esc(t.statusMessage)}</div>` : ''}
      </div>
      <div class="card lrun-find">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h3 style="margin:0">Findings board</h3>
          <span style="font-family:var(--mono);font-size:11px;color:var(--fg-dim)">${running ? 'verified · streaming' : 'verified'}</span>
        </div>
        ${findBody}
      </div>
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:16px">
      <div class="card"><h3>Engagement</h3><div class="reconbox"><div class="reconhead">Dispatch configuration</div>${engRows}</div><div class="md">${md(engObjective || '_(none)_')}</div><div class="hint" style="margin-top:10px">Full scope, credentials &amp; focus are in the engagement brief — open the <b>Testing logs</b> tab.</div>${(running || t.status === 'awaiting-triage') ? `<div class="report-bar" style="margin-top:12px"><button class="btn sm" id="tdAmend">✎ Amend run</button>${running ? `<button class="btn danger sm" id="tdCancel">■ Cancel</button>` : ''}</div>` : ''}</div>
      <div class="card"><h3>Squad &amp; model routing</h3>${costRows}</div>
    </div>`
  const am = $('#tdAmend'); if (am) am.onclick = () => openAmendPage(t.id, t.title)
  $$('#td-overview .lrun-sev').forEach(b => b.onclick = () => { lrunSevFilter = b.dataset.sev; renderTaskOverview(true) })
  $$('#td-overview .lrun-find .row[data-fkey]').forEach(r => r.onclick = () => openFindingPage(r.dataset.fkey))
  const cc = $('#tdCancel'); if (cc) cc.onclick = async () => { cc.disabled = true; const r = await api('POST', '/api/cancel', { taskId: t.id }); toast(r && !r.error ? 'Cancel sent' : 'Cancel failed', t.id, r && !r.error ? 'ok' : 'err') }
  // M5: static/white-box runs get a Source Runtime card (planner decision, honest mapping counts, per-worker
  // progress). The API returns null for non-source tasks, so this is a no-op for pentest.
  if (/code-review/.test(String(t.squad || '')) || t.mode === 'white-box' || t.mode === 'static') { injectSourceRuntimeCard(t); injectMissionCard(t) }
}
// M7: Mission Control — the team operation live (task board + session plan + coverage + team + decisions).
// Reads /api/mission (observe-only; derived from existing artifacts). All values esc()'d.
async function injectMissionCard(t) {
  let d = null
  try { d = await api('GET', '/api/mission?taskId=' + encodeURIComponent(t.id)) } catch {}
  if (!d || !d.board || !(d.board.counts && d.board.counts.total)) return
  const host = $('#td-overview'); if (!host || String(tdTaskId) !== String(t.id)) return
  const c = d.board.counts || {}, sp = d.sessionPlan
  const stat = (label, val, color) => `<div class="src-stat"><span class="src-stat-v"${color ? ` style="color:${color}"` : ''}>${esc(String(val))}</span><span class="src-stat-l">${esc(label)}</span></div>`
  const team = (d.team || []).map(m => `<span class="rchip">${esc(m.agent)}<span style="opacity:.6"> · ${esc(m.role || '?')}</span></span>`).join('') || '<span class="hint">no active teammates</span>'
  const feed = (d.decisions || []).slice(-8).reverse().map(e => `<div class="src-worker-ev"><span style="color:var(--fg-dim)">${esc(String(e.ts || '').slice(11, 19))}</span> ${esc(e.agent || '')}: ${esc(e.decision || '')}</div>`).join('')
  const html = `
    <div class="card mission-card" style="margin-bottom:16px">
      <h3 style="margin:0 0 2px">Mission Control <span style="font-weight:400;color:var(--fg-dim);font-size:12px">· team operation (observe-only)</span></h3>
      ${sp ? `<div class="hint" style="margin:4px 0 12px">Session plan: <b>${esc(String(sp.session_count))}</b> planned · <b>${esc(String(sp.active_concurrency))}</b> active · ${esc(sp.strategy || '')}${sp.reason ? ` — ${esc(sp.reason)}` : ''}</div>` : ''}
      <div class="src-stats">
        ${stat('Board tasks', c.total || 0)}
        ${stat('Completed', c.completed || 0, 'var(--emerald)')}
        ${stat('Candidates', c.candidate_found || 0, (c.candidate_found ? 'var(--accent-2, #8b9dff)' : ''))}
        ${stat('No issue', c.no_issue || 0)}
        ${stat('Running', (c.running || 0) + (c.claimed || 0))}
        ${stat('Blocked', c.blocked || 0, (c.blocked ? 'var(--rose, #ef4444)' : ''))}
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border, rgba(255,255,255,.08))">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">Team activity</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${team}</div>
      </div>
      ${feed ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border, rgba(255,255,255,.08))"><div style="font-weight:600;font-size:13px;margin-bottom:6px">Decision log</div><div class="src-feed">${feed}</div></div>` : ''}
    </div>`
  const existing = host.querySelector('.mission-card')
  if (existing) existing.outerHTML = html; else host.insertAdjacentHTML('afterbegin', html)
}
async function injectSourceRuntimeCard(t) {
  let d = null
  try { d = await api('GET', '/api/source-runtime?taskId=' + encodeURIComponent(t.id)) } catch {}
  if (!d || (!d.plan && !(d.counts && d.counts.total))) return
  const host = $('#td-overview'); if (!host || String(tdTaskId) !== String(t.id)) return
  const c = d.counts || {}, plan = d.plan || {}, rl = d.rateLimit || 'healthy'
  const rlColor = rl === 'healthy' ? 'var(--emerald)' : 'var(--amber, #f59e0b)'
  const stat = (label, val, color) => `<div class="src-stat"><span class="src-stat-v"${color ? ` style="color:${color}"` : ''}>${val}</span><span class="src-stat-l">${label}</span></div>`
  const workers = (d.sessions || []).map(s => `
    <div class="src-worker">
      <div class="src-worker-h"><b>${esc(s.owner || s.session_id)}</b><span>${s.mapped}/${s.assigned_total || '?'}</span></div>
      ${s.current ? `<div class="src-worker-sub">current: ${esc(s.current)}</div>` : ''}
      ${s.last_event ? `<div class="src-worker-ev">${esc(s.last_event)}</div>` : ''}
    </div>`).join('') || '<div class="hint">workers starting…</div>'
  // parity §9: Feature Coverage card — discovered / mapped / deep / reviewed / no-issue / candidates / gaps.
  const cov = d.coverage
  const section = (title, inner) => `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border, rgba(255,255,255,.08))">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px">${title}</div>${inner}
      </div>`
  const coverageHtml = cov ? section('Feature Coverage', `<div class="src-stats">
          ${stat('Discovered', cov.discovered || 0)}
          ${stat('Mapped', (cov.mapped || 0) + '/' + (cov.discovered || 0), 'var(--emerald)')}
          ${stat('Deep review', cov.deep_mapped || 0)}
          ${stat('Reviewed', cov.reviewed || 0)}
          ${stat('No issue', cov.no_issue || 0)}
          ${stat('With candidates', cov.with_candidates || 0, cov.with_candidates ? 'var(--accent-2, #8b9dff)' : '')}
          ${stat('Blocked', cov.blocked || 0, cov.blocked ? 'var(--rose, #ef4444)' : '')}
          ${stat('Deferred', cov.deferred || 0, cov.deferred ? 'var(--amber, #f59e0b)' : '')}
          ${stat('Follow-ups', cov.followups || 0)}
        </div>`) : ''
  // parity §9: Findings Pipeline card — candidates → triage → validated → judged, + validation breakdown.
  const p = d.pipeline
  const pipelineHtml = (p && (p.candidates_emitted || p.validated)) ? section('Findings Pipeline', `<div class="src-stats">
          ${stat('Candidates', p.candidates_emitted || 0)}
          ${stat('In triage', p.in_triage || 0)}
          ${stat('Triaged', p.triaged || 0)}
          ${stat('Auditor verdicts', p.auditor_verdicts || 0)}
          ${stat('Validated', p.validated || 0, 'var(--accent-2, #8b9dff)')}
          ${stat('Judged', p.judged || 0, 'var(--emerald)')}
          ${stat('Needs live', p.needs_live || 0, p.needs_live ? 'var(--amber, #f59e0b)' : '')}
          ${stat('Runtime confirmed', p.runtime_confirmed || 0, 'var(--emerald)')}
          ${stat('Disproven', p.disproven || 0, p.disproven ? 'var(--rose, #ef4444)' : '')}
          ${stat('Audit quarantined', p.audit_quarantined || 0, p.audit_quarantined ? 'var(--rose, #ef4444)' : '')}
          ${stat('Triage quarantined', p.triage_quarantined || 0, p.triage_quarantined ? 'var(--rose, #ef4444)' : '')}
          ${p.candidate_ledger_total ? stat('Ledger total', p.candidate_ledger_total) : ''}
        </div>`) : ''
  // M7: white-box validation breakdown — source-confirmed vs needs-live vs runtime-confirmed vs disproven.
  const v = d.validation
  const validationHtml = (v && v.total) ? section(d.mode === 'white-box' ? 'White-Box Validation' : 'Finding validation', `<div class="src-stats">
          ${stat('Source confirmed', v.source_confirmed || 0, 'var(--accent-2, #8b9dff)')}
          ${stat('Needs live validation', v.needs_live || 0, v.needs_live ? 'var(--amber, #f59e0b)' : '')}
          ${stat('Runtime confirmed', v.runtime_confirmed || 0, 'var(--emerald)')}
          ${stat('Disproven', v.disproven || 0, v.disproven ? 'var(--rose, #ef4444)' : '')}
        </div>`) : ''
  // parity §9: live event feed off source-runtime-<taskId>.jsonl (most-recent last).
  const feed = (d.recent || []).slice(-8).reverse().map(e =>
    `<div class="src-worker-ev"><span style="color:var(--fg-dim)">${esc(String(e.ts || '').slice(11, 19))}</span> ${esc(e.message || e.status || e.session_id || '')}</div>`).join('')
  const timelineHtml = feed ? section('Timeline', `<div class="src-feed">${feed}</div>`) : ''
  const reviewSess = (plan.review && plan.review.max_concurrent_sessions) || '?'
  const triageSess = (p && p.triage_sessions) || '?'
  const html = `
    <div class="card src-runtime" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">Source Runtime <span style="font-weight:400;color:var(--fg-dim);font-size:12px">· ${esc(d.mode || 'static')}</span></h3>
        <span style="font-size:11.5px">rate limit: <b style="color:${rlColor}">${esc(rl)}</b></span>
      </div>
      <div class="hint" style="margin:6px 0 4px">Planner: ${plan.features_total || c.total || 0} features → ${plan.mapping_sessions || '?'} mapping · ${esc(String(reviewSess))} review · ${esc(String(triageSess))} triage sessions (${plan.max_concurrent_sessions || '?'} concurrent) · ${esc(plan.strategy || '')}</div>
      ${d.runtime ? `<div class="hint" style="margin:0 0 12px">quota: <b style="color:${rlColor}">${esc(d.runtime.quota_mode || 'healthy')}</b> · ${esc(String(d.runtime.active_sessions))}/${esc(String(d.runtime.planned_sessions))} sessions active${d.runtime.reason ? ` · ${esc(d.runtime.reason)}` : ''}</div>` : ''}
      <div class="src-stats">
        ${stat('Mapped', (c.mapped || 0) + '/' + (c.total || 0), 'var(--emerald)')}
        ${stat('In progress', c.in_progress || 0)}
        ${stat('Queued', c.queued || 0)}
        ${stat('Deferred (rate-limit)', c.deferred || 0, c.deferred ? 'var(--amber, #f59e0b)' : '')}
        ${stat('Blocked gaps', c.blocked || 0, c.blocked ? 'var(--rose, #ef4444)' : '')}
      </div>
      <div class="src-workers">${workers}</div>
      ${coverageHtml}
      ${pipelineHtml}
      ${validationHtml}
      ${timelineHtml}
    </div>`
  const existing = host.querySelector('.src-runtime')
  if (existing) existing.outerHTML = html
  else host.insertAdjacentHTML('afterbegin', html)
}
async function renderTaskReport() {
  const t = (lastState ? lastState.tasks : []).find(x => String(x.id) === String(tdTaskId)) || { id: tdTaskId }
  const rel = reportForTask(t)
  // SCRIBE is writing — show a live "generating" state; render() keeps polling until the report lands
  if (/generating/i.test(t.status || '')) {
    $('#tdReportBody').innerHTML = `<div class="empty"><div class="spin"></div>Generating report — SCRIBE is writing from the confirmed findings. This takes a few minutes; it'll appear here automatically.</div>`
    return
  }
  if (!rel) { $('#tdReportBody').innerHTML = `<div class="empty">No report yet.${t.status === 'awaiting-triage' ? ' Triage the findings, then click Generate report.' : ' Generate it from the Findings tab.'}</div>`; return }
  $('#tdReportBody').innerHTML = '<div class="skel"></div>'
  await loadReport(rel); $('#tdReportBody').innerHTML = md(reportCache[rel] || '_Could not load report._')
}
// friendly label for a raw artifact filename
function artLabel(name) {
  const m = name.replace(/-t-\d+-[a-f0-9]+/i, '').replace(/\.(json|jsonl|md)$/i, '').replace(/^pentest-/, '')
  return { 'brief': 'Engagement brief', 'env-fingerprint': 'Environment fingerprint', 'tech-stack': 'Tech stack', 'target-profile': 'Target profile', 'scope': 'Scope', 'endpoints': 'Discovered endpoints', 'live-findings': 'Raw findings (live)', 'engagement': 'Engagement', 'triage': 'Triage verdicts' }[m] || m.replace(/[-_]/g, ' ')
}
// attack-surface snapshot box at the top of the Testing-logs tab
function renderReconBox(r) {
  const box = $('#tdReconBox'); if (!box) return
  if (!r || (!r.ports.length && !r.product && !r.endpoints && !r.notablePaths.length)) { box.innerHTML = ''; return }
  const chips = (arr, cls) => arr.map(x => `<span class="rchip ${cls || ''}">${esc(x)}</span>`).join('')
  const facts = [
    r.ports.length ? `<div class="rrow"><span class="rk">Open ports</span><div class="rv">${chips(r.ports, 'port')}</div></div>` : '',
    r.product ? `<div class="rrow"><span class="rk">Product</span><div class="rv">${esc(r.product)}${r.server ? ` <span class="dim">· ${esc(r.server)}</span>` : ''}</div></div>` : '',
    r.waf ? `<div class="rrow"><span class="rk">WAF</span><div class="rv">${esc(r.waf)}</div></div>` : '',
    r.frameworks.length ? `<div class="rrow"><span class="rk">Stack</span><div class="rv">${chips(r.frameworks)}</div></div>` : '',
    r.endpoints ? `<div class="rrow"><span class="rk">Surface</span><div class="rv"><span class="rchip">${r.endpoints.total} URLs</span>${r.endpoints.apis ? `<span class="rchip">${r.endpoints.apis} APIs</span>` : ''}${r.endpoints.forms ? `<span class="rchip">${r.endpoints.forms} forms</span>` : ''}</div></div>` : '',
    r.notablePaths.length ? `<div class="rrow"><span class="rk">Notable paths</span><div class="rv">${chips(r.notablePaths, 'path')}</div></div>` : '',
    r.cveCandidates.length ? `<div class="rrow"><span class="rk">CVE leads</span><div class="rv">${chips(r.cveCandidates, 'cve')}</div></div>` : '',
  ].filter(Boolean).join('')
  box.innerHTML = `<div class="reconhead">Attack surface</div>${facts}`
}
async function renderTaskLogs() {
  const tid = tdTaskId
  const stream = $('#tdLogStream'), arts = $('#tdLogArtifacts')
  if (!stream) return
  if (!tdLogLoaded) stream.innerHTML = '<div class="skel"></div>'
  const r = await api('GET', '/api/logs?taskId=' + encodeURIComponent(tid))
  if (tid !== tdTaskId) return // navigated away while fetching
  tdLogLoaded = true
  const acts = (r && r.activity) || []
  const artifacts = (r && r.artifacts) || []
  renderReconBox(r && r.recon)
  arts.innerHTML = artifacts.length
    ? `<div class="art-lbl">Raw results — download</div>` + artifacts.map(a =>
        `<a class="art" href="/api/report?f=${encodeURIComponent(a.rel)}" download="${esc(a.name)}" title="${esc(a.name)} · ${(a.size / 1024).toFixed(1)} KB">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
          <span>${esc(artLabel(a.name))}</span><span class="art-sz">${(a.size / 1024).toFixed(1)} KB</span></a>`).join('')
    : ''
  // The log flows on the page (no internal scroll box) and new lines append at the bottom,
  // so the browser keeps your page-scroll position across this 2.5s re-render — never a yank.
  // We deliberately do NOT touch scroll: you scroll the whole page freely, top to bottom.
  stream.innerHTML = acts.length ? acts.map(a => {
    const det = String(a.details || '').trim()
    const act = String(a.action || a.raw || '').trim()
    const isPhase = /phase\s*[\d.]/i.test(act)
    return `<div class="logrow${isPhase ? ' phase' : ''}">
      <span class="lt">${a.ts ? fmtTime(a.ts) : ''}</span>
      <span class="la">${esc(a.agent || '·')}</span>
      <div class="lc"><div class="lact">${esc(act)}</div>${det && det !== act ? `<pre class="ldet">${esc(det)}</pre>` : ''}</div>
    </div>`
  }).join('') : '<div class="empty">No activity logged for this run yet.</div>'
}

let fnEngagementId = '', fnIterations = [], fnFilter = ''
async function loadFindings() {
  if (!fnTaskId) { $('#fnList').innerHTML = '<div class="empty">No run selected.</div>'; $('#fnActions').style.display = 'none'; $('#fnIterBar').innerHTML = ''; return }
  const r = await api('GET', '/api/findings?taskId=' + encodeURIComponent(fnTaskId))
  fnFindings = (r && r.findings) || []
  fnEngagementId = (r && r.engagementId) || fnTaskId
  fnIterations = (r && r.iterations) || []
  fnVerdicts = {}
  for (const f of fnFindings) fnVerdicts[f.key] = {
    verdict: (f.triage && f.triage.verdict) || 'confirmed',
    severity: (f.triage && f.triage.severity) || f.severity,
    cvss: (f.triage && f.triage.cvss != null) ? f.triage.cvss : f.cvss,
    cvssVector: (f.triage && f.triage.cvssVector) || f.cvssVector || '',
    notes: (f.triage && f.triage.notes) || '',
  }
  $('#tdFnCount').textContent = fnFindings.length
  renderIterBar()
  renderFindings()
}
// iterations bar: filter chips (when >1 iteration) + "Run another test"
function renderIterBar() {
  const multi = fnIterations.length > 1
  const chips = multi ? `<span class="iter-lbl">Iterations</span>` +
    `<button class="iter-chip ${fnFilter === '' ? 'on' : ''}" data-iter="">All · ${fnFindings.length}</button>` +
    fnIterations.map(it => `<button class="iter-chip ${fnFilter === it.taskId ? 'on' : ''}" data-iter="${esc(it.taskId)}">${esc(it.label || 'run')} · ${it.count}</button>`).join('') : ''
  // "Run another test" spawns a live pentest iteration (needs a target URL + engagement), so
  // it applies to black-box and white-box (both route through the pentest engine) but NOT to a
  // standalone static review — there is no live target to re-test. Hiding it there is correct,
  // not a parity gap, and avoids the button erroring with "engagement not found".
  const curT = (lastState ? lastState.tasks : []).find(x => String(x.id) === String(fnTaskId))
  const canIterate = curT && /pentest/.test(String(curT.squad || ''))
  const runBtn = canIterate ? `<button class="btn sm primary" id="fnRunAnother" style="margin-left:auto">＋ Run another test</button>` : ''
  $('#fnIterBar').innerHTML = `${chips}${runBtn}`
  const ra = $('#fnRunAnother'); if (ra) ra.onclick = () => { const f = $('#fnIterForm'); f.style.display = f.style.display === 'none' ? 'block' : 'none' }
  $$('#fnIterBar .iter-chip').forEach(c => c.onclick = () => { fnFilter = c.dataset.iter; renderIterBar(); renderFindings() })
}
// lifecycle pill: agent-confirmed (amber) → validated (green) → scored (green + CVSS) → suspected (grey)
function stagePill(f) {
  const s = f.stage || (f.source === 'validated' ? 'validated' : 'agent-confirmed')
  if (s === 'scored') return `<span class="fstatus ok" title="Validator-confirmed and CVSS-scored">✓ Validated · CVSS</span>`
  if (s === 'validated') return `<span class="fstatus ok" title="Confirmed by the validator (AUDITOR)">✓ Validated</span>`
  if (s === 'agent-confirmed') return `<span class="fstatus amber" title="The finding agent confirmed this — awaiting validator">● Agent-confirmed</span>`
  if (s === 'suspected') return `<span class="fstatus muted" title="Suspected — not yet confirmed">Suspected</span>`
  return ''
}
// runtime-vs-source confirmation badge (keyed on the derived confirmation_status) — makes clear
// whether a finding was proven against the live target or only in the code.
function confirmationBadge(f) {
  switch (f.confirmation_status) {
    case 'RUNTIME_CONFIRMED': return `<span class="fstatus ok" title="Proven against the live target — runtime evidence captured">⚡ Runtime</span>`
    case 'SOURCE_CONFIRMED': return `<span class="fstatus" style="color:#8ab4ff;background:rgba(138,180,255,.13);border:1px solid rgba(138,180,255,.4)" title="Confirmed by reading the code — not fired at a live target">◆ Source</span>`
    case 'NEEDS_LIVE_VALIDATION': return `<span class="fstatus muted" title="Hypothesis — needs a live target to settle">Needs live</span>`
    case 'DISPROVEN': return `<span class="fstatus" style="color:#f87171;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.4)" title="Checked and refuted">Disproven</span>`
    default: return ''
  }
}
// severity summary reflects the CURRENT triage across the WHOLE engagement (overrides applied, rejected excluded)
function recountSummary() {
  const counts = {}; for (const s of SEV) counts[s] = 0
  let cancelled = 0
  for (const f of fnFindings) { const v = fnVerdicts[f.key] || {}; if (v.verdict === 'rejected') { cancelled++; continue } const sv = v.severity || f.severity; counts[sv] = (counts[sv] || 0) + 1 }
  $('#fnSummary').innerHTML = SEV.map(s => `<div class="stat"><div class="n" style="color:var(--sev-${s.toLowerCase()})">${counts[s] || 0}</div><div class="l">${s}</div></div>`).join('')
  const el = $('#tdFnCount'); if (el) el.textContent = cancelled ? `${fnFindings.length - cancelled} (${cancelled} cancelled)` : String(fnFindings.length)
}
function renderFindings() {
  recountSummary()
  if (!fnFindings.length) { $('#fnList').innerHTML = '<div class="empty">No findings for this run yet.</div>'; $('#fnActions').style.display = 'none'; return }
  const shown = fnFindings.filter(f => !fnFilter || f.srcTask === fnFilter)
  $('#fnList').innerHTML = shown.map(f => {
    const v = fnVerdicts[f.key]
    const sevNow = v.severity || f.severity
    const cvssNow = v.cvss != null ? v.cvss : f.cvss
    return `<div class="finding clickable ${v.verdict === 'rejected' ? 'rejected' : ''}" data-fkey="${esc(f.key)}" title="Open finding">
      <div class="fmain">
        <span class="badge fbadge sev-${sevNow.toLowerCase()}">${esc(sevNow)}</span>
        ${cvssNow != null ? `<span class="fcvss">CVSS ${cvssNow}</span>` : ''}
        ${v.verdict === 'rejected' ? '<span class="fcancelled">✕ Cancelled</span>' : stagePill(f) + confirmationBadge(f)}
        <span class="ftitle">${esc(f.title)}</span>
        ${f.iteration ? `<span class="iter-tag">${esc(f.iteration)}</span>` : ''}
        <div class="seg fverdict" data-noopen><button data-fv="confirmed" class="${v.verdict !== 'rejected' ? 'on' : ''}" type="button" title="Confirm">✓</button><button data-fv="rejected" class="${v.verdict === 'rejected' ? 'on' : ''}" type="button" title="Reject">✕</button></div>
        <span class="fopen">open →</span>
      </div>
      <div class="fmeta">${esc(f.agent)}${f.url ? ` · <span class="fmono">${esc(f.method || '')} ${esc(f.url)}</span>` : ''}${v.notes ? ' · <span style="color:var(--accent-2)">noted</span>' : ''}${f.enriched ? ' · <span style="color:var(--ok)">enriched</span>' : ''}</div>
    </div>`
  }).join('') || '<div class="empty">No findings in this iteration.</div>'
  $$('#fnList .finding').forEach(card => {
    const key = card.dataset.fkey
    card.onclick = (e) => { if (e.target.closest('[data-noopen]')) return; openFindingPage(key) }
    card.querySelectorAll('.fverdict button').forEach(b => b.onclick = (e) => {
      e.stopPropagation()
      fnVerdicts[key].verdict = b.dataset.fv
      renderFindings() // re-render so the Cancelled tag swaps + count adjusts live
      saveTriage() // persist immediately so opening a finding / navigating never loses the verdict
    })
  })
  $('#fnActions').style.display = 'flex'
  updateTriageState()
}
function updateTriageState() {
  const conf = Object.values(fnVerdicts).filter(v => v.verdict !== 'rejected').length
  const rej = Object.values(fnVerdicts).length - conf
  $('#fnTriageState').textContent = `${conf} confirmed · ${rej} rejected — report will include the ${conf} confirmed`
}
// route each finding's verdict to its source iteration's triage file (byTask)
async function saveTriage() {
  if (!fnFindings.length) return { triaged: 0 }
  const byTask = {}
  for (const f of fnFindings) { const v = fnVerdicts[f.key]; if (!v) continue; (byTask[f.srcTask] = byTask[f.srcTask] || {})[f.id] = v }
  return api('POST', '/api/triage', { byTask })
}
$('#fnSave').onclick = async () => { const r = await saveTriage(); if (r && !r.error) toast('Triage saved', `${r.triaged} verdict(s)`, 'ok'); else toast('Save failed', r && r.error, 'err') }
// Export all findings → one combined Markdown file, or a Zip of per-finding .md files (+ combined). The server
// streams an attachment; a hidden <a download> triggers the save without navigating away.
function exportFindings(fmt) {
  if (!fnTaskId) return toast('Nothing to export', 'No run selected', 'err')
  if (!fnFindings.length) return toast('Nothing to export', 'No findings for this run', 'err')
  const a = document.createElement('a')
  a.href = `/api/findings/export?fmt=${fmt}&taskId=${encodeURIComponent(fnTaskId)}`
  a.download = ''; document.body.appendChild(a); a.click(); a.remove()
  toast('Export started', `findings-${fnTaskId}.${fmt === 'md' ? 'md' : 'zip'}`, 'ok')
}
$('#fnExportMd').onclick = () => exportFindings('md')
$('#fnExportZip').onclick = () => exportFindings('zip')
$('#fnEnrich').onclick = async () => {
  const r = await api('POST', '/api/enrich-findings', { taskId: fnTaskId })
  if (r && !r.error) toast('Enriching findings…', 'AUDITOR writing description / impact / remediation — reload in ~1 min', 'ok')
  else toast('Enrich failed', r && r.error, 'err')
}

/* ── single finding page (structured info + CVSS calculator + notes) ── */
let fdKey = '', fdCalcTouched = false
function openFindingPage(key) {
  const f = fnFindings.find(x => x.key === key); if (!f) return
  const v = fnVerdicts[key] || {}
  fdKey = key
  fdCalcTouched = false
  const sevNow = v.severity || f.severity
  $('#fdTitle').textContent = f.title
  $('#fdSevBadge').textContent = sevNow; $('#fdSevBadge').className = 'badge sev-' + sevNow.toLowerCase()
  const sec = (k, val, mono) => `<div class="fsec"><div class="fk">${k}</div>${val ? (mono ? `<pre class="fv mono">${esc(val)}</pre>` : `<div class="fv">${esc(val)}</div>`) : '<div class="fv dim">— not provided · use “Enrich details”</div>'}</div>`
  const steps = Array.isArray(f.testSteps) && f.testSteps.length
    ? `<div class="fsec"><div class="fk">Reproduction steps</div><ol class="fsteps">${f.testSteps.map(s => `<li>${esc(String(s).replace(/^step\s*\d+\s*[:.\-]\s*/i, ''))}</li>`).join('')}</ol></div>`
    : ''
  // POC block — CURL Request (+ raw HTTP request for "modify the request below" cases). The
  // response is intentionally omitted; the "Observed that …" step is the proof, and dumping
  // full responses bloats the report.
  const pocRow = (label, val) => val ? `<div class="pocrow"><div class="fk sub">${label}</div><pre class="fv mono">${esc(val)}</pre></div>` : ''
  // Source location line: live URL for runtime findings, file:line for source findings.
  const locSec = f.url
    ? sec('Vulnerable URL', (f.method ? f.method + ' ' : '') + f.url)
    : (f.file ? sec('Source location', f.file + (f.line ? ':' + f.line : '')) : '')
  // Static / white-box: show the VULNERABLE CODE BLOCK (file:line + snippet) — no HTTP request.
  const codeSec = f.codeBlock
    ? `<div class="fsec pocsec"><div class="fk poc">Vulnerable code${f.file ? ` · ${esc(f.file)}${f.line ? ':' + f.line : ''}` : ''}</div><pre class="fv mono">${esc(f.codeBlock)}</pre></div>`
    : ''
  // Static taint trace (untrusted input → vulnerable sink) — the most valuable part of a source finding.
  const dfSec = f.dataFlow ? sec('Data flow', f.dataFlow) : ''
  // POC (CURL Request, no response) — ONLY for findings with a live URL. Static code review
  // needs none; the vulnerable code block above is the proof.
  const pocBlock = f.url && (f.poc || f.rawRequest)
    ? `<div class="fsec pocsec"><div class="fk poc">POC</div>${pocRow('CURL Request', f.poc)}${f.rawRequest && f.rawRequest !== f.poc ? pocRow('HTTP Request', f.rawRequest) : ''}</div>`
    : (!f.codeBlock && !f.url && f.poc ? `<div class="fsec pocsec"><div class="fk poc">POC</div>${pocRow('Command', f.poc)}</div>` : '')
  const tags = [
    f.cvss != null ? `<span class="fcvss">CVSS ${f.cvss}</span>` : '',
    f.cwe ? `<span class="fcwe">${esc(f.cwe)}</span>` : '',
    stagePill(f),
    confirmationBadge(f),
  ].filter(Boolean).join(' ')
  $('#fdInfo').innerHTML = `<h3>${esc(f.id)} · ${esc(f.agent || '')} ${tags}</h3>
    ${sec('Description', f.description)}
    ${locSec}
    ${steps}
    ${codeSec}
    ${dfSec}
    ${pocBlock}
    ${sec('Impact', f.impact)}
    ${sec('Remediation', f.remediation)}`
  $$('#fdVerdict button').forEach(b => b.classList.toggle('on', (v.verdict || 'confirmed') === b.dataset.fv))
  $('#fdSev').innerHTML = SEV.map(s => `<option ${sevNow === s ? 'selected' : ''}>${s}</option>`).join('')
  const m = parseVector(v.cvssVector || f.cvssVector)
  $('#fdCvssCalc').innerHTML = Object.entries(CVSS_METRICS).map(([k, def]) =>
    `<label class="cvss-m"><span>${def.label}</span><select data-m="${k}">${def.opts.map(([val, lbl]) => `<option value="${val}" ${m[k] === val ? 'selected' : ''}>${lbl} (${val})</option>`).join('')}</select></label>`).join('')
  $('#fdNotes').value = v.notes || ''
  // metric change → operator is using the calc → it drives severity
  $$('#fdCvssCalc select').forEach(s => s.onchange = () => { fdCalcTouched = true; recalcCvss(true) })
  // manual severity override → reflect on the header badge, independent of the calc
  $('#fdSev').onchange = () => setSevBadge($('#fdSev').value)
  // initial display: show score/vector but DO NOT override the stored severity
  recalcCvss(false)
  const storedCvss = (v.cvss != null ? v.cvss : f.cvss)
  const hasVector = !!(v.cvssVector || f.cvssVector)
  if (!hasVector && storedCvss != null) {
    // no vector to seed the calc — show the finding's stored score, not the calc's 0.0
    $('#fdScore').textContent = Number(storedCvss).toFixed(1)
    $('#fdScoreSev').textContent = sevNow; $('#fdScoreSev').className = 'badge sev-' + sevNow.toLowerCase()
  }
  $('#fdSev').value = sevNow            // operator's stored severity (NOT calc-derived)
  setSevBadge(sevNow)
  show('finding')
}
function setSevBadge(sev) { $('#fdSevBadge').textContent = sev; $('#fdSevBadge').className = 'badge sev-' + String(sev).toLowerCase() }
function readCvssMetrics() { const m = {}; $$('#fdCvssCalc select').forEach(s => m[s.dataset.m] = s.value); return m }
// follow=true (operator changed a metric) → also set the severity dropdown + badge.
// follow=false (initial render) → update score/vector display only; leave severity alone.
function recalcCvss(follow = true) {
  const { score, vector } = cvss31(readCvssMetrics())
  const sev = sevFromScore(score)
  $('#fdScore').textContent = score.toFixed(1)
  $('#fdVector').textContent = vector
  $('#fdScoreSev').textContent = sev; $('#fdScoreSev').className = 'badge sev-' + sev.toLowerCase()
  if (follow) { $('#fdSev').value = sev; setSevBadge(sev) }
}
$$('#fdVerdict button').forEach(b => b.onclick = () => $$('#fdVerdict button').forEach(x => x.classList.toggle('on', x === b)))
$('#fdBack').onclick = () => { show('task'); setTdSub('findings') }
$('#fdSave').onclick = async () => {
  const verdict = ($('#fdVerdict button.on') || {}).dataset?.fv || 'confirmed'
  const severity = $('#fdSev').value
  // CVSS: only use the calc if the operator actually touched it — otherwise keep the
  // finding's stored score/vector (prevents clobbering to 0.0 when there's no vector).
  let cvss, vector
  if (fdCalcTouched) { const c = cvss31(readCvssMetrics()); cvss = c.score; vector = c.vector }
  else { const f = fnFindings.find(x => x.key === fdKey) || {}; const vv = fnVerdicts[fdKey] || {}; cvss = (vv.cvss != null ? vv.cvss : f.cvss); vector = vv.cvssVector || f.cvssVector || '' }
  fnVerdicts[fdKey] = { verdict, severity, cvss, cvssVector: vector, notes: $('#fdNotes').value.trim() }
  const r = await saveTriage()
  if (r && !r.error) { toast('Finding saved ✓', `${(fnFindings.find(x => x.key === fdKey) || {}).id || ''} · ${cvss != null ? 'CVSS ' + Number(cvss).toFixed(1) + ' ' : ''}${severity}`, 'ok'); show('task'); setTdSub('findings') }
  else toast('Save failed', r && r.error, 'err')
}
$('#fnGen').onclick = async () => {
  const btn = $('#fnGen'); if (btn.disabled) return // guard against double-spawn
  btn.disabled = true
  const s = await saveTriage(); if (s && s.error) { btn.disabled = false; return toast('Save failed', s.error, 'err') }
  // target the engagement root → daemon aggregates confirmed findings across all iterations
  const r = await api('POST', '/api/generate-report', { taskId: fnEngagementId || fnTaskId })
  if (r && !r.error) { toast('Generating report ✓', 'SCRIBE writing from confirmed findings — appears on the Report tab in a few minutes', 'ok'); setTdSub('report') }
  else toast('Generate failed', r && r.error, 'err')
  setTimeout(() => { btn.disabled = false }, 8000) // re-enable after the request settles
}
// ── run another iteration on this engagement ──
$('#itCancel').onclick = () => { $('#fnIterForm').style.display = 'none' }
$$('#itFocusClasses button').forEach(b => b.onclick = () => b.classList.toggle('on'))
$('#itRun').onclick = async () => {
  const focusClasses = $$('#itFocusClasses button.on').map(b => b.dataset.cls)
  const r = await api('POST', '/api/iterate', { engagementId: fnEngagementId, focusClasses, skipRecon: false })
  if (r && !r.error) {
    toast('Iteration started ✓', `${r.iterationLabel} — runs independently, results will append`, 'ok')
    $('#fnIterForm').style.display = 'none'
    $$('#itFocusClasses button').forEach(b => b.classList.remove('on'))
    show('tasks'); tick()
  } else toast('Iteration failed', r && r.error, 'err')
}

/* ── amend a run ── */
let amTaskId = '', amBackTo = 'tasks'
function openAmendPage(taskId, title) {
  amTaskId = taskId
  amBackTo = currentView === 'amend' ? amBackTo : currentView
  $('#amTitle').textContent = 'Amend: ' + (title || taskId)
  $('#amInstr').value = ''; $('#amScope').value = ''
  $('#amInfo').innerHTML = md(`Amending **${title || taskId}** appends your instructions to the engagement brief and merges any hosts into the task's scope config.\n\n- Remaining phases + the report use the amended brief.\n- New in-scope hosts pass the scope gate.\n\n> Agents run autonomously, so this steers remaining/forthcoming work — it doesn't interrupt an agent mid-action.`)
  show('amend')
}
$('#amBack').onclick = () => show(amBackTo || 'tasks')
$('#amApply').onclick = async () => {
  const instructions = $('#amInstr').value.trim()
  const addScope = $('#amScope').value.split('\n').map(s => s.trim()).filter(Boolean)
  if (!instructions && !addScope.length) { toast('Nothing to amend', 'Add instructions or scope', 'err'); return }
  const r = await api('POST', '/api/amend', { taskId: amTaskId, instructions, addScope })
  if (r && !r.error) { toast('Amendment applied ✓', amTaskId, 'ok'); show(amBackTo || 'tasks') }
  else toast('Amend failed', r && r.error, 'err')
}

/* ── squads ── */
function renderSquads() {
  $('#cSquads').textContent = SQUADS.filter(s => s.id !== 'universal' && !s.hidden).length
  $('#squadList').innerHTML = SQUADS.filter(s => !s.hidden).map(sq => `<div class="squad" style="--sq:${squadHue(sq.id)}">
    <div class="banner"><span class="name">${esc(sq.id)}</span></div>
    <div class="body">
      ${sq.leader !== '—' ? `<div class="lead">${avatar(sq.leader, 26)} <b>${esc(sq.leader)}</b><span style="color:var(--fg-dim);font-size:11px">leads</span></div>` : '<div class="lead"><b style="color:var(--fg-mut)">cross-squad</b></div>'}
      <div class="type">${esc(sq.type || '')} · ${sq.agents.length} personas</div>
      ${sq.phases.length ? `<div class="stepper" style="margin:4px 0 14px">${sq.phases.map(p => `<div class="step">${esc(p)}</div>`).join('')}</div>` : ''}
      <div class="chips">${sq.agents.map(a => `<span class="chip">${esc(a)}</span>`).join('')}</div>
    </div>
  </div>`).join('')

  const sel = $('#fSquad')
  sel.innerHTML = SQUADS.filter(s => s.id !== 'universal' && !s.hidden).map(s => `<option value="${esc(s.id)}">${esc(s.id)} — leader ${esc(s.leader)}</option>`).join('')
  updateDispatchInfo()
}
const isCR = () => $('#fSquad').value === 'code-review'
const isPT = () => $('#fSquad').value === 'pentest'

// ── pentest credential rows ──
function credRow(u = '', p = '', role = 'normal') {
  const div = document.createElement('div')
  div.className = 'credrow'
  div.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center'
  div.innerHTML = `<input class="input cu" placeholder="username" value="${esc(u)}" style="flex:2">
    <input class="input cp" placeholder="password" value="${esc(p)}" style="flex:2">
    <select class="select cr" style="flex:1">
      <option value="admin"${role === 'admin' ? ' selected' : ''}>admin</option>
      <option value="normal"${role === 'normal' ? ' selected' : ''}>normal</option>
      <option value="other"${role === 'other' ? ' selected' : ''}>other</option>
    </select>
    <button type="button" class="btn sm danger cx" title="remove" style="flex:0 0 auto">✕</button>`
  div.querySelector('.cx').onclick = () => div.remove()
  return div
}
function ensureCredRows() { if (!$('#ptCreds').children.length) $('#ptCreds').appendChild(credRow()) }
if ($('#ptAddCred')) $('#ptAddCred').onclick = () => $('#ptCreds').appendChild(credRow())

// ATLAS → specialist waves → triage. Pass the squad's roster; falls back to defaults.
// Purely presentational overview diagram (.dvz-* styles live in app.css); safe to add/remove.
function squadDispatchViz(sq) {
  const SPEC_HUE = { SCOUT:'#22d3ee', VIPER:'#fb7185', DRILL:'#fbbf24',
    RELAY:'#9ba2ff', WARDEN:'#34d399', GATEWAY:'#b08cff' }
  const lead = (sq && sq.leader) || 'ATLAS'
  const specs = ((sq && sq.agents) || Object.keys(SPEC_HUE)).slice(0, 6)
  const pkts = specs.map((_, i) =>
    `<span class="pkt" style="left:${8 + i * (84 / Math.max(1, specs.length - 1))}%;animation-delay:${(i * .35).toFixed(2)}s"></span>`).join('')
  const cards = specs.map((a, i) => {
    const hue = SPEC_HUE[String(a).toUpperCase()] || '#9ba2ff'
    return `<div class="dvz-spec" style="--sp:${hue};animation-delay:${(i * .3).toFixed(2)}s"><b>${esc(a)}</b><span></span></div>`
  }).join('')
  return `<div class="dvz">
    <div class="dvz-lead-row"><div class="dvz-lead"><b>${esc(lead)}</b><span>lead · plans the attack walk</span></div></div>
    <div class="dvz-rail"><span class="down"></span><span class="flow"></span>${pkts}</div>
    <div class="dvz-specs">${cards}</div>
    <div class="dvz-triage-row"><div class="dvz-triage"><span class="dot"></span><span>every finding → validated live → your board</span></div></div>
  </div>`
}
function updateDispatchInfo() {
  const sq = SQUAD_BY[$('#fSquad').value]; if (!sq) return
  const cr = isCR(), pt = isPT()
  // code-review + pentest swap the free-text target for a structured form
  $('#crFields').style.display = cr ? 'block' : 'none'
  $('#ptFields').style.display = pt ? 'block' : 'none'
  $('#fGoalField').style.display = (cr || pt) ? 'none' : 'block'
  if (pt) ensureCredRows()
  $('#fSquadHint').textContent = cr
    ? `White-box review: ${sq.leader} discovers + consolidates; specialists map per-feature then assess per vuln-class.`
    : pt
    ? `${sq.leader} runs recon → specialists → AUDITOR verify → ARBITER judge → SCRIBE report. Scope is hard-enforced at Phase 0.`
    : `Leader ${sq.leader} coordinates ${sq.agents.length} personas through ${sq.phases.length} phases.`
  $('#dispatchInfo').innerHTML = squadDispatchViz(sq) + md(cr
    ? `**Code review (white-box, phase1-maps method)** on a local source tree.\n\n`
      + `1. **Inventories** — scripted multi-language enumeration\n2. **Feature queue** — CURATOR auto-discovers features from the surface\n`
      + `3. **Feature mapping** — one agent per feature → \`features/<slug>.md\`\n4. **Consolidation** — CURATOR → coverage matrices + review queue\n`
      + `5. **Vuln assessment** — per feature × class (access-control → MARSHAL, XSS → CIPHER)\n6. **Verify** — AUDITOR (+ PROBER if Deploy URL)\n7. **Report** — SCRIBE\n\n`
      + `Artifacts land under \`phase1-maps/\` + \`phase2/\`, viewable in **Reports**.\n\n> Stack-agnostic: works for any project (Rails, Django, Express, Spring, Laravel, Go, .NET, …); breadth scales with codebase size.`
    : pt
    ? `**Web pentest** of the target URL.\n\n`
      + `On dispatch the console writes a **scope config** (\`scope-<taskId>.json\`) and an **engagement brief** (target, scope, focus, the test-account table).\n\n`
      + `1. **Phase 0** scope hard-block (out-of-scope hosts rejected)\n2. **Recon** (SCOUT, RANGER) — auth/WAF/surface\n3. **Specialists** — per vuln class, authenticating with your test accounts\n4. **AUDITOR** verify → **ARBITER** judge → **SCRIBE** report\n\n`
      + `> **Full** tests the whole app; **Feature-driven** focuses on what you name. Each role is tested for cross-role authz (IDOR / priv-esc). Out-of-scope hosts are never touched.`
    : `Dispatching to **${sq.id}** queues a task for **${sq.leader}**.\n\nThe daemon picks it up within seconds and runs the pipeline:\n\n`
      + sq.phases.map((p, i) => `${i + 1}. **${p}**`).join('\n')
      + `\n\nLive status, per-agent cost and model routing appear under **Tasks**. The final report lands under **Reports**.\n\n> Dispatch & cancel flow through the daemon's inbox — the console never writes core state directly.`)
}
$('#fSquad').addEventListener('change', updateDispatchInfo)
$$('#fPriority button').forEach(b => b.onclick = () => { $$('#fPriority button').forEach(x => x.classList.remove('on')); b.classList.add('on') })
$$('#ptType button').forEach(b => b.onclick = () => { $$('#ptType button').forEach(x => x.classList.remove('on')); b.classList.add('on'); $('#ptFocusField').style.display = b.dataset.v === 'feature' ? 'block' : 'none' })
// focus-class chips: multi-select toggle (none on = full A→Z). The "Custom /
// abuse-driven" chip (data-custom) reveals the free-text box instead of being a class.
$$('#ptFocusClasses button').forEach(b => b.onclick = () => {
  b.classList.toggle('on')
  if (b.dataset.custom) { $('#ptCustomFocusWrap').style.display = b.classList.contains('on') ? 'block' : 'none'; if (b.classList.contains('on')) $('#ptCustomFocus').focus() }
})
// ── test-type mode: Black-box / Static Analysis / White-box → reshape the form ──
//   black-box      = live target only
//   static (analysis) = source code review only (no live testing; URL optional)
//   white-box      = source review + live pentest together (URL required + source)
function applyPtMode(mode) {
  const stat = mode === 'static', wb = mode === 'whitebox', bb = mode === 'blackbox'
  $('#ptSourceGroup').style.display = (stat || wb) ? 'block' : 'none'   // source needed for static + white-box
  $('#ptBlackGroup').style.display = (bb || wb) ? 'block' : 'none'      // live scope for black-box + white-box
  // Vulnerability-focus picker is disabled — never re-show #ptStrategyField (stays hidden; every scan is full A→Z).
  $('#ptUrlReq').style.display = stat ? 'none' : 'inline'              // URL optional only in Static Analysis
  $('#ptUrlLabel').firstChild.nodeValue = stat ? 'Deployed URL ' : 'Web application URL '
  $('#ptUrlHint').textContent = stat
    ? 'Optional — if the source is deployed, agents runtime-validate the source findings against this live URL.'
    : 'The primary live target. Its host is auto-added to in-scope.'
}
$$('#ptMode button').forEach(b => b.onclick = () => { $$('#ptMode button').forEach(x => x.classList.remove('on')); b.classList.add('on'); applyPtMode(b.dataset.v) })
if ($('#ptMode')) applyPtMode('blackbox')

/* ── dispatch ── */
$('#fSubmit').onclick = async () => {
  const squad = $('#fSquad').value
  let body
  if (isCR()) {
    const sourceDir = $('#crSourceDir').value.trim()
    if (!sourceDir) { toast('Source directory required', 'Absolute path to the source tree', 'err'); $('#crSourceDir').focus(); return }
    const vulnClasses = $$('#crClasses input:checked').map(c => c.value)
    const meta = { sourceDir }
    if (vulnClasses.length) meta.vulnClasses = vulnClasses
    const dep = $('#crDeployUrl').value.trim(); if (dep) meta.deployUrl = dep
    const mf = +$('#crMaxFeatures').value; if (mf > 0) meta.maxFeatures = mf
    const mp = +$('#crMaxPhase2').value; if (mp > 0) meta.maxPhase2 = mp
    body = { squad, taskTitle: $('#fTitle').value.trim() || undefined, priority: ($('#fPriority button.on') || {}).dataset?.v || 'normal', meta }
  } else if (isPT()) {
    const mode = ($('#ptMode button.on') || {}).dataset?.v || 'blackbox'
    const targetUrl = $('#ptUrl').value.trim()
    const sourceDir = $('#ptSourceDir').value.trim()
    const prio = ($('#fPriority button.on') || {}).dataset?.v || 'normal'
    const title = $('#fTitle').value.trim() || undefined
    const credentials = $$('#ptCreds .credrow').map(r => ({
      username: r.querySelector('.cu').value.trim(), password: r.querySelector('.cp').value, role: r.querySelector('.cr').value,
    })).filter(c => c.username)

    if (mode === 'static') {
      // Static Analysis → source-only code-review squad; URL (if given) becomes the runtime-validation target
      if (!sourceDir) { toast('Source directory required', 'Absolute path to the source tree', 'err'); $('#ptSourceDir').focus(); return }
      const meta = { sourceDir }   // stack auto-detected by the code-review engine (stack-agnostic)
      if (targetUrl) meta.deployUrl = targetUrl
      if (credentials.length) meta.testAccounts = { attacker: credentials[0], ...(credentials[1] ? { victim: credentials[1] } : {}) }
      body = { squad: 'code-review', taskTitle: title, priority: prio, meta }
    } else {
      // black-box OR white-box → live pentest (white-box also runs a source-review iteration)
      if (!targetUrl) { toast('Target URL required', 'e.g. https://app.example.com', 'err'); $('#ptUrl').focus(); return }
      const testType = ($('#ptType button.on') || {}).dataset?.v || 'full'
      const featureFocus = $('#ptFocus').value.trim()
      if (testType === 'feature' && !featureFocus) { toast('Focus required', 'Name the features to focus on', 'err'); $('#ptFocus').focus(); return }
      const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean)
      // Vulnerability-focus picker disabled — always run the full A→Z scan (no class narrowing).
      const meta = { targetUrl, testType, inScope: lines('#ptInScope'), outOfScope: lines('#ptOutScope'), credentials, skipRecon: false, focusClasses: [] }
      if (testType === 'feature') meta.featureFocus = featureFocus
      if (mode === 'whitebox') {
        if (!sourceDir) { toast('Source directory required', 'White-box needs a live URL and a source directory', 'err'); $('#ptSourceDir').focus(); return }
        meta.sourceDir = sourceDir   // stack auto-detected (stack-agnostic)
      }
      body = { squad: 'pentest', taskTitle: title, priority: prio, meta }
    }
  } else {
    const goal = $('#fGoal').value.trim()
    if (!goal) { toast('Goal required', 'Describe the target or task', 'err'); $('#fGoal').focus(); return }
    body = { squad, goal, taskTitle: $('#fTitle').value.trim() || goal.slice(0, 80), priority: ($('#fPriority button.on') || {}).dataset?.v || 'normal', model: $('#fModel').value || undefined }
  }
  $('#fSubmit').disabled = true
  const r = await api('POST', '/api/dispatch', body)
  $('#fSubmit').disabled = false
  if (r && !r.error) { toast('Dispatched ✓', `${r.assignee} · ${r.taskId}`, 'ok'); $('#fGoal').value = ''; $('#fTitle').value = ''; $('#crSourceDir').value = ''; $('#ptSourceDir').value = ''; $('#ptCustomFocus').value = ''; const cc = $('#ptCustomChip'); if (cc) cc.classList.remove('on'); $('#ptCustomFocusWrap').style.display = 'none'; $$('#ptMode button').forEach(x => x.classList.toggle('on', x.dataset.v === 'blackbox')); applyPtMode('blackbox'); show('tasks'); tick() }
  else toast('Dispatch failed', r && r.error, 'err')
}

/* ── api + polling ── */
async function api(method, url, body) {
  try { return await (await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json() }
  catch (e) { return { error: String(e.message || e) } }
}
// Live-validate a source directory as it is typed (the daemon reads the tree straight off local
// disk, so a wrong or non-absolute path fails the run). Shows a green readable line or a red error.
function wireSourceCheck(inputId, hintId) {
  const inp = document.getElementById(inputId), hint = document.getElementById(hintId)
  if (!inp || !hint) return
  let t
  const run = async () => {
    const dir = inp.value.trim()
    if (!dir) { hint.textContent = ''; hint.className = 'hint scheck'; inp.classList.remove('src-ok', 'src-bad'); return }
    const r = await api('GET', '/api/check-source?dir=' + encodeURIComponent(dir))
    if (r && r.ok) { hint.textContent = `✓ readable · ${r.entries} entries`; hint.className = 'hint scheck ok'; inp.classList.add('src-ok'); inp.classList.remove('src-bad') }
    else { hint.textContent = `✗ ${r && r.error || 'invalid path'}`; hint.className = 'hint scheck bad'; inp.classList.add('src-bad'); inp.classList.remove('src-ok') }
  }
  inp.addEventListener('blur', run)
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 700) })
}
wireSourceCheck('crSourceDir', 'crSourceCheck')
wireSourceCheck('ptSourceDir', 'ptSourceCheck')
async function tick() { const s = await api('GET', '/api/state'); if (s && !s.error) render(s); if (currentView === 'overview') renderHealth() }
// System Health card — the Operational Supervisor's latest snapshot
async function renderHealth() {
  const el = $('#ovHealth'); if (!el) return
  const h = await api('GET', '/api/health'); if (!h || h.error) { el.innerHTML = '<div class="empty">health unavailable</div>'; return }
  if (h.ok === null) { el.innerHTML = `<div class="empty">${esc(h.note || 'supervisor starting…')}</div>`; return }
  const pill = (ok) => `<span class="hstat ${ok ? 'ok' : 'warn'}">${ok ? '✓' : '⚠'}</span>`
  const rows = (h.checks || []).map(c => `<div class="hrow">${pill(c.ok)}<span class="hk">${esc(c.name.replace(/_/g, ' '))}</span><span class="hv ${c.ok ? '' : 'dim'}">${esc(c.detail || '')}${c.autoFixed ? ' <span class="hfix">auto-fixed</span>' : ''}</span></div>`).join('')
  const q = h.queue || {}, t = h.tasks || {}
  const meta = `<div class="hmeta">queue ${q.pending || 0} pending · ${q.processing || 0} processing${q.stuckProcessing ? ` · <span class="warn">${q.stuckProcessing} stuck</span>` : ''} &nbsp;|&nbsp; ${t.inProgress || 0} in-progress · ${t.liveAgents || 0} live agents${t.zombie ? ` · <span class="warn">${t.zombie} zombie</span>` : ''} &nbsp;|&nbsp; uptime ${h.daemonUptimeS != null ? Math.round(h.daemonUptimeS / 60) + 'm' : '—'}</div>`
  const fixes = (h.recentFixes || []).length ? `<div class="hfixes">recent: ${h.recentFixes.map(f => esc(f)).join(' · ')}</div>` : ''
  const sent = h.sentinel ? `<div class="hsent">🩺 SENTINEL: ${esc(h.sentinel.diagnosis || '')}${h.sentinel.fix ? ` — fix: ${esc(h.sentinel.fix)}` : ''}</div>` : ''
  $('#healthSub').textContent = h.ok ? 'all systems healthy · every 10s' : 'anomaly detected · every 10s'
  $('#healthSub').className = 'sub ' + (h.ok ? '' : 'warn')
  el.innerHTML = `<div class="hbanner ${h.ok ? 'ok' : 'warn'}">${h.ok ? '✓ All operational invariants healthy' : '⚠ Anomaly — see below'}</div>${rows}${meta}${fixes}${sent}`
}
async function boot() {
  const r = await api('GET', '/api/squads')
  SQUADS = (r && r.squads) || []
  SQUAD_BY = Object.fromEntries(SQUADS.map(s => [s.id, s]))
  renderSquads(); await tick(); setInterval(tick, 2500)
}
boot()
