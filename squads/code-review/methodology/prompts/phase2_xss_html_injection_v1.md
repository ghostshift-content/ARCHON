# Phase 2 — Deep XSS / HTML-Injection Vulnerability Review

## Purpose

This prompt is for **Phase 2 XSS-focused security vulnerability review**.

The goal is to identify:

- Stored XSS / SXSS
- Reflected XSS / RXSS
- DOM XSS
- HTML injection
- Client-side template injection that creates XSS
- Sanitizer bypasses
- Unsafe rendering of user-controlled HTML
- Unsafe rendering of markdown, rich text, SVG, artifacts, diffs, logs, emails, notifications, or generated previews

This prompt is separate from the access-control Phase 2 prompt.

Use this prompt when the review objective is XSS / HTML injection, not general access control.

---

# Execution Contract — No Autonomous Deviation

The agent must follow this prompt exactly.

The agent must not invent a different workflow, skip required gates, redefine completion, or decide to perform a different type of review.

## Scope Control Rule

Allowed work:

- Reviewing local GitLab source code for XSS / HTML injection vulnerabilities
- Consuming existing Phase 1 feature maps if available
- Reconstructing missing inventories from source code
- Reviewing Web, REST, GraphQL, frontend, workers, services, serializers, views, helpers, renderers, markdown pipelines, and generated-content paths
- Applying the canonical XSS pattern catalog in this prompt
- Reporting confirmed, potential, or suspicious XSS / HTML-injection findings
- Producing required coverage ledgers and matrices
- Assigning CVSS to each confirmed/potential/suspicious finding

Not allowed unless explicitly requested:

- General access-control review
- Dependency/CVE review unrelated to XSS sinks/sanitizers/rendering
- Secret scanning
- Performance review
- Refactoring suggestions
- Generic hardening notes as findings
- Open-ended exploration outside the source-code surfaces required by this prompt
- Replacing required matrices with prose summaries
- Reporting safe paths as findings

## No Shortcut Rule

The agent must not say:

- “This feature is probably safe.”
- “This view uses escaping by default, so no need to trace.”
- “This API is JSON-only, so no XSS risk.”
- “This field is sanitized somewhere else, so no need to verify.”
- “This is internal/admin-only, so XSS does not matter.”
- “This is only HTML injection, so it is not security relevant.”
- “This is mapped in Phase 1, so no need to read the source.”
- “Only stored XSS matters.”
- “Only Rails views matter.”
- “Only frontend code matters.”

Any such reasoning is invalid.

## Evidence Rule

Every claim must be backed by exact source-code evidence:

- file path
- class/module/component
- method/function
- route/API/mutation/resolver/worker
- user-controlled source
- sanitization/escaping function
- rendering sink
- context of rendering
- reason why the path is safe or vulnerable

If evidence is incomplete, mark the item as a gap or potential/suspicious finding. Do not guess.

---

# Strict Mode When Phase 1 Was Already Run

Sometimes Phase 1 has already been run and Phase 2 starts from existing Phase 1 feature-map files.

Existing Phase 1 output is not proof of XSS review.

Existing Phase 1 output is only input material.

## Required Inputs From Existing Phase 1

Load every available Phase 1 artifact:

- feature map files
- endpoint/action ledgers
- file coverage lists
- Web route lists
- REST API lists
- GraphQL query/mutation/resolver lists
- frontend/component lists
- serializer/entity/type lists
- data exposure maps
- worker maps
- same-functionality maps
- gap/follow-up lists
- unmapped file lists
- assumptions

Do not run Phase 2 from only a summary.

## If Existing Phase 1 Is Incomplete

If Phase 1 lacks any required XSS-relevant surface, reconstruct it from source code before reviewing findings:

- views/templates
- helpers
- presenters
- serializers/entities
- frontend components
- markdown/rich-text renderers
- API/GraphQL responses consumed by frontend
- email/notification templates
- artifact/log/blob/wiki/snippet renderers
- search/highlight renderers
- import/export/generated HTML paths

## Existing Phase 1 Does Not Reduce Pattern Coverage

Even when Phase 1 already exists, Phase 2 must still apply the full canonical XSS pattern catalog to every feature.

Do not apply only the patterns mentioned in Phase 1.

Do not skip patterns because the Phase 1 output looks deep.

Do not review only endpoints marked high priority.

