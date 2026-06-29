# WAF Bypass Reference (per-vendor)

Read this when `env-fingerprint.waf.present` is true. It is **reference knowledge to
adapt from**, not a list of canned payloads — generate the actual payload for the
target's stack, then apply the vendor's known weak spots. Always: fire → read the
response → if blocked (403/406/429, challenge page, `cf-mitigated`, Akamai `AkamaiGHost`,
Imperva `incident id`), identify the vendor signature → mutate → refire. Record every
attempt.

## Generic (works against most WAFs)
- **Encoding**: URL-encode, double-URL-encode, Unicode (`%u0027`), HTML entities, mixed.
- **Case + comments**: `SeLeCt`, `/*!50000UNION*/`, `un/**/ion`, `OR/**/1=1`.
- **Whitespace**: tabs/newlines/`%0a%0d`, `+`, `/**/`, `%09`, parenthesis nesting.
- **Logic equivalence**: `OR 1=1` → `OR 'a'='a'` → `OR 2>1` → `||1#`; `<script>` → `<svg/onload>`, `<img src=x onerror=>`.
- **HTTP-layer**: change verb (GET↔POST↔PUT), JSON vs form body, content-type swap, parameter pollution (`?id=1&id=payload`), oversized junk before payload, chunked transfer-encoding.
- **Header spoofing** (origin trust): `X-Forwarded-For`, `X-Originating-IP`, `X-Forwarded-Host`, `X-Real-IP` set to `127.0.0.1` / internal; `X-Original-URL` / `X-Rewrite-URL` path override.

## Cloudflare
- Origin-IP bypass: if the real origin IP leaks (DNS history, SSL cert SAN, headers), hit it directly to skip the edge WAF entirely. **Highest-value Cloudflare bypass.**
- Body-based payloads often less inspected than query string; try POST/JSON.
- `cf-connecting-ip` / `X-Forwarded-For` spoofing for IP allowlists.
- Managed-rule evasion: heavy comment/case obfuscation on SQLi; event-handler swaps + `<svg>`/`<math>` vectors on XSS.
- Watch for `cf-mitigated: challenge` / `__cf_chl` — that's a block, mutate.

## Akamai (Kona)
- Path/case: append `;`, `//`, trailing `.`, mixed case on path segments.
- Akamai inspects the first N bytes — pad the body with benign filler before the payload.
- `Pragma: akamai-x-...` debug headers can reveal handling; `AkamaiGHost` in a 403 body = block.
- Try alternate content-types and multipart bodies; chunked encoding.

## Imperva (Incapsula)
- `incident id` in the block page = Imperva. Heavy on signature regex → break tokens with comments/encoding.
- Cookie `incap_ses`/`visid_incap` present; some rules keyed on missing cookies — supply realistic ones.
- HTTP parameter pollution + JSON body often slips past form-focused rules.

## AWS WAF
- Rule-set is customer-configured + size-limited (inspects first 8KB of body by default) → push the payload past 8KB with leading filler.
- Often allowlists by header/IP; `X-Forwarded-For` spoofing where origin trusts it.
- Rate-based rules ≠ signature rules; mutate slowly to avoid rate rules.

## F5 BIG-IP ASM
- `TS...` cookie / `BIGipServer` = F5. ASM often blocks on parameter meta-chars → encode + parameter pollution.
- Try verb tampering and `Transfer-Encoding: chunked`.

## ModSecurity / OWASP CRS
- Paranoia-level dependent. Comment-based SQLi (`/*!...*/`), Unicode, and `multipart/form-data` smuggling are classic CRS evasions.
- Anomaly scoring: a single payload may pass if split across multiple lower-score params (parameter pollution).

> If none land after genuine adaptation, log all attempts and mark the finding SUSPECTED
> (WAF-blocked) with the evidence — do not claim CONFIRMED on a blocked payload.
