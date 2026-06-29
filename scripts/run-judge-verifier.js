#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// scripts/run-judge-verifier.js
//
// G1 Judge Verifier — MVP CLI runner.
//
// Reads VALIDATED-FINDINGS-{taskId}.jsonl, runs each finding through the
// 4-stage judge (Stage A-D), writes JUDGED-FINDINGS-{taskId}.jsonl.
//
// Real LLM call uses `claude --print --model haiku` subprocess (matches
// grader.js pattern in this repo — no SDK coupling, OAuth via claude binary).
//
// Usage:
//   node scripts/run-judge-verifier.js <taskId>
//   node scripts/run-judge-verifier.js --file /path/to/VALIDATED-FINDINGS.jsonl
//   node scripts/run-judge-verifier.js <taskId> --mock        # dry-run, all confirmed
//   node scripts/run-judge-verifier.js <taskId> --target https://example.com
//
// Spec: docs/superpowers/specs/2026-05-06-G1-judge-verifier-design.md §5 MVP

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { judgeFindings, judgeFindingsWithPromotion, judgeFindingsWithConsensus, PROMOTION_CAP_DEFAULT } = require('../agents/judge-verifier')
const { readFindingsFile } = require('../agents/finding-schema')

const INTEL_DIR = __roots.INTEL_ROOT
const CLAUDE_BIN = process.env.KURU_CLAUDE_BIN || 'claude'
const LLM_TIMEOUT_MS = 90_000

// 2026-05-10: was hardcoded `claude-haiku-4-5`. Now resolves from
// /root/intel/model-config.json families.fast on each invocation (cached
// inside the resolver). Same regression class as 2026-04-20 stocks fix.
const { resolveLLMModel } = require('../agents/llm-model-resolver')

function findValidatedFile(taskId) {
  const candidates = [
    path.join(INTEL_DIR, `VALIDATED-FINDINGS-${taskId}.jsonl`),
    path.join(INTEL_DIR, 'pentest', `VALIDATED-FINDINGS-${taskId}.jsonl`),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function readFindings(file) {
  // Sprint A.2 (2026-05-09): route through finding-schema normalizer so severity
  // case is canonical, missing titles get synthesized, and findingId→id mapped
  // before the judge sees the data. Single source of truth for record shape.
  return readFindingsFile(file)
}

function writeJudged(findings, taskId, outputDir) {
  const out = path.join(outputDir, `JUDGED-FINDINGS-${taskId}.jsonl`)
  fs.writeFileSync(out, findings.map(f => JSON.stringify(f)).join('\n') + '\n')
  return out
}

function callRealLLM(prompt, opts = {}) {
  const model = resolveLLMModel({ family: 'fast', override: opts.model })
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: '/root' }
    delete env.ANTHROPIC_API_KEY
    // Structured output (2026-06-09): when a jsonSchema is supplied, run with
    // --output-format json + --json-schema. The model's schema-conforming object lands in
    // envelope.structured_output (verified live: result is empty, structured_output holds the
    // judgment). We hand that back as a JSON STRING so parseJudgeResponse parses GUARANTEED-valid
    // JSON — retiring the regex-extract/markdown-strip fragility that silently downgraded
    // Critical/High to 'indeterminate' on any formatting wobble. Additive: no schema = old text path.
    const useSchema = !!opts.jsonSchema
    const args = useSchema
      ? ['--print', '--output-format', 'json', '--model', model, '--json-schema',
         (typeof opts.jsonSchema === 'string' ? opts.jsonSchema : JSON.stringify(opts.jsonSchema))]
      : ['--print', '--output-format', 'text', '--model', model]
    const proc = spawn(CLAUDE_BIN, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`claude timeout after ${LLM_TIMEOUT_MS}ms`))
    }, LLM_TIMEOUT_MS)
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error(`claude exited ${code}: ${stderr.trim() || '(no stderr)'}`)); return }
      if (!useSchema) { resolve(stdout.trim()); return }
      // Extract the schema-conforming object from the json envelope; prefer structured_output,
      // then a non-empty text result.
      try {
        const envObj = JSON.parse(stdout)
        if (envObj && envObj.structured_output && typeof envObj.structured_output === 'object') {
          resolve(JSON.stringify(envObj.structured_output)); return
        }
        if (typeof envObj.result === 'string' && envObj.result.trim()) { resolve(envObj.result.trim()); return }
        // Envelope parsed but carries NO usable judgment → resolve '' so parseJudgeResponse returns
        // the honest 'indeterminate' (couldn't-judge → manual-review cap). Do NOT hand back the raw
        // envelope: its greedy {…} match would parse the wrapper and fabricate a 'downgraded' verdict.
        resolve(''); return
      } catch { /* envelope itself wasn't JSON → let parseJudgeResponse try the raw text */ }
      resolve(stdout.trim())
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