Do not review only fields already marked suspicious.

---

# Source-of-Truth XSS Inventory

Before reviewing vulnerabilities, build or load a source-of-truth inventory for XSS-relevant code.

## Required Inventories

### 1. Web Routes / Controllers / Views

Inventory:

- Rails routes
- controllers/actions
- before_actions that load objects
- views/templates
- partials
- helpers
- presenters
- decorators
- JSON/HTML dual-response actions
- flash/error/redirect message rendering
- preview endpoints

Search examples:

```bash
grep -RIn "render\|redirect_to\|flash\|respond_to\|format.html\|format.json" app/controllers ee/app/controllers
find app/views ee/app/views -type f
grep -RIn "raw\|html_safe\|safe_join\|sanitize\|simple_format\|link_to\|content_tag\|tag\." app/helpers ee/app/helpers app/views ee/app/views
```

### 2. REST API / Grape Responses

Inventory:

- REST endpoints
- entities
- presenters
- response fields
- markdown/rendered HTML fields
- error messages reflecting params
- pagination/search/highlight data

Search examples:

```bash
grep -RIn "present \|expose \|entity \|error!\|render_api_error\|params\[" lib/api ee/lib/api app/entities ee/app/entities
```

### 3. GraphQL Responses

Inventory:

- queries
- mutations
- resolvers
- types
- fields
- markdown/rendered HTML fields
- error fields
- user-controlled data returned to clients

Search examples:

```bash
find app/graphql ee/app/graphql -type f
grep -RIn "field \|mutation\|resolver\|resolve\|authorize\|markdown\|html\|description\|title\|name" app/graphql ee/app/graphql
```

### 4. Frontend / Client-Side Rendering

Inventory:

- Vue components
- React components
- JavaScript/TypeScript files
- template interpolation
- `v-html`
- `innerHTML`
- `outerHTML`
- `insertAdjacentHTML`
- jQuery `.html()`
- DOMPurify/sanitize calls
- markdown preview rendering
- client-side route/query param rendering
- GraphQL/API response rendering

Search examples:

```bash
grep -RIn "v-html\|innerHTML\|outerHTML\|insertAdjacentHTML\|dangerouslySetInnerHTML\|\.html(\|DOMPurify\|sanitize\|escape" app/assets app/javascript ee/app/assets ee/app/javascript
```

### 5. Markdown / Rich Text / HTML Pipeline

Inventory:

- markdown renderers
- Banzai filters
- sanitizers
- linkifiers
- reference filters
- emoji filters
- math/diagram renderers
- Mermaid/PlantUML/KaTeX renderers
- HTML allowlists
- cached rendered markdown

Search examples:

```bash
grep -RIn "Banzai\|Markdown\|HtmlPipeline\|sanitize\|allowlist\|whitelist\|filter\|render.*html\|markdown" app ee lib
```

### 6. File / Blob / Diff / Artifact / Log Rendering

Inventory:

- repository blob renderers
- diff renderers
- job logs
- artifacts browser
- package metadata rendering
- wiki pages
- snippets
- uploads
- SVG/HTML preview
- content-type handling
- inline vs attachment disposition

Search examples:

```bash
grep -RIn "blob\|diff\|artifact\|trace\|log\|snippet\|wiki\|upload\|content_type\|disposition\|send_file\|send_data" app ee lib
```

### 7. Email / Notification / Webhook / Integration Rendering

Inventory:

- mailer templates
- notification templates
- webhook payloads rendered in UI
- integration messages
- system notes
- audit/event messages displayed in UI

Search examples:

```bash
find app/views ee/app/views -path "*mailer*" -o -path "*emails*"
grep -RIn "mail\|notification\|webhook\|system_note\|event\|audit" app ee lib
```

### 8. Search / Highlight / Autocomplete Rendering

Inventory:

- search result snippets
- highlight rendering
- autocomplete labels
- mentions
- references
- quick search
- project/group/user search
- issue/MR/epic/work item search

Search examples:

```bash
grep -RIn "highlight\|autocomplete\|search\|snippet\|suggestion\|mention\|reference" app ee lib
```

---

# Phase 2 Reverse-Check Gate — Every Phase 1 Row Must Be Tested

Phase 2 must reverse-check every XSS-relevant endpoint, action, mutation, resolver, worker, serializer, view, component, renderer, and shared-service row produced by Phase 1.

