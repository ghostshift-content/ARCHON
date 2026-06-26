#!/bin/bash
# /root/agents/scripts/phase38-retro-validate.sh
#
# Retroactively run Phase 3.8 (browser-verifier) on browser-relevant findings.
# Reads either per-task or global VALIDATED-FINDINGS.jsonl. Auto-builds recipes
# for finding types we know how to validate (XSS family); marks others as
# "needs_manual_recipe" so SCRIBE / human reviewer knows which Phase 3.8
# candidates couldn't be auto-tested.
#
# Use cases:
#   - After Phase 3.8 logic update, re-validate past findings
#   - Triage flagged findings without re-running 8h pipeline
#   - Audit which past findings would have been caught by current Phase 3.8 filter
#
# Usage:
#   bash /root/agents/scripts/phase38-retro-validate.sh                    # global file
#   bash /root/agents/scripts/phase38-retro-validate.sh <task_id>          # per-task file
#   bash /root/agents/scripts/phase38-retro-validate.sh <task_id> <id>     # single finding
#   bash /root/agents/scripts/phase38-retro-validate.sh global <id>        # single finding from global
#
# Output:
#   per-task: /root/intel/pentest/BROWSER-VERIFICATION-RETRO-<task_id>.jsonl
#   global:   /root/intel/pentest/BROWSER-VERIFICATION-RETRO-global.jsonl
#
# Exit codes:
#   0 = ran (regardless of verdicts)
#   1 = no findings file
#   2 = no browser-relevant findings (filter caught 0)
#   3 = browser-verifier crashed

set -e

TASK_ID="${1:-global}"
FINDING_ID="${2:-}"

cd "$(dirname "$0")/.."

if [ "$TASK_ID" = "global" ]; then
  FINDINGS_FILE="/root/intel/pentest/VALIDATED-FINDINGS.jsonl"
  OUTPUT_FILE="/root/intel/pentest/BROWSER-VERIFICATION-RETRO-global.jsonl"
else
  FINDINGS_FILE="/root/intel/pentest/VALIDATED-FINDINGS-${TASK_ID}.jsonl"
  OUTPUT_FILE="/root/intel/pentest/BROWSER-VERIFICATION-RETRO-${TASK_ID}.jsonl"
fi

if [ ! -f "$FINDINGS_FILE" ]; then
  echo "❌ No findings file: ${FINDINGS_FILE}"
  exit 1
fi

echo "Reading: $FINDINGS_FILE"
echo "Output:  $OUTPUT_FILE"
echo

node <<JS
const fs = require('fs')
const path = require('path')
const browserVerifier = require('./agents/browser-verifier')
const { filterBrowserRelevant } = require('./agents/pentest-browser-recipe-constructor')

const FINDING_ID_FILTER = '${FINDING_ID}'
const FINDINGS_FILE = '${FINDINGS_FILE}'
const OUTPUT_FILE = '${OUTPUT_FILE}'

