# Kurukshetra Console — Design System

A cinematic dark "command-center" design language: deep cosmic-navy canvas, frosted
glass panels, a saffron brand thread with cyan/magenta/violet data hues. Styling is a
**utility-class + CSS-variable** system (plain CSS, no framework). `styles.css` is the
single source of truth — read it before styling; every class and token below exists there.

## Setup

Designs render on a **dark canvas**. Set `background: var(--bg)` (#060912) and load three
fonts: **Inter** (body/UI), **Space Grotesk** (display headings), **JetBrains Mono** (data,
ids, cost). There is no JS dependency and no provider/wrapper to mount — apply classes
directly to markup. The animated `.aurora` + `.grain` layers are optional page decoration.

## Styling idiom — class vocabulary

Compose with these real classes (don't invent new ones):

| Family | Classes |
|---|---|
| Buttons | `.btn` + `.primary` `.ghost` `.danger` `.sm` (saffron gradient = `.primary`) |
| Badges | `.badge` + `.squad` (saffron) · status `.s-in-progress` `.s-completed` `.s-failed` `.s-pending` `.s-cancelled` |
| Panels | `.card` · `.panel` (glass, blurred, gradient hairline border) |
| Stat tiles | `.stat` + accent `.acc` `.ok` `.cyan` `.violet` `.mag`; inner `.n` (number) `.l` (label) `.ic` (icon) |
| Task card | `.task` (+ `.running` glow); `.title` `.id` `.who` `.kv` (+ `.cost`) |
| Squad card | `.squad` > `.banner` (`.name`) + `.body` > `.lead` `.type` `.chips` > `.chip`; set `style="--sq:<hue>"` for the banner color |
| Phase stepper | `.stepper` > `.step` (+ `.done` `.active`) — animated progress rail |
| Progress ring | `.ring` (SVG; uses `#ringGrad` gradient def) with `.pct` overlay |
| Avatars | `.av` (colored initial badge), `.avs` (overlapping stack), `.av.more` |
| Forms | `.field` (`label`, `.req`), `.input` `.select` `.textarea`, `.seg` (segmented) > `button.on` |
| Misc | `.pill` (+ `.live`), `.toast` (+ `.ok` `.err`), `.modal`/`.overlay`, `.md` (rendered markdown), `.empty`, `.skel` (shimmer) |

## Color tokens (CSS variables)

Use `var(--*)`: brand `--saffron` `--saffron-2`; data `--cyan` `--magenta` `--violet`;
semantic `--ok` `--warn` `--err`; canvas `--bg` `--bg-1` `--glass`; ink `--fg` `--fg-mut`
`--fg-dim`; radii `--r` `--r-sm`; `--shadow` `--glow`. Squads are color-keyed (pentest
magenta, stocks green, cloud cyan, network violet, code-review saffron, red-team red,
ai-security gold) — pass the hue via `--sq` on a `.squad`, or `--accent` on a `.stat`.

## Where the truth lives

Read **`styles.css`** for tokens + every component style, and each component's
`components/<group>/<Name>/<Name>.html` preview card for exact, copyable markup.

## Idiomatic snippet

```html
<div class="stat acc">
  <div class="n">7</div><div class="l">active tasks</div>
</div>
<button class="btn primary">➤ Dispatch</button>
<span class="badge s-in-progress">in-progress</span>
```