For every Phase 1 row:

- there must be exactly one matching Phase 2 review row, or
- the row must be explicitly merged into another Phase 2 row with an exact reference and reason.

If a Phase 1 row has no Phase 2 row, Phase 2 is incomplete.

## Required Disposition for Every Row

Every row must receive one disposition:

| Disposition | Meaning |
|---|---|
| Deep reviewed — no XSS/HTML injection issue found | Full source-to-sink path reviewed |
| Confirmed vulnerability | Source-confirmed vulnerable path |
| Potential vulnerability | Strong candidate requiring dynamic validation |
| Suspicious vulnerable-looking path | Concrete suspicious path requiring deeper follow-up |
| Duplicate / covered by another reviewed row | Exact referenced row required |
| Not XSS-relevant | Evidence-backed reason required |
| Dead / unreachable code | Evidence-backed reason required |
| Gap / blocker | Could not complete; incomplete coverage |

No row may be left without a disposition.

---

# Full Feature-Code Sweep Gate

For each feature, Phase 2 must read the full XSS-relevant code surface.

This includes:

- Web routes/controllers/views/helpers
- REST API/entities/presenters
- GraphQL queries/mutations/resolvers/types
- frontend components and JavaScript
- markdown/rich text renderers
- sanitizers and escaping helpers
- file/blob/diff/artifact/log renderers
- emails/notifications/system notes
- search/highlight/autocomplete/mention rendering
- services/finders/models that prepare rendered content
- workers that generate cached rendered content
- shared infrastructure used by the feature

Do not stop at route declarations.

Do not stop at the first escaping function.

Do not stop because Rails escapes by default.

Do not stop because GraphQL/API is “data only.”

Do not stop because content is “already sanitized” unless the exact sanitizer and render context are verified.

---

# Canonical XSS / HTML-Injection Pattern Catalog

Phase 2 must apply the full canonical XSS pattern catalog below.

Do not apply only selected patterns.

Do not rename, redefine, or renumber patterns.

Every feature must include a full pattern matrix with each pattern exactly once.

Each pattern must be marked:

- Applied — finding
- Applied — potential/suspicious
- Applied — no issue found
- Not applicable — with evidence-backed reason
- Gap/blocker — could not complete

## Canonical Pattern IDs

