'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const agentPaths = require('../../paths')
const journal = require('./mission-journal')

const GENERATIONS = Object.freeze(['legacy', 'shadow', 'canary', 'active'])

function pinPath(taskId, dir) {
  return path.join(dir || agentPaths.INTEL_ROOT, `mission-runtime-${taskId}.json`)
}

function desiredGeneration() {
  const mode = agentPaths.runtimeV2Mode()
  return mode === 'off' ? 'legacy' : mode
}

function canarySelected(taskId, percent = Number(process.env.ARCHON_RUNTIME_CANARY_PERCENT || 10)) {
  const bounded = Math.max(0, Math.min(100, Number(percent) || 0))
  const bucket = parseInt(crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 8), 16) % 100
  return bucket < bounded
}

function pin(taskId, opts = {}) {
  const file = pinPath(taskId, opts.dir)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  let generation = opts.generation || desiredGeneration()
  if (generation === 'canary' && !canarySelected(taskId, opts.canaryPercent)) generation = 'legacy'
  if (!GENERATIONS.includes(generation)) generation = 'legacy'
  const record = { task_id: taskId, runtime_generation: generation, pinned_at: new Date().toISOString(), immutable: true }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(record, null, 2))
  try { fs.linkSync(temp, file); fs.unlinkSync(temp) } catch {
    try { fs.unlinkSync(temp) } catch {}
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return record }
  }
  journal.append(taskId, 'MISSION_PINNED', record, { dir: opts.dir, idempotencyKey: 'mission-generation' })
  return record
}

function read(taskId, dir) {
  try { return JSON.parse(fs.readFileSync(pinPath(taskId, dir), 'utf8')) } catch { return { task_id: taskId, runtime_generation: 'legacy', implicit: true } }
}

module.exports = { GENERATIONS, pinPath, desiredGeneration, canarySelected, pin, read }
