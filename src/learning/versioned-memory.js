
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
/**
 * Versioned Memory Store
 *
 * Inspired by Anthropic Managed Agents Memory API.
 * Every write creates a new version. Old values preserved.
 *
 * Storage: /root/intel/memory-store/
 *   - index.json     — current state (key → latest value)
 *   - versions.jsonl  — append-only version log
 */

const fs = require('fs')
const path = require('path')

const STORE_DIR = (__roots.INTEL_ROOT + '/memory-store')
const INDEX_FILE = path.join(STORE_DIR, 'index.json')
const VERSIONS_FILE = path.join(STORE_DIR, 'versions.jsonl')

// Ensure store directory exists
function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true })
  }
}

// Atomic write
function writeAtomic(file, data) {
  const tmp = file + '.tmp.' + process.pid + '.' + Date.now()
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

// Read JSON safely
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

/**
 * Write a memory entry with versioning
 * @param {string} namespace - e.g., 'squad:stocks', 'agent:chanakya', 'system'
 * @param {string} key - e.g., 'TCS-analysis', 'lesson-pe-ratio'
 * @param {any} value - the data to store
 * @param {object} meta - { agent, taskId, reason }
 * @returns {object} - { version, namespace, key }
 */
function write(namespace, key, value, meta = {}) {
  ensureDir()

  const fullKey = `${namespace}:${key}`
  const version = {
    v: Date.now(),
    ns: namespace,
    key,
    fullKey,
    value,
    agent: meta.agent || 'SYSTEM',
    taskId: meta.taskId || null,
    reason: meta.reason || null,
    ts: new Date().toISOString(),
  }

  // 1. Append to versions log (append-only, never loses data)
  try {
    fs.appendFileSync(VERSIONS_FILE, JSON.stringify(version) + '\n')
  } catch (e) {
    // First write — file might not exist
    fs.writeFileSync(VERSIONS_FILE, JSON.stringify(version) + '\n')
  }

  // 2. Update current index
  const index = readJSON(INDEX_FILE) || {}
  index[fullKey] = {
    value,
    v: version.v,
    ts: version.ts,
    agent: version.agent,
    updatedCount: (index[fullKey]?.updatedCount || 0) + 1,
  }
  writeAtomic(INDEX_FILE, index)

  return { version: version.v, namespace, key, fullKey }
}

module.exports = { write }
