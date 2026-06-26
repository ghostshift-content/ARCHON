// /root/agents/early-exit-decision.js
//
// Pure function: given recon outcome signals, decide whether to early-exit
// the pentest pipeline (skip specialist phases) or continue.
//
// Rules (first matching wins):
//   1. endpointCount > 0 → CONTINUE
//   2. targetReachable AND missedSignalsCount >= 3 → CONTINUE_WITH_HINTS
//   3. targetReachable AND missedSignalsCount < 3 → CONTINUE
//   4. !targetReachable AND missedSignalsCount >= 3 → CONTINUE_WITH_HINTS_REACHCHECK
//   5. otherwise → EARLY_EXIT

const CONTINUE = 'CONTINUE'
const CONTINUE_WITH_HINTS = 'CONTINUE_WITH_HINTS'
const CONTINUE_WITH_HINTS_REACHCHECK = 'CONTINUE_WITH_HINTS_REACHCHECK'
const EARLY_EXIT = 'EARLY_EXIT'

const MISSED_SIGNAL_THRESHOLD = 3

function shouldEarlyExit({ endpointCount = 0, targetReachable = false, missedSignalsCount = 0 } = {}) {
  if (endpointCount > 0) {
    return { decision: CONTINUE, reason: 'endpoints_found' }
  }
  if (targetReachable) {
    if (missedSignalsCount >= MISSED_SIGNAL_THRESHOLD) {
      return { decision: CONTINUE_WITH_HINTS, reason: `${missedSignalsCount}_missed_signals` }
    }
    return { decision: CONTINUE, reason: 'target_reachable_no_endpoints' }
  }
  if (missedSignalsCount >= MISSED_SIGNAL_THRESHOLD) {
    return { decision: CONTINUE_WITH_HINTS_REACHCHECK, reason: `${missedSignalsCount}_signals_unreachable_recheck_scheme` }
  }
  return { decision: EARLY_EXIT, reason: 'no_endpoints_unreachable_no_signals' }
}

module.exports = {
  shouldEarlyExit,
  MISSED_SIGNAL_THRESHOLD,
  decisions: { CONTINUE, CONTINUE_WITH_HINTS, CONTINUE_WITH_HINTS_REACHCHECK, EARLY_EXIT },
}
