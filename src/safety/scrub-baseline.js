// Strip baseline/comparison language from task goal text before it reaches
// specialists/validator/report-writer. Prevents sycophantic mirroring of
// baseline numbers in squad outputs (Apr-21 Run 1: SCRIBE spawn prompt said
// "Apr-20 baseline = 19 findings (2 CRIT/7 HIGH/...). Goal: match or exceed"
// and SCRIBE's executive summary then wrote exactly "19 / 2C/7H/5M/5L" even
// though the body had 8 High and 4 Low.
//
// Rule: only the orchestrator (ATLAS chain analysis) and NEXUS (grader)
// should see the raw goal. Specialists, AUDITOR, SCRIBE must work blind to
// baseline numbers.

function scrubBaselineFromGoal(goal) {
  if (!goal) return ''
  let s = String(goal)
  const patterns = [
    /\b(?:Apr|Mar|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb)-?\d+\s+baseline[^.\n]*\.?/gi,
    /\bbaseline\s+[A-Z-]+(?:\.md)?\s+at\s+[^.\n]*\.?/gi,
    /\bbaseline[^.\n]{0,20}\b\d+\s+(?:confirmed\s+)?findings?[^.\n]*\.?/gi,
    /\b\d+\s+(?:CRIT(?:ICAL)?|HIGH|MED(?:IUM)?|LOW)\b(?:\s*[+,]\s*\d+\s+(?:CRIT(?:ICAL)?|HIGH|MED(?:IUM)?|LOW)\b)+/gi,
    /\bwith\s+\d+\s+critical\/high\s+attack\s+chains?\b/gi,
    /\bGoal:\s*match\s+or\s+exceed[^.\n]*\.?/gi,
    /\bcompar(?:e|ed|ison|ing)\s+(?:to|against|with|vs\.?)\s+[^.\n]*\.?/gi,
    /\bexceed\s+this\s+baseline[^.\n]*\.?/gi,
    /[=:]\s*\d+\s+(?:confirmed\s+)?findings?\b/gi,
  ]
  for (const p of patterns) s = s.replace(p, '')
  // Collapse whitespace only — don't touch punctuation (else "hrconnect.emiratesnbd.com" breaks).
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n+ */g, '\n').trim()
  return s
}

module.exports = { scrubBaselineFromGoal }
