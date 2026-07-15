'use strict'
// M11: the QUOTA GOVERNOR (spec §15). Turns rate-limit signals into a single quota STATE the session planner
// consumes to reduce ACTIVE concurrency (never to spawn more sessions). Pure state machine over a hit history +
// a thin read of the existing quota-manager; the actual pause/backoff execution already lives in the dispatcher's
// defer/resume loop — this module gives it one coherent policy + the UI a health signal. Additive/observe-only
// until wired (behind a flag) in M11.
//
// Backoff ladder (spec §15):
//   healthy      → planned concurrency
//   1st hit      → warm        (reduce concurrency by 1)
//   repeat <30m  → constrained (single active session, high-risk first)
//   long cooldown→ cooling     (pause new review, let triage finish, checkpoint + UI warning)

const WINDOW_MS = 30 * 60 * 1000 // "repeated within 30 minutes"
const LONG_COOLDOWN_MS = 30 * 60 * 1000 // a cooldown at/over this ⇒ cooling

// Derive the quota state from a hit history. Pure — the caller passes `now` and the hit timestamps (ms).
//   hits: [{ ts, cooldownMs? }]   now: number
function stateFrom(hits, now, activeCooldownUntil) {
  const h = (hits || []).filter((x) => x && Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts)
  if (Number.isFinite(activeCooldownUntil) && activeCooldownUntil - now >= LONG_COOLDOWN_MS) return 'cooling'
  if (h.length === 0) return 'healthy'
  const recent = h.filter((x) => now - x.ts <= WINDOW_MS)
  const last = h[h.length - 1]
  if (last && Number.isFinite(last.cooldownMs) && last.cooldownMs >= LONG_COOLDOWN_MS && now - last.ts < last.cooldownMs) return 'cooling'
  if (recent.length >= 2) return 'constrained'
  if (recent.length === 1) return 'warm'
  return 'healthy'
}

// What to shed first when hot (spec §15): freehand → low-priority review → (keep high-risk + cheap triage).
function shedOrder() { return ['freehand', 'low_priority_review', 'normal_review'] }

// Should new REVIEW work pause? (triage may continue if cheap.)
function shouldPauseReview(state) { return state === 'cooling' }
function shouldCheckpoint(state) { return state === 'cooling' }

// A live-ish governor around an in-memory hit log (for the daemon to feed). Thin + optional.
function createGovernor(clock) {
  const now = clock || (() => { try { return Date.now() } catch { return 0 } })
  const hits = []
  let cooldownUntil = null
  return {
    reportHit(cooldownMs) { hits.push({ ts: now(), cooldownMs: cooldownMs || null }); if (cooldownMs) cooldownUntil = now() + cooldownMs },
    state() { return stateFrom(hits, now(), cooldownUntil) },
    summary() { const s = stateFrom(hits, now(), cooldownUntil); return { state: s, hits: hits.length, cooldownUntil, pauseReview: shouldPauseReview(s), checkpoint: shouldCheckpoint(s) } },
  }
}

module.exports = { stateFrom, shedOrder, shouldPauseReview, shouldCheckpoint, createGovernor, WINDOW_MS, LONG_COOLDOWN_MS }
