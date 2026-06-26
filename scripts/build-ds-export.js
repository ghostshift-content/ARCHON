#!/usr/bin/env node
// Build a claude.ai/design export bundle from the ARCHON console design
// system. Off-script (the repo is a vanilla SPA, not a React component lib), so
// we emit a tokens + preview-card layout: styles.css (the real design system) +
// self-contained @dsCard preview HTML per component + a conventions README.
//
//   node scripts/build-ds-export.js   →   ./ds-bundle/
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'ds-bundle')
const CSS = fs.readFileSync(path.join(ROOT, 'ui/app.css'), 'utf-8')

function w(rel, body) {
  const f = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, body)
}

// Preview-context overrides: the real CSS hides body overflow + paints an aurora
// on the page; for a card we want the component on the dark canvas, centred.
const PREVIEW_RESET = `
  html,body{height:auto;overflow:visible}
  body{padding:32px;background:radial-gradient(900px 500px at 80% -10%,#15233a,#060912 60%);display:block}
  .demo{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
  .demo-col{display:flex;flex-direction:column;gap:14px}
  .lbl{color:#5d6b88;font:500 11px/1 "Inter",system-ui;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px}
`

function card(group, name, markup, { w: vw = 560, h: vh = 360 } = {}) {
  const html = `<!-- @dsCard group="${group}" -->
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
${CSS}
${PREVIEW_RESET}
</style>
<svg width="0" height="0" style="position:absolute"><defs>
  <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd07a"/><stop offset="1" stop-color="#f6a623"/></linearGradient>
</defs></svg>
</head><body>
${markup}
</body></html>`
  w(`components/${group}/${name}/${name}.html`, html)
  return { group, name, vw, vh }
}

// ── helpers that mirror the live app's render output ──
const av = (n, s = 28) => {
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 360
  return `<span class="av" style="background:hsl(${h} 70% 62%);width:${s}px;height:${s}px">${n.slice(0, 2).toUpperCase()}</span>`
}
const ring = (pct, color) => {
  const r = 24, c = 2 * Math.PI * r, off = c * (1 - pct / 100)
  return `<div class="ring"><svg width="56" height="56" viewBox="0 0 56 56">
    <circle class="track" cx="28" cy="28" r="${r}" fill="none" stroke-width="5"/>
    <circle class="fill" cx="28" cy="28" r="${r}" fill="none" stroke-width="5" stroke="${color}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
  </svg><span class="pct">${pct}<small style="font-size:8px">%</small></span></div>`
}
const stepper = (phases, done, active) => `<div class="stepper">${phases.map((p, i) =>
  `<div class="step ${i < done ? 'done' : (i === active ? 'active' : '')}">${p}</div>`).join('')}</div>`

const cards = []

// ── Foundations: palette + type ──
const TOKENS = [
  ['--saffron', '#f6a623', 'brand'], ['--saffron-2', '#ffd07a', 'brand hi'],
  ['--cyan', '#2fd9e8', 'data'], ['--magenta', '#ff5d8f', 'data'], ['--violet', '#9b8cff', 'data'],
  ['--ok', '#3ddc97', 'success'], ['--warn', '#f6c544', 'warning'], ['--err', '#ff6b81', 'error'],
  ['--bg', '#060912', 'canvas'], ['--fg', '#eef3fb', 'ink'], ['--fg-mut', '#9aa8c2', 'ink muted'], ['--fg-dim', '#5d6b88', 'ink dim'],
]
cards.push(card('Foundations', 'Palette', `<div class="demo-col" style="gap:20px">
  <div><div class="lbl">Color tokens</div><div class="demo">
    ${TOKENS.map(([v, hex, lbl]) => `<div class="demo-col" style="gap:6px;align-items:center;width:96px">
      <div style="width:64px;height:64px;border-radius:14px;background:${hex};box-shadow:0 6px 18px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.08)"></div>
      <div style="font:600 11px/1.3 'JetBrains Mono',monospace;color:#eef3fb;text-align:center">${v}</div>
      <div style="font:11px 'JetBrains Mono',monospace;color:#5d6b88">${hex}</div></div>`).join('')}
  </div></div>
  <div><div class="lbl">Type</div>
    <div style="font-family:'Space Grotesk';font-weight:600;font-size:28px;background:linear-gradient(120deg,#fff,#c9d6ef);-webkit-background-clip:text;background-clip:text;color:transparent">Space Grotesk — display</div>
    <div style="font-family:'Inter';font-size:15px;color:#eef3fb;margin-top:6px">Inter — body copy and UI text</div>
    <div style="font-family:'JetBrains Mono';font-size:13px;color:#9aa8c2;margin-top:6px">JetBrains Mono — data, ids, cost</div>
  </div></div>`, { w: 720, h: 420 }))

