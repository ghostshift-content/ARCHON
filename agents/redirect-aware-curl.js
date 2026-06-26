// agents/redirect-aware-curl.js
//
// Helper used by chain-verifier to detect CORS-assertion steps and
// extract the FINAL HTTP response from a multi-hop curl -L output.
//
// Motivation: ACAO/ACAC headers on a 3xx redirect hop are browser-
// meaningless. Real browsers re-evaluate CORS only at the final
// landing. Chain-verifier was matching the wrong response.

const CORS_HEADER_PATTERNS = [
  /access[-]control[-]allow[-]origin/i,
  /access[-]control[-]allow[-]credentials/i,
  /access[-]control[-]allow[-]methods/i,
  /access[-]control[-]allow[-]headers/i,
  /access[-]control[-]expose[-]headers/i,
]

function isCorsAssertion(expectedResult, expectedKeywords) {
  const haystack = [
    typeof expectedResult === 'string' ? expectedResult : '',
    Array.isArray(expectedKeywords) ? expectedKeywords.join(' ') : '',
  ].join(' ')
  return CORS_HEADER_PATTERNS.some(re => re.test(haystack))
}

function extractFinalResponse(raw) {
  if (typeof raw !== 'string') return ''
  const matches = []
  let m
  const re = /^HTTP\/(\d(?:\.\d)?)\s+(\d{3})/gm
  while ((m = re.exec(raw)) !== null) {
    matches.push(m.index)
  }
  if (matches.length <= 1) return raw
  return raw.slice(matches[matches.length - 1])
}

module.exports = {
  isCorsAssertion,
  extractFinalResponse,
  CORS_HEADER_PATTERNS,
}