async function runJudge({ taskId, file, target, callLLM, outputDir, severityFilter, promotionMode, promotionCap } = {}) {
  const validatedFile = file || (taskId ? findValidatedFile(taskId) : null)
  if (!validatedFile || !fs.existsSync(validatedFile)) {
    throw new Error(`No VALIDATED-FINDINGS for taskId=${taskId || '(none)'}, file=${file || '(none)'}`)
  }

  const findings = readFindings(validatedFile)
  const inferredTarget = target || findings[0]?.url || findings[0]?.target || ''
  // Round-6 fix: caller can override outputDir. Without override, defaults to
  // dirname of the input file. The Phase 3.9 hook in event-bus.js passes /root/intel/
  // explicitly so SCRIBE can find JUDGED-FINDINGS at the path it reads from.
  const effectiveOutputDir = outputDir || path.dirname(validatedFile)
  const effectiveTaskId = taskId || findings[0]?.taskId || 'unknown'

  // Promotion mode: evaluate Medium findings with stricter rubric.
  // Critical/High → 3-judge consensus; Medium → promotion tier; Low/Info → pass-through.
  // The 3-judge consensus (judgeFindingsWithConsensus) runs for High/Critical findings only,
  // then delegates to standard judgeFindingsWithPromotion for Medium tier.
  const { results, summary } = promotionMode
    ? await (async () => {
        // First pass: consensus judge on High/Critical only
        const highCrit = findings.filter(f => ['critical', 'high'].includes((f.severity || '').toLowerCase()))
        const rest = findings.filter(f => !['critical', 'high'].includes((f.severity || '').toLowerCase()))
        const { results: hcResults, summary: hcSummary } = await judgeFindingsWithConsensus(highCrit, {
          target: inferredTarget,
          callLLM,
        })
        // Second pass: standard promotion judge on Medium+ findings
        const { results: restResults, summary: restSummary } = await judgeFindingsWithPromotion(rest, {
          target: inferredTarget,
          callLLM,
          promotionCap: typeof promotionCap === 'number' ? promotionCap : PROMOTION_CAP_DEFAULT,
        })
        return {
          results: [...hcResults, ...restResults],
          summary: {
            total: findings.length,
            confirmed: hcSummary.confirmed + restSummary.confirmed,
            downgraded: hcSummary.downgraded + restSummary.downgraded,
            indeterminate: (hcSummary.indeterminate || 0) + (restSummary.indeterminate || 0),
            downgraded_by_stage: restSummary.downgraded_by_stage,
            promoted: restSummary.promoted || 0,
            consensus_used: highCrit.length,
          },
        }
      })()
    : await judgeFindings(findings, {
        target: inferredTarget,
        callLLM,
        severityFilter,
      })

  const outFile = writeJudged(results, effectiveTaskId, effectiveOutputDir)
  return { outFile, summary, results, validatedFile }
}

function parseArgs(argv) {
  const opts = { mock: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mock') opts.mock = true
    else if (a === '--promotion-mode') opts.promotionMode = true
    else if (a === '--promotion-cap') opts.promotionCap = Number(argv[++i])
    else if (a === '--file') opts.file = argv[++i]
    else if (a === '--target') opts.target = argv[++i]
    else if (a === '--model') opts.model = argv[++i]
    else if (!a.startsWith('--') && !opts.taskId) opts.taskId = a
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.taskId && !opts.file) {
    console.error('Usage: run-judge-verifier.js <taskId> [--file path] [--target url] [--mock] [--model name]')
    process.exit(1)
  }

  let callLLM
  if (opts.mock) {
    callLLM = async () => JSON.stringify({
      stage_a: { pass: true, reason: 'mock' },
      stage_b: { pass: true, reason: 'mock' },
      stage_c: { pass: true, reason: 'mock' },
      stage_d: { pass: true, reason: 'mock' },
      verdict: 'confirmed',
      first_failed_stage: null,
    })
  } else {
    // callRealLLM resolves the fast-family default when model is undefined — no DEFAULT_MODEL
    // constant exists (referencing it threw ReferenceError on the standalone CLI judge path).
    callLLM = (prompt, o) => callRealLLM(prompt, { model: opts.model, ...(o || {}) })
  }

  const startedAt = Date.now()
  const result = await runJudge({ ...opts, callLLM })
  const elapsedMs = Date.now() - startedAt

  console.log(`✅ Judge complete in ${(elapsedMs / 1000).toFixed(1)}s`)
  console.log(`   Input:  ${result.validatedFile}`)
  console.log(`   Output: ${result.outFile}`)
  console.log(`   Summary: ${result.summary.confirmed} confirmed, ${result.summary.downgraded} downgraded, ${result.summary.indeterminate} indeterminate (n=${result.summary.total})`)
  if (typeof result.summary.promoted === 'number') {
    console.log(`   Promoted (Medium → High): ${result.summary.promoted} ` +
      `(promotion LLM calls: ${result.summary.promotion_llm_calls}/${result.summary.promotion_cap})`)
  }
  if (result.summary.downgraded > 0) {
    const byStage = result.summary.downgraded_by_stage
    console.log(`   Downgrades by stage: A=${byStage.A} B=${byStage.B} C=${byStage.C} D=${byStage.D}`)
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  })
}

module.exports = {
  runJudge,
  findValidatedFile,
  readFindings,
  writeJudged,
  callRealLLM,
  parseArgs,
}