// ── Actions: buttons ──
cards.push(card('Actions', 'Button', `<div class="demo">
  <button class="btn primary">➤ Dispatch to squad</button>
  <button class="btn">Default</button>
  <button class="btn ghost">Ghost</button>
  <button class="btn danger">■ Cancel task</button>
  <button class="btn sm">Small</button>
  <button class="btn primary" disabled>Disabled</button>
</div>`, { w: 640, h: 160 }))

// ── Data: badges / status ──
cards.push(card('Data Display', 'Badge', `<div class="demo-col">
  <div><div class="lbl">Status</div><div class="demo">
    <span class="badge s-in-progress">in-progress</span>
    <span class="badge s-completed">completed</span>
    <span class="badge s-failed">failed</span>
    <span class="badge s-pending">pending</span>
    <span class="badge s-cancelled">cancelled</span></div></div>
  <div><div class="lbl">Tags</div><div class="demo">
    <span class="badge squad">pentest</span>
    <span class="badge squad">stocks</span>
    <span class="badge">Phase 2: synthesizing</span></div></div>
</div>`, { w: 600, h: 220 }))

// ── Data: avatars ──
cards.push(card('Data Display', 'Avatar', `<div class="demo-col">
  <div><div class="lbl">Persona avatars (deterministic color)</div>
    <div class="demo">${['ATLAS', 'CHANAKYA', 'NARAD', 'SURYA', 'AUDITOR', 'SCRIBE'].map(n => av(n, 40)).join('')}</div></div>
  <div><div class="lbl">Stack</div>
    <div class="avs">${['NARAD', 'SURYA', 'LAKSHMI', 'VAYU', 'analyst'].map(n => av(n)).join('')}<span class="av more">+3</span></div></div>
</div>`, { w: 560, h: 220 }))

// ── Data: stat tiles ──
const ICONS = { bolt: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>', check: '<path d="M20 6L9 17l-5-5"/>', coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h4a2 2 0 010 4H9"/>' }
cards.push(card('Data Display', 'StatTile', `<div class="stats" style="max-width:760px">
  <div class="stat acc"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS.bolt}</svg></span><div class="n">1</div><div class="l">active tasks</div></div>
  <div class="stat ok"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS.check}</svg></span><div class="n">7</div><div class="l">completed</div></div>
  <div class="stat mag"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS.coin}</svg></span><div class="n">$2.65</div><div class="l">total spend</div></div>
</div>`, { w: 760, h: 200 }))

// ── Data: progress ring ──
cards.push(card('Data Display', 'ProgressRing', `<div class="demo" style="align-items:center">
  ${ring(25, '#ff5d8f')} ${ring(60, '#3ddc97')} ${ring(90, '#2fd9e8')} ${ring(100, 'url(#ringGrad)')}
</div>`, { w: 480, h: 160 }))

// ── Data: phase stepper ──
cards.push(card('Data Display', 'PhaseStepper', `<div style="max-width:520px">
  ${stepper(['research', 'analyze', 'challenge', 'synthesize', 'report', 'verify'], 2, 2)}
</div>`, { w: 600, h: 130 }))

