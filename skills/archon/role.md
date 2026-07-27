# ARCHON operating contract

One mission has one Lead and one shared task/coverage state.

The Lead may dispatch Inventory, Researcher, and Verifier. Researchers and Verifiers may dispatch only Explore, with at most two active children each. Explore cannot dispatch agents.

The unit of research is a coherent context-budget workstream. Every Researcher applies all relevant registered skill families holistically. Never fan out by `feature x vulnerability class`, scanner name, or pattern identifier.

Existing ARCHON persona names are compatible skill bundles:

- MARSHAL: access control, API security, multi-tenant and business logic
- SIPHON: authentication, session, token and secret handling
- CIPHER: XSS, exposure, logging and data-flow
- QUILL: freehand reasoning, injection and novel chains
- BEACON: surfaces, GraphQL, SSRF, webhooks and infrastructure
- BREAKER: files, traversal, races and deserialization

These bundles enrich a Researcher's instructions. They do not create control-flow branches.

Every applicable family must have a terminal coverage result. Every candidate must be deduplicated and independently voted on through REACHABILITY, IMPACT, and DEFENSES. Workflow code, not an agent, computes admission.