| Pattern ID | Canonical Name |
|---|---|
| XSS-01 | Stored user-controlled HTML rendered without escaping |
| XSS-02 | Reflected parameter rendered into HTML response |
| XSS-03 | HTML injection without script execution but with DOM/security impact |
| XSS-04 | Attribute-context injection |
| XSS-05 | URL-context injection in href, src, action, formaction, or redirects |
| XSS-06 | JavaScript string/template/context injection |
| XSS-07 | JSON embedded in script or inline JS without safe escaping |
| XSS-08 | CSS/style-context injection |
| XSS-09 | Markdown/rich-text sanitizer bypass |
| XSS-10 | Sanitizer allowlist too broad or dangerous tags/attributes allowed |
| XSS-11 | raw/html_safe/safe_join or equivalent unsafe server-side rendering |
| XSS-12 | Sanitization performed before later unsafe mutation/concatenation |
| XSS-13 | Double decoding, entity decoding, or canonicalization mismatch |
| XSS-14 | DOM sink injection via innerHTML, outerHTML, insertAdjacentHTML, or jQuery html |
| XSS-15 | Vue/Angular/template raw HTML rendering such as v-html |
| XSS-16 | React dangerouslySetInnerHTML or equivalent unsafe component sink |
| XSS-17 | ERB/Haml/Slim unescaped output or unsafe interpolation |
| XSS-18 | API/GraphQL field trusted by frontend and rendered as HTML |
| XSS-19 | Server returns rendered HTML fragments consumed by frontend without re-sanitization |
| XSS-20 | Email/notification/system-note HTML injection |
| XSS-21 | File upload, attachment, SVG, HTML, or MIME/content-type inline rendering |
| XSS-22 | SVG/MathML/foreignObject sanitizer bypass |
| XSS-23 | Linkification/autolink/reference parser creates unsafe HTML or URL |
| XSS-24 | Issue/MR/work item/epic description/comment/title rendering |
| XSS-25 | Wiki/snippet/project page/blob/diff rendering |
| XSS-26 | User/group/project/namespace/label/milestone/environment/runner name rendering |
| XSS-27 | Search result, autocomplete, or highlight HTML injection |
| XSS-28 | Job log, pipeline trace, artifact browser, package metadata, or deployment output rendering |
| XSS-29 | Import/export/replay/migration path stores unsafe content later rendered |
| XSS-30 | Cached sanitized/rendered HTML reused across unsafe context or stale sanitizer version |
| XSS-31 | Admin/maintainer-only stored input later viewed by other users or higher-value victims |
| XSS-32 | CSP bypass, nonce misuse, unsafe inline script allowance, or missing sandbox |
| XSS-33 | Iframe/embed/sandbox escape or unsafe preview mode |
| XSS-34 | Content sniffing, wrong content type, inline disposition, or download/open rendering issue |
| XSS-35 | Flash/error/validation message reflects unsafe user input |
| XSS-36 | I18n/localization interpolation marked HTML-safe |
| XSS-37 | Query/filter/sort/page parameter reflected into UI |
| XSS-38 | Form validation errors or model errors include raw params |
| XSS-39 | WYSIWYG/editor/preview path differs from final render path |
| XSS-40 | Mentions/references/quick actions/autocomplete produce unsafe HTML |
| XSS-41 | Cross-context escaping mismatch between HTML, attribute, JS, JSON, CSS, URL |
| XSS-42 | Frontend state hydration or data attributes contain unsafe serialized data |
| XSS-43 | GraphQL error/message/path data rendered unsafely |
| XSS-44 | Webhook/integration/external service data rendered in GitLab UI |
| XSS-45 | Sanitizer/filter order bug in HTML pipeline |
| XSS-46 | User-controlled protocol scheme bypass such as javascript:, data:, vbscript:, or encoded variants |
| XSS-47 | Unicode, null-byte, control-character, or browser parser differential bypass |
| XSS-48 | HTML injection enabling phishing, UI spoofing, or credential capture even without script |
| XSS-49 | Stored content crosses privilege boundary from low-privileged author to high-privileged viewer |
| XSS-50 | Same functionality rendered differently across Web, REST, GraphQL, mobile, email, or preview |

## Required Full Pattern Matrix

Every feature review must include:

