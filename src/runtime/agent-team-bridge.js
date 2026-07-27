'use strict'

// Additive bridge from the current dispatchers into runtime-v2. In shadow mode it
// persists the exact canonical-team plan that would run, without changing execution.
// Active execution remains opt-in until parity gates prove each legacy mode.

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const team = require('./agent-team')
const runtimeController = require('./runtime-controller')

function mode() { return agentPaths.runtimeV2Mode() }
function enabled() { return mode() !== 'off' }

function artifactPath(taskId) {
  return path.join(agentPaths.INTEL_ROOT, `agent-team-plan-${taskId}.json`)
}

function planMission(taskId, input = {}) {
  if (!enabled()) return null
  const plan = team.buildResearchPlan(input)
  const artifact = {
    taskId,
    generated_at: new Date().toISOString(),
    runtime_mode: mode(),
    // This compatibility bridge only observes legacy dispatch. The Claude plugin
    // workflow is executable; daemon cutover needs a separate, parity-gated driver.
    drives_execution: false,
    execution_note: mode() === 'active'
      ? 'active requested, but legacy dispatcher remains authoritative until the mode parity gate is installed'
      : 'shadow projection of the legacy session plan',
    ...plan,
  }
  fs.mkdirSync(agentPaths.INTEL_ROOT, { recursive: true })
  const destination = artifactPath(taskId)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(artifact, null, 2))
  fs.renameSync(temporary, destination)
  // Runtime-v2 receives the same exact legacy workstream plan. Shadow output is
  // isolated; canary/active merely seed the executable board here. The legacy
  // bridge never starts workers, so an existing dispatcher cannot double-run.
  try {
    runtimeController.prepare({
      taskId,
      mode: input.mode,
      strategy: input.strategy,
      workstreams: input.workstreams || [],
      applicableSkills: input.applicableSkills || [],
      activeConcurrency: input.activeConcurrency,
      maxExploreChildren: input.maxExploreChildren,
    })
  } catch {}
  return artifact
}

function onLegacySessionPlan(taskId, legacyPlan = {}) {
  if (!enabled()) return null
  const workstreams = legacyPlan.workstreams || legacyPlan.sessions || legacyPlan.shards || []
  return planMission(taskId, {
    mode: legacyPlan.mode || 'static',
    strategy: legacyPlan.strategy,
    workstreams,
    applicableSkills: legacyPlan.applicable_skills || legacyPlan.skill_families || [],
    activeConcurrency: legacyPlan.active_concurrency,
    maxExploreChildren: 2,
  })
}

module.exports = { mode, enabled, artifactPath, planMission, onLegacySessionPlan }
