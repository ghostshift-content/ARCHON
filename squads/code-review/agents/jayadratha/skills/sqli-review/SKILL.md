# SQL Injection Code Review — JAYADRATHA skill

**Scope:** Classical SQLi, second-order SQLi, ORM-escape-hatch injection, stored-procedure injection, NoSQL injection, blind/boolean/time-based SQLi, JSON-operator injection, ORDER-BY / LIMIT / table-name injection.

**Priority-ranked pattern library — 14 patterns (J-0 highest, J-13 lowest).**

---

## Methodology

### Phase 1: Master the data layer
Before hunting, answer:
1. **Database engine(s)** — Postgres, MySQL, SQLite, Oracle, MSSQL, MongoDB, Redis, ElasticSearch, Neo4j. Dialect-specific injection payloads differ.
2. **ORM in use** — ActiveRecord (Rails), Sequel, Django ORM, SQLAlchemy, Knex, Prisma, TypeORM, Sequelize, Hibernate, Entity Framework, GORM.
3. **Raw-SQL surface** — grep for the ORM's escape hatches (see patterns below).
4. **Prepared statement policy** — does the ORM always parameterize? Does it refuse `?` placeholders for table/column names? Look at migrations + `find_by_sql` / `raw()` usage.
5. **Stored procedures / functions** — if app calls SPs, grep for `CALL`/`EXEC` with string concat inside the SP definitions.

### Phase 2: Build the Query Inventory
| # | Source | Query builder | Dynamic parts | Parameterized? | Escaped by ORM? |

---

## Priority-Ranked Pattern Library (14 patterns)

### J-0 — String-interpolated SQL (highest priority)
Any SQL built by string concatenation / format / f-string / template interpolation with user input.