// ── Components: task card (readout-led redesign) ──
cards.push(card('Components', 'TaskCard', `<div style="max-width:480px"><div class="tcard" style="--c:#3ddc97">
  <div class="pad">
    <div class="thead">
      <div class="readout"><span class="val">45</span><span class="pc">%</span></div>
      <div class="hstatus"><span class="runtag"><span class="dot"></span>Running</span><span class="badge s-in-progress">in-progress</span></div>
    </div>
    <div class="pbar"><div class="pfill" style="width:45%"></div></div>
    <div class="ticks"><span>Phase 3 of 6</span><span>CHANAKYA synthesizing</span></div>
    <div class="ttl">Analyse TCS — Q3 fundamentals</div>
    <div class="tid">t-1781669666367-012f</div>
    <div class="row"><span class="badge squad">stocks</span><span class="badge">analysis</span></div>
    ${stepper(['research', 'analyze', 'challenge', 'synthesize', 'report', 'verify'], 2, 2)}
    <div style="margin-top:13px"><div class="avs">${['NARAD', 'SURYA', 'LAKSHMI', 'VAYU', 'analyst'].map(n => av(n)).join('')}<span class="av more">+2</span></div></div>
    <div class="sep-line"></div>
    <div class="footgrid">
      <div class="metric"><span class="mk">cost</span><span class="mv cost">$0.95</span></div>
      <div class="metric"><span class="mk">cache</span><span class="mv">99%</span></div>
      <div class="metric"><span class="mk">output</span><span class="mv">10,084</span></div>
      <button class="btn danger sm" style="margin-left:auto;align-self:center">■ Cancel</button>
    </div>
  </div>
</div></div>`, { w: 520, h: 480 }))

// ── Components: squad card ──
cards.push(card('Components', 'SquadCard', `<div style="max-width:320px"><div class="squad" style="--sq:#ff5d8f">
  <div class="banner"><span class="name">pentest</span></div>
  <div class="body">
    <div class="lead">${av('ATLAS', 26)} <b>ATLAS</b><span style="color:#5d6b88;font-size:11px">leads</span></div>
    <div class="type">security-testing · budget $50 · 16 personas</div>
    ${stepper(['recon', 'exploit', 'validate', 'chain', 'report', 'verify'], 0, -1)}
    <div class="chips">${['SCOUT', 'RANGER', 'RELAY', 'VIPER', 'DRILL', 'GATEWAY', 'WARDEN'].map(a => `<span class="chip">${a}</span>`).join('')}</div>
  </div>
</div></div>`, { w: 380, h: 360 }))

// ── Forms ──
cards.push(card('Forms', 'FormControls', `<div style="max-width:420px">
  <div class="field"><label>Squad <span class="req">*</span></label>
    <select class="select"><option>pentest — leader ATLAS</option></select></div>
  <div class="field"><label>Goal / target <span class="req">*</span></label>
    <textarea class="textarea" placeholder="In-scope target, e.g. *.example.com"></textarea></div>
  <div class="row2">
    <div class="field"><label>Priority</label>
      <div class="seg"><button>Low</button><button class="on">Normal</button><button>High</button></div></div>
    <div class="field"><label>Model</label><select class="select"><option>auto (router decides)</option></select></div>
  </div>
  <button class="btn primary">➤ Dispatch to squad</button>
</div>`, { w: 480, h: 460 }))

// ── styles.css (the design-language closure designs receive) ──
w('styles.css', `/* ARCHON console — design system tokens + component styles.
   The single source of truth for the visual language. Imported by every preview
   card; the design agent reads this for tokens + class vocabulary. */
${CSS}`)

// ── README (conventions header for the design agent) ──
w('README.md', fs.readFileSync(path.join(ROOT, '.design-sync/conventions.md'), 'utf-8'))

// ── card manifest (also encoded in each card's @dsCard first line) ──
w('_ds_manifest.json', JSON.stringify({ cards }, null, 2))

console.log(`Built ${cards.length} preview cards → ds-bundle/`)
cards.forEach(c => console.log(`  ${c.group}/${c.name}`))
