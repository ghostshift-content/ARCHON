# XSS / HTML Injection Canonical 50-Pattern Catalog

Use these exact IDs and names.

Every Phase 2 XSS feature report must include all 50 rows.

| Pattern | Canonical Name |
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
| XSS-11 | raw, html_safe, safe_join, or equivalent unsafe server-side rendering |
| XSS-12 | Sanitization performed before later unsafe mutation/concatenation |
| XSS-13 | Double decoding, entity decoding, or canonicalization mismatch |
| XSS-14 | DOM sink injection via innerHTML, outerHTML, insertAdjacentHTML, or jQuery html() |
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
| XSS-46 | User-controlled protocol scheme bypass such as javascript:, data:, vbscript:, encoded variants |
| XSS-47 | Unicode, null-byte, control-character, or browser parser differential bypass |
| XSS-48 | HTML injection enabling phishing, UI spoofing, or credential capture without script |
| XSS-49 | Stored content crosses privilege boundary from low-privileged author to high-privileged viewer |
| XSS-50 | Same functionality rendered differently across Web, REST, GraphQL, mobile, email, or preview |