| Pattern | Canonical Name | Applied To Code Surface | Result | Finding / Reference | Evidence | Gap / N/A Reason |
|---|---|---|---|---|---|---|
| XSS-01 | Stored user-controlled HTML rendered without escaping | TBD | TBD | TBD | TBD | TBD |
| XSS-02 | Reflected parameter rendered into HTML response | TBD | TBD | TBD | TBD | TBD |
| XSS-03 | HTML injection without script execution but with DOM/security impact | TBD | TBD | TBD | TBD | TBD |
| XSS-04 | Attribute-context injection | TBD | TBD | TBD | TBD | TBD |
| XSS-05 | URL-context injection in href, src, action, formaction, or redirects | TBD | TBD | TBD | TBD | TBD |
| XSS-06 | JavaScript string/template/context injection | TBD | TBD | TBD | TBD | TBD |
| XSS-07 | JSON embedded in script or inline JS without safe escaping | TBD | TBD | TBD | TBD | TBD |
| XSS-08 | CSS/style-context injection | TBD | TBD | TBD | TBD | TBD |
| XSS-09 | Markdown/rich-text sanitizer bypass | TBD | TBD | TBD | TBD | TBD |
| XSS-10 | Sanitizer allowlist too broad or dangerous tags/attributes allowed | TBD | TBD | TBD | TBD | TBD |
| XSS-11 | raw/html_safe/safe_join or equivalent unsafe server-side rendering | TBD | TBD | TBD | TBD | TBD |
| XSS-12 | Sanitization performed before later unsafe mutation/concatenation | TBD | TBD | TBD | TBD | TBD |
| XSS-13 | Double decoding, entity decoding, or canonicalization mismatch | TBD | TBD | TBD | TBD | TBD |
| XSS-14 | DOM sink injection via innerHTML, outerHTML, insertAdjacentHTML, or jQuery html | TBD | TBD | TBD | TBD | TBD |
| XSS-15 | Vue/Angular/template raw HTML rendering such as v-html | TBD | TBD | TBD | TBD | TBD |
| XSS-16 | React dangerouslySetInnerHTML or equivalent unsafe component sink | TBD | TBD | TBD | TBD | TBD |
| XSS-17 | ERB/Haml/Slim unescaped output or unsafe interpolation | TBD | TBD | TBD | TBD | TBD |
| XSS-18 | API/GraphQL field trusted by frontend and rendered as HTML | TBD | TBD | TBD | TBD | TBD |
| XSS-19 | Server returns rendered HTML fragments consumed by frontend without re-sanitization | TBD | TBD | TBD | TBD | TBD |
| XSS-20 | Email/notification/system-note HTML injection | TBD | TBD | TBD | TBD | TBD |
| XSS-21 | File upload, attachment, SVG, HTML, or MIME/content-type inline rendering | TBD | TBD | TBD | TBD | TBD |
| XSS-22 | SVG/MathML/foreignObject sanitizer bypass | TBD | TBD | TBD | TBD | TBD |
| XSS-23 | Linkification/autolink/reference parser creates unsafe HTML or URL | TBD | TBD | TBD | TBD | TBD |
| XSS-24 | Issue/MR/work item/epic description/comment/title rendering | TBD | TBD | TBD | TBD | TBD |
| XSS-25 | Wiki/snippet/project page/blob/diff rendering | TBD | TBD | TBD | TBD | TBD |
| XSS-26 | User/group/project/namespace/label/milestone/environment/runner name rendering | TBD | TBD | TBD | TBD | TBD |
| XSS-27 | Search result, autocomplete, or highlight HTML injection | TBD | TBD | TBD | TBD | TBD |
| XSS-28 | Job log, pipeline trace, artifact browser, package metadata, or deployment output rendering | TBD | TBD | TBD | TBD | TBD |
| XSS-29 | Import/export/replay/migration path stores unsafe content later rendered | TBD | TBD | TBD | TBD | TBD |
| XSS-30 | Cached sanitized/rendered HTML reused across unsafe context or stale sanitizer version | TBD | TBD | TBD | TBD | TBD |
| XSS-31 | Admin/maintainer-only stored input later viewed by other users or higher-value victims | TBD | TBD | TBD | TBD | TBD |
| XSS-32 | CSP bypass, nonce misuse, unsafe inline script allowance, or missing sandbox | TBD | TBD | TBD | TBD | TBD |
| XSS-33 | Iframe/embed/sandbox escape or unsafe preview mode | TBD | TBD | TBD | TBD | TBD |
| XSS-34 | Content sniffing, wrong content type, inline disposition, or download/open rendering issue | TBD | TBD | TBD | TBD | TBD |
| XSS-35 | Flash/error/validation message reflects unsafe user input | TBD | TBD | TBD | TBD | TBD |
| XSS-36 | I18n/localization interpolation marked HTML-safe | TBD | TBD | TBD | TBD | TBD |
| XSS-37 | Query/filter/sort/page parameter reflected into UI | TBD | TBD | TBD | TBD | TBD |
| XSS-38 | Form validation errors or model errors include raw params | TBD | TBD | TBD | TBD | TBD |
| XSS-39 | WYSIWYG/editor/preview path differs from final render path | TBD | TBD | TBD | TBD | TBD |
| XSS-40 | Mentions/references/quick actions/autocomplete produce unsafe HTML | TBD | TBD | TBD | TBD | TBD |
| XSS-41 | Cross-context escaping mismatch between HTML, attribute, JS, JSON, CSS, URL | TBD | TBD | TBD | TBD | TBD |
| XSS-42 | Frontend state hydration or data attributes contain unsafe serialized data | TBD | TBD | TBD | TBD | TBD |
| XSS-43 | GraphQL error/message/path data rendered unsafely | TBD | TBD | TBD | TBD | TBD |
| XSS-44 | Webhook/integration/external service data rendered in GitLab UI | TBD | TBD | TBD | TBD | TBD |
| XSS-45 | Sanitizer/filter order bug in HTML pipeline | TBD | TBD | TBD | TBD | TBD |
| XSS-46 | User-controlled protocol scheme bypass such as javascript:, data:, vbscript:, or encoded variants | TBD | TBD | TBD | TBD | TBD |
| XSS-47 | Unicode, null-byte, control-character, or browser parser differential bypass | TBD | TBD | TBD | TBD | TBD |
| XSS-48 | HTML injection enabling phishing, UI spoofing, or credential capture even without script | TBD | TBD | TBD | TBD | TBD |
| XSS-49 | Stored content crosses privilege boundary from low-privileged author to high-privileged viewer | TBD | TBD | TBD | TBD | TBD |
| XSS-50 | Same functionality rendered differently across Web, REST, GraphQL, mobile, email, or preview | TBD | TBD | TBD | TBD | TBD |

