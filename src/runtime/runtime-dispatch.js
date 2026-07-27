'use strict'

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const { classifyEngagementMode } = require('../core/engagement-mode')
const generations = require('./runtime-generation')
const profiler = require('./profiler')
const workstreamPlanner = require('./workstream-planner')
const blackboxStrategy = require('./blackbox-strategy')
const controller = require('./runtime-controller')
const { hostAllowed } = require('./tool-scope-gate')
const patternRegistry = require('../patterns/registry')

function _scope(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentPaths.INTEL_ROOT, `scope-${taskId}.json`), 'utf8'))
  } catch { return null }
}

function _target(dispatch) {
  const meta = dispatch.meta || {}
  return meta.deployUrl || meta.targetUrl ||
    String(dispatch.goal || '').match(/https?:\/\/[^\s]+/i)?.[0] || null
}

function _sharedFiles(files) {
  return files.filter(row =>
    /(^|\/)(application_controller|base_controller|middleware|policies?|authorization|authentication|permissions?|roles?|sessions?)([./_-]|$)/i.test(row.path)
  ).map(row => row.path)
}

function _sourcePlan(dispatch, mode) {
  const rawSourceDir = String(dispatch.meta && dispatch.meta.sourceDir || '').trim()
  if (!rawSourceDir) throw new Error('source directory is missing')
  const sourceDir = path.resolve(rawSourceDir)
  if (!fs.existsSync(sourceDir)) throw new Error(`source directory is unavailable: ${sourceDir}`)
  const modelContext = profiler.modelContext(dispatch.model)
  const profile = profiler.profileSource(sourceDir, { mode, model_context: modelContext })
  const files = profiler.listSourceFiles(sourceDir)
  if (!files.length) throw new Error('source inventory is empty')
  const plan = workstreamPlanner.planWorkstreams({
    profile,
    files,
    sharedFiles: _sharedFiles(files),
    features: [{ slug: 'repository', domain: 'application', risk_hint: 'high', tokens: profile.est_tokens }],
    usable_context: profile.usable_context,
    quota: 'healthy',
  })
  return { sourceDir, profile, plan }
}

function buildInput(dispatch) {
  const taskId = String(dispatch.taskId)
  const mode = classifyEngagementMode(dispatch)
  if (!mode) throw new Error(`adaptive runtime does not support squad ${dispatch.squad}`)
  const scope = _scope(taskId)
  const target = _target(dispatch)
  const meta = dispatch.meta || {}
  const focus = Array.isArray(meta.focusClasses)
    ? meta.focusClasses
    : Array.isArray(meta.vulnClasses) && !meta.vulnClasses.includes('all')
      ? meta.vulnClasses
      : []
  const applicableSkills = focus.length ? focus : patternRegistry.classes()

  if (mode === 'blackbox') {
    const strategy = blackboxStrategy.phasePlan(meta)
    let host = 'target'
    try { host = new URL(target).hostname } catch {}
    return {
      taskId, mode, target, scope, goal: dispatch.goal, model: dispatch.model,
      strategy: strategy.strategy,
      applicableSkills: [...new Set([...applicableSkills, ...(meta.customFocus ? ['business-logic'] : [])])],
      workstreams: [{
        id: `application-${host.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`,
        domains: [host],
        endpoints: target ? [target] : [],
        skill_families: applicableSkills,
      }],
      activeConcurrency: 1,
    }
  }

  const source = _sourcePlan(dispatch, mode)
  const liveScope = mode === 'whitebox' && target && scope && hostAllowed(target, scope)
  return {
    taskId, mode, goal: dispatch.goal, model: dispatch.model,
    target: liveScope ? target : null,
    scope,
    sourceRoots: [source.sourceDir],
    strategy: source.plan.strategy,
    workstreams: source.plan.workstreams,
    activeConcurrency: source.plan.active_concurrency,
    applicableSkills,
    profile: source.profile,
  }
}

function shouldOwn(taskId) {
  const pinned = generations.read(taskId)
  return ['canary', 'active'].includes(pinned.runtime_generation) &&
    process.env.ARCHON_RUNTIME_PARITY_APPROVED === '1'
}

async function run(dispatch, deps = {}) {
  if (!shouldOwn(dispatch.taskId)) return { owned: false }
  const input = buildInput(dispatch)
  const result = await controller.run(input, deps)
  return { owned: true, input, result }
}

module.exports = { buildInput, shouldOwn, run }