Multi-language grep:
```bash
# Python
grep -rn "execute.*%s.*%\|execute.*f\"\|execute.*format\|cursor\.execute.*%s" . --include="*.py"
grep -rn 'f".*SELECT\|f".*INSERT\|f".*UPDATE\|f".*DELETE' . --include="*.py"
# Ruby
grep -rn "find_by_sql\|execute(\"\|connection\.execute\|where(\"#{" . --include="*.rb"
# Java
grep -rn 'createQuery.*+\|prepareStatement.*+\|Statement.*execute.*+' . --include="*.java"
# Go
grep -rn 'db\.Query.*+\|db\.Exec.*+\|fmt\.Sprintf.*SELECT' . --include="*.go"
# JS/TS
grep -rn '\\${.*}.*SELECT\|\\${.*}.*WHERE\|`.*SELECT.*\\${' . --include="*.{js,ts,jsx,tsx}"
grep -rn 'query(".*" +\|query(\`.*\\${' . --include="*.{js,ts}"
# PHP
grep -rn '\$.*\.\s*"SELECT\|"SELECT.*\$\|mysql_query(".*\$' . --include="*.php"
# C#
grep -rn '\$"SELECT\|\$"UPDATE\|string\.Format.*SELECT\|".*" \+ .*sql' . --include="*.cs"
```

**Candidate rule:** Any match + user input reaches the concatenated part = confirmed SQLi unless the input is allowlisted to an enum (verify the allowlist is tight).

### J-1 — ORM raw-SQL escape hatches
Even in ORM-heavy codebases, developers reach for raw for performance / complexity.

Search:
```bash
grep -rn "find_by_sql\|where.*#{" . --include="*.rb"                         # Rails
grep -rn "raw(\|extra(\|\.raw_query(" . --include="*.py"                     # Django
grep -rn "text(\|from_statement(" . --include="*.py"                         # SQLAlchemy
grep -rn "DB::raw\|DB::select\|DB::statement" . --include="*.php"            # Laravel
grep -rn "\.raw(\|\.raw`" . --include="*.{js,ts}"                            # Knex / Prisma
grep -rn "\$queryRaw\|\$executeRaw" . --include="*.{js,ts}"                  # Prisma raw
grep -rn "createQueryBuilder.*where.*\\${\|createQueryBuilder.*raw" . --include="*.ts" # TypeORM
```

**Trace each:** does user input appear in the raw fragment? Is it `ARGV` / placeholder bound or string-concatenated?

### J-2 — ORDER BY / GROUP BY / LIMIT injection
Placeholders don't work for column names or SQL keywords. Dynamic sort columns are a common blind spot.

Search:
```bash
grep -rn "order(params\|order_by.*request\|ORDER BY.*\\${\|order.*\$_GET\|ORDER BY.*#{" . 
grep -rn "\.sort(params\|\.order(params\[:" . --include="*.rb"
grep -rn "ORDER BY.*{.*}" . 
```

**Candidate rule:** Any match = candidate unless you see an explicit allowlist (`%w[name created_at].include?(params[:sort])`).

### J-3 — Table / schema name injection
Multi-tenant apps often accept a tenant / schema name from the request header.

Search:
```bash
grep -rn "schema.*params\|FROM.*\\${.*table\|quote_table_name" . 
grep -rn 'tenant.*=.*req\|tenant.*=.*request' .
```

### J-4 — Second-order SQLi
Data stored "safely" by one endpoint, then rendered unsafely into a query by another.

Search pattern: find fields that come from user input AND flow into raw-SQL sinks (chain J-1 findings with model writes).

### J-5 — Stored procedure injection
```bash
grep -rn "CREATE.*PROCEDURE\|CREATE.*FUNCTION" . --include="*.sql"
# Then: does the SP body concatenate @params into dynamic SQL via EXEC / sp_executesql?
```

### J-6 — NoSQL injection (MongoDB)
Classic: `{"username": user.username, "password": user.password}` where user.password = `{"$ne": null}`.

Search:
```bash
grep -rn "\.find(.*req\.body\|findOne(.*req\.\|find({.*\\${" . --include="*.{js,ts}"
grep -rn "\$where\|\$regex" . --include="*.{js,ts}" | grep -i "req\|body\|query\|params"
```

### J-7 — JSON operator injection (Postgres JSON columns)
```bash
grep -rn "->>.*params\|->.*\\${\|#>.*request" . 
```

### J-8 — NoSQL operator injection (Mongo, CouchDB)
Body parsers that accept objects for fields where strings are expected.

Search:
```bash
# Mongoose — schema strict mode off?
grep -rn "strict: false\|strict: 'throw'" . --include="*.{js,ts}"
# Is there a body sanitizer that converts $ / . to _?
grep -rn "mongo-sanitize\|express-mongo-sanitize" .
```

### J-9 — GraphQL → SQL injection
GraphQL resolvers that build SQL from user args without sanitization.

### J-10 — LDAP injection (adjacent)
```bash
grep -rn "LdapFilter\|filter:.*(\|search_filter.*params" .
```

### J-11 — XPath injection (adjacent)
```bash
grep -rn "xpath.*params\|XPathExpression.*\\${" .
```

### J-12 — Error-based / time-based oracle indicators
Look for code that leaks raw DB errors to responses or has long query timeouts → enables blind extraction.

### J-13 — SQLi via HTTP headers → logged → read back in query
Headers like `User-Agent` / `Referer` stored to DB unescaped → later rendered into an admin query.

---

## Output Format

Write to: `/root/intel/code-review/findings/<taskId>/jayadratha-sqli.jsonl`

```json
{
  "id": "JA-SQ-001",
  "framework": "sqli",
  "pattern": "J-0",
  "severity": "Critical",
  "title": "String-concatenated SQL in UsersController#search",
  "file": "app/controllers/users_controller.rb",
  "line": 47,
  "source": "params[:q]",
  "sink": "User.find_by_sql(\"SELECT * FROM users WHERE name LIKE '%#{params[:q]}%'\")",
  "gap": "No parameterization; raw interpolation into SQL string",
  "attack_plan": "curl 'https://target/users/search?q=%25%27%20UNION%20SELECT%20email,password%20FROM%20users--'",
  "evidence": "File:line cited above. ORM raw hatch + interpolation = classic SQLi.",
  "needs_live_validation": true
}
```

---

## Verification Notes
- Parameterized queries for values ≠ safe queries for structure. Always check ORDER BY, table names.
- "The ORM protects us" is the most dangerous sentence. Grep for escape hatches.
- Prepared statements re-used across different SQL templates can still be vulnerable if template chosen by user input.
- Mark `needs_live_validation: true` if DB dialect behavior matters (time-based extraction payload changes per engine).

---

## False Positive Prevention (MANDATORY before emitting)

Universal discipline. Principle: don't claim SQLi until every parameterization/escaping layer is inspected.

### Pipeline trace checklist — sqli
1. **Source** — user input entry
2. **Framework ORM** — parameterizes by default at this call
3. **Prepared statement** — pre-compiled with placeholders
4. **Raw SQL escape hatch** — find_by_sql / raw() / DB::raw / text() / $queryRaw
5. **Dynamic fragments** — ORDER BY, GROUP BY, table names (not parameterizable)
6. **Allowlist** — column-name / sort-direction allowlist present
7. **Sink** — query execution

### Schema requirements, Severity, Anti-patterns
Same as DHRISHTADYUMNA — universal schema + 3-tier severity + anti-patterns apply.


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


### Anti-inflation discipline (SQLi)
- ORM escape hatch at controller BUT model has `sanitize_sql_array` OR parameterized at DB layer: validation_layers_checked=[controller] only → cap Medium. Check model + db layers before claiming.
- Admin-only SQLi via allowlisted column names: admin + none → Low. Not a real vuln.
- Second-order SQLi: must trace BOTH write path AND read path. trust_boundary depends on whose data is stored vs. whose query reads.

### Universal principle
SQLi claimed at one layer can be closed at another. "The ORM protects us" is dangerous BUT "model validates scope" is also a real defense — check every layer.