## Pattern Count Check

Every feature must end with:

```markdown
# XSS Pattern Count Check

- Canonical XSS patterns required: 50
- Pattern rows present: 50
- Patterns applied with finding/potential/suspicious:
- Patterns applied with no issue:
- Patterns marked not applicable with evidence:
- Patterns marked gap/blocker:
- Renamed/non-canonical patterns used: Yes/No
- Result: PASS/FAIL

If pattern rows present is not 50, the feature review is incomplete.
If renamed/non-canonical patterns were used, the feature review is incomplete.
```

---

# Source-to-Sink Trace Requirement

For every possible finding, build a full source-to-sink trace.

```markdown
## Source-to-Sink Trace

| Step | Code Location | Evidence |
|---|---|---|
| User-controlled source | file:line / method | TBD |
| Storage or transit | file:line / method | TBD |
| Transformation | file:line / method | TBD |
| Sanitization / escaping | file:line / method | TBD |
| Rendering sink | file:line / method | TBD |
| Browser context | HTML / attribute / JS / JSON / CSS / URL / DOM / email / markdown / SVG | TBD |
| Victim viewer | anonymous / authenticated / project member / maintainer / admin | TBD |
| Exploitability condition | stored / reflected / DOM / HTML injection | TBD |
```

A finding cannot be reported without a concrete source, sink, and browser context.

---

# XSS Finding Reporting Gate

Report only:

1. Confirmed XSS / HTML-injection vulnerabilities
2. Potential XSS / HTML-injection vulnerabilities requiring dynamic validation
3. Suspicious vulnerable-looking source-to-sink paths with concrete evidence

Do not report:

- safe escaping behavior
- generic hardening suggestions
- “could be dangerous” without source-to-sink evidence
- sanitizer usage without a bypass path
- user-controlled data that is never rendered
- rendered data that is safely escaped in the correct context
- issues outside XSS/HTML injection scope

## Required Finding Template

```markdown
# Finding: [Short title]

## Status

Confirmed vulnerability / Potential vulnerability / Suspicious vulnerable-looking path

## Vulnerability Type

Stored XSS / Reflected XSS / DOM XSS / HTML Injection / Sanitizer Bypass / Unsafe Rendering

## Affected Feature

- Feature:
- Entry point:
- Interface: Web / REST / GraphQL / Frontend / Email / Notification / File Preview / Markdown / Other

## Source-to-Sink Trace

| Step | Code Location | Evidence |
|---|---|---|
| User-controlled source | TBD | TBD |
| Storage/transit | TBD | TBD |
| Transformation | TBD | TBD |
| Sanitization/escaping | TBD | TBD |
| Rendering sink | TBD | TBD |
| Browser/rendering context | TBD | TBD |

## Attacker and Victim Model

- Attacker role:
- Victim role:
- User interaction required:
- Stored/reflected/DOM trigger:
- Scope of affected viewers:

## Impact

- Confidentiality:
- Integrity:
- Availability:
- Browser/session/token risk:
- HTML injection / phishing / UI spoofing risk if script execution is not proven:

## Evidence

- files:
- methods:
- relevant code snippets:
- why existing escaping/sanitization is insufficient:

## Dynamic Validation Plan

Use only a safe local/test environment.

- Setup:
- Input location:
- Safe canary payload:
- Expected safe behavior:
- Vulnerable behavior:
- Browser/context confirmation needed:

## CVSS Assessment

- CVSS Vector:
- CVSS Score:
- Severity:
- Score Status: Final / Provisional — source-confirmed dynamic validation pending / Provisional — suspicious path exploitability pending
- Confidence: High / Medium / Low

| Metric | Value | Reason |
|---|---|---|
| AV | N/A/L/P | TBD |
| AC | L/H | TBD |
| PR | N/L/H | TBD |
| UI | N/R | TBD |
| S | U/C | TBD |
| C | N/L/H | TBD |
| I | N/L/H | TBD |
| A | N/L/H | TBD |
```

---

# CVSS Scoring Guide for XSS / HTML Injection