;(async () => {
  const lines = fs.readFileSync(FINDINGS_FILE, 'utf-8').split('\n').filter(Boolean)
  const allFindings = []
  for (const line of lines) {
    try { allFindings.push(JSON.parse(line)) } catch {}
  }

  let candidates = filterBrowserRelevant(allFindings)
  if (FINDING_ID_FILTER) {
    candidates = candidates.filter(f => String(f.id || '') === FINDING_ID_FILTER)
  }

  console.log(\`Found \${allFindings.length} total findings, \${candidates.length} browser-relevant\`)
  if (candidates.length === 0) {
    console.log('No browser-relevant findings to validate. Exiting.')
    process.exit(2)
  }

  // Recipe builders by finding category. Phase 3.8 can only auto-validate
  // finding types where we know how to construct a deterministic recipe.
  // Other types (CORS preflight + credentials, postMessage handler reachability,
  // CSP enforcement variation) need a real attacker page or LLM-built recipe.
  function buildRecipe(f) {
    const url = f.url || ''
    if (!url) return { skip: 'no URL on finding' }

    const semantic = (
      String(f.type || '') + ' ' +
      String(f.subtype || '') + ' ' +
      String(f.title || '') + ' ' +
      String(f.notes || '') + ' ' +
      String(f.reproduction_method || '')
    ).toLowerCase()

    // Reflected/DOM XSS — sentinel-based detection
    if (/\\bxss\\b|cross.site.script|dom.based/i.test(semantic)) {
      const sentinelUrl = url
        .replace(/PAYLOAD|TESTPAYLOAD|KTEST.*?(?=[\\\\\\/&?#]|\$)/i, 'KTEST%22onmouseover=%22window.__xss_fired__=true%22')
        .replace(/alert\\(\\d+\\)/i, 'window.__xss_fired__=true')
      return {
        recipe: {
          finding_id: f.id || 'unknown',
          finding_type: f.type || f.title || 'unknown',
          description: \`XSS sentinel injection — does payload execute in browser?\`,
          steps: [
            { action: 'navigate', url: sentinelUrl },
            { action: 'wait_for', timeout_ms: 2000 },
            { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
          ],
          verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
        }
      }
    }

    // Open Redirect / location.href — check if redirect actually navigates
    if (/location\\.(href|assign|replace)|client.side.redirect|dom.based.redirect/i.test(semantic)) {
      return {
        recipe: {
          finding_id: f.id || 'unknown',
          finding_type: f.type || f.title || 'unknown',
          description: \`Client-side redirect — does location.href change to attacker URL?\`,
          steps: [
            { action: 'navigate', url },
            { action: 'wait_for', timeout_ms: 3000 },
            { action: 'evaluate', expression: 'document.location.hostname.includes("attacker") || document.location.hostname.includes("evil")' }
          ],
          verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
        }
      }
    }

    // CORS / postMessage / CSP — needs attacker-page-driven test, not auto-recipeable
    return { skip: 'auto-recipe not supported for this category — needs LLM-built recipe or manual test' }
  }

  const results = []
  for (const f of candidates) {
    const built = buildRecipe(f)
    if (built.skip) {
      console.log(\`  ⏭️  \${f.id || '?'}: \${(f.title || f.type || '?').slice(0, 60)}\`)
      console.log(\`       skipped — \${built.skip}\`)
      results.push({
        finding_id: f.id || 'unknown',
        finding_type: f.type || f.title || 'unknown',
        original_validation_status: f.validation_status || 'UNKNOWN',
        executed: false,
        verdict: 'NEEDS_MANUAL_RECIPE',
        reason: built.skip,
        retro_validated_at: new Date().toISOString(),
      })
      continue
    }

    const recipe = built.recipe
    console.log(\`  🔬 \${f.id}: \${(f.title || f.type || '?').slice(0, 60)}\`)
    console.log(\`       → \${recipe.steps[0].url.slice(0, 80)}\`)
    try {
      const r = await browserVerifier.verifyRecipe(recipe, { allowFileUrls: false })
      results.push({
        finding_id: r.finding_id,
        finding_type: r.finding_type,
        original_validation_status: f.validation_status || 'UNKNOWN',
        executed: r.executed,
        browser_fired: r.browser_fired,
        verdict: r.verdict,
        reason: r.reason,
        evidence_summary: {
          steps: r.step_results.map(s => \`\${s.action}=\${s.status}\`).join(' / '),
          final_url: r.evidence.final_url,
          network_requests: r.evidence.network_request_count,
        },
        retro_validated_at: new Date().toISOString(),
      })
      const sym = r.verdict === 'CONFIRMED' ? '✅ CONFIRMED (browser_fired=true)' :
                  r.verdict === 'KILLED' ? '❌ KILLED (false positive empirically)' :
                  '⚠️ INDETERMINATE'
      console.log(\`       \${sym}\`)
    } catch (e) {
      console.log(\`       💥 CRASH: \${e.message}\`)
      results.push({
        finding_id: f.id || 'unknown',
        finding_type: f.type || f.title || 'unknown',
        executed: false,
        verdict: 'INDETERMINATE',
        reason: \`crash: \${e.message}\`,
        retro_validated_at: new Date().toISOString(),
      })
    }
  }

  fs.writeFileSync(OUTPUT_FILE, results.map(r => JSON.stringify(r)).join('\n') + '\n')

  const confirmed = results.filter(r => r.verdict === 'CONFIRMED').length
  const killed = results.filter(r => r.verdict === 'KILLED').length
  const indeterminate = results.filter(r => r.verdict === 'INDETERMINATE').length
  const needsManual = results.filter(r => r.verdict === 'NEEDS_MANUAL_RECIPE').length
  console.log(\`\\n--- SUMMARY ---\`)
  console.log(\`  CONFIRMED:           \${confirmed} (browser_fired=true)\`)
  console.log(\`  KILLED:              \${killed} (browser_fired=false → likely FP)\`)
  console.log(\`  INDETERMINATE:       \${indeterminate} (couldn't test — WAF, DNS, etc.)\`)
  console.log(\`  NEEDS_MANUAL_RECIPE: \${needsManual} (Phase 3.8 candidate but auto-recipe not supported)\`)
  console.log(\`\\nOutput: \${OUTPUT_FILE}\`)
})().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(3)
})
JS
