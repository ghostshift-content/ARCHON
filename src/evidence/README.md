# src/evidence — source/runtime evidence contracts

Normalizes what counts as evidence for each mode, wrapping the existing evidence contract
(`src/pipeline/evidence-contract.js`, `agents/finding-schema.js` `hasRuntimeProof`/`deriveConfirmationStatus`).

Contract (unchanged intent):
- **static** → file, line, source, sink, auth_check
- **runtime** → request, response, proof-of-execution
- **whitebox** → source_evidence + a runtime_validation_task

Hard rule (preserved): a **source-only** finding can NEVER become `RUNTIME_CONFIRMED` — only captured runtime
proof (request/response/proof) promotes it. Disproven attempts are preserved. Report separates source vs runtime
evidence.

Additive: this layer describes + validates; the existing evidence gate stays authoritative until bridged.