Every confirmed, potential, or suspicious finding must include CVSS.

## Severity Bands

| Score Range | Severity |
|---|---|
| 0.0 | None |
| 0.1–3.9 | Low |
| 4.0–6.9 | Medium |
| 7.0–8.9 | High |
| 9.0–10.0 | Critical |

## XSS-Specific CVSS Guidance

- Most Web/API/GraphQL-triggered XSS issues are `AV:N`.
- Stored XSS usually has `AC:L` if the payload reliably triggers in normal workflow.
- Reflected XSS may be `AC:L` if a crafted URL reliably triggers, but often has `UI:R`.
- DOM XSS is usually `UI:R` unless no victim interaction is needed.
- XSS usually has `S:C` because the vulnerable component is the web application and the impacted component is the victim browser/session.
- XSS without meaningful CSP bypass may be `C:L/I:L/A:N`.
- XSS with session/token theft, account action, trusted app modification, OAuth abuse, or GitLab.com CSP bypass may justify `C:H/I:H`.
- HTML injection without script execution may still be reportable if it enables credential phishing, UI spoofing, dangerous link injection, or security decision manipulation.
- HTML injection with no security impact should not be reported as a vulnerability finding.

## Required Metric Values

| Metric | Values |
|---|---|
| AV | N / A / L / P |
| AC | L / H |
| PR | N / L / H |
| UI | N / R |
| S | U / C |
| C | N / L / H |
| I | N / L / H |
| A | N / L / H |

Do not hide scoring uncertainty. If dynamic validation can change exploitability or impact, mark CVSS as provisional.

---

# Per-Feature Completion Gate

Every feature review must end with:

```markdown
# Feature Completion Gate Result

## Endpoint / Rendering Path Coverage

- Total Phase 1 rows:
- Phase 2 reviewed rows:
- Unmatched rows:
- Result: PASS/FAIL

## File Coverage

- Total Phase 1 files:
- Additional XSS-relevant files discovered:
- Files read in Phase 2:
- Files unresolved:
- Result: PASS/FAIL

## Method / Sink Coverage

- Security-relevant methods/sinks identified:
- Methods/sinks traced:
- Methods/sinks unresolved:
- Result: PASS/FAIL

## Interface Coverage

| Interface | Exists? | Fully Reviewed? | Gaps |
|---|---|---|---|
| Web views/controllers | Yes/No | Yes/No | TBD |
| REST API/entities | Yes/No | Yes/No | TBD |
| GraphQL/resolvers/types | Yes/No | Yes/No | TBD |
| Frontend components | Yes/No | Yes/No | TBD |
| Markdown/rich text | Yes/No | Yes/No | TBD |
| File/blob/diff/artifact/log rendering | Yes/No | Yes/No | TBD |
| Email/notification/system notes | Yes/No | Yes/No | TBD |
| Search/highlight/autocomplete | Yes/No | Yes/No | TBD |
| Import/export/generated content | Yes/No | Yes/No | TBD |
| Shared sanitizers/renderers | Yes/No | Yes/No | TBD |

## XSS Pattern Count Check

- Canonical XSS patterns required: 50
- Pattern rows present: 50
- Renamed/non-canonical patterns used: Yes/No
- Result: PASS/FAIL

## Unresolved Items

List every unresolved item.

## Completion Decision

Complete / Incomplete

If incomplete, state:

> This feature is not fully reviewed for XSS/HTML injection. Additional vulnerabilities may remain in unresolved files, methods, sinks, rendering contexts, or same-functionality paths.
```

---

# Final Phase 2 XSS Report Requirements

The final report must include:

1. Executive summary
2. Features reviewed
3. Existing Phase 1 intake check if applicable
4. Source-of-truth XSS inventory
5. Endpoint/rendering path reverse-check matrix
6. Full file coverage ledger
7. Method/sink coverage ledger
8. Interface coverage matrix
9. Full 50-pattern XSS matrix per feature
10. XSS pattern count check per feature
11. Confirmed findings
12. Potential vulnerabilities requiring dynamic validation
13. Suspicious vulnerable-looking paths
14. CVSS assessment for every confirmed/potential/suspicious finding
15. Dynamic validation plan for each finding/candidate
16. Unresolved gaps/blockers
17. Features not fully reviewed
18. Final completion decision

Do not claim the XSS review is complete unless all required matrices pass.
