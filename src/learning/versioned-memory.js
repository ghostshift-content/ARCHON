
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
/**
 * Versioned Memory Store
 *
 * Inspired by Anthropic Managed Agents Memory API.
 * Every write creates a new version. Old values preserved.
 * Searchable by key, agent, time range.
 *
 * Storage: /root/intel/memory-store/
 *   - index.json     — current state (key → latest value)
 *   - versions.jsonl  — append-only version log
 *   - search-index.json — inverted index for full-text search
 */

const fs = require('fs')
const path = require('path')

const STORE_DIR = (__roots.INTEL_ROOT + '/memory-store')
const INDEX_FILE = path.join(STORE_DIR, 'index.json')
const VERSIONS_FILE = path.join(STORE_DIR, 'versions.jsonl')
const SEARCH_INDEX_FILE = path.join(STORE_DIR, 'search-index.json')

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

  // 3. Update search index (simple inverted index on words)
  updateSearchIndex(fullKey, value)

  return { version: version.v, namespace, key, fullKey }
}

/**
 * Read current value of a memory entry
 */
function read(namespace, key) {
  const index = readJSON(INDEX_FILE)
  if (!index) return null
  const fullKey = `${namespace}:${key}`
  const entry = index[fullKey]
  return entry ? entry.value : null
}

/**
 * Get version history for a key
 * @param {string} namespace
 * @param {string} key
 * @param {number} limit - max versions to return
 */
function history(namespace, key, limit = 10) {
  const fullKey = `${namespace}:${key}`
  try {
    const lines = fs.readFileSync(VERSIONS_FILE, 'utf-8').trim().split('\n')
    const versions = []
    for (let i = lines.length - 1; i >= 0 && versions.length < limit; i--) {
      try {
        const v = JSON.parse(lines[i])
        if (v.fullKey === fullKey) versions.push(v)
      } catch {}
    }
    return versions
  } catch {
    return []
  }
}

/**
 * List all keys in a namespace
 */
function list(namespace) {
  const index = readJSON(INDEX_FILE)
  if (!index) return []
  const prefix = namespace + ':'
  return Object.entries(index)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => ({
      key: k.slice(prefix.length),
      fullKey: k,
      ts: v.ts,
      agent: v.agent,
      updatedCount: v.updatedCount,
    }))
}

/**
 * Search across all memory entries
 * @param {string} query - search terms
 * @param {object} opts - { namespace, agent, after, before, limit }
 */
function search(query, opts = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const index = readJSON(INDEX_FILE)
  if (!index) return []

  const results = []
  for (const [fullKey, entry] of Object.entries(index)) {
    // Namespace filter
    if (opts.namespace && !fullKey.startsWith(opts.namespace + ':')) continue
    // Agent filter
    if (opts.agent && entry.agent !== opts.agent) continue
    // Time filters
    if (opts.after && new Date(entry.ts) < new Date(opts.after)) continue
    if (opts.before && new Date(entry.ts) > new Date(opts.before)) continue

    // Score: check if value contains search terms
    const valueStr = JSON.stringify(entry.value).toLowerCase()
    const keyStr = fullKey.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (keyStr.includes(term)) score += 3 // key match is worth more
      if (valueStr.includes(term)) score += 1
    }
    if (score > 0) {
      results.push({ fullKey, score, ts: entry.ts, agent: entry.agent, value: entry.value })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, opts.limit || 20)
}

/**
 * Delete a memory entry (soft delete — marks as deleted, version preserved)
 */
function remove(namespace, key, meta = {}) {
  const fullKey = `${namespace}:${key}`

  // Log deletion as a version
  const version = {
    v: Date.now(),
    ns: namespace,
    key,
    fullKey,
    value: null,
    deleted: true,
    agent: meta.agent || 'SYSTEM',
    reason: meta.reason || 'deleted',
    ts: new Date().toISOString(),
  }
  try {
    fs.appendFileSync(VERSIONS_FILE, JSON.stringify(version) + '\n')
  } catch {}

  // Remove from index
  const index = readJSON(INDEX_FILE) || {}
  delete index[fullKey]
  writeAtomic(INDEX_FILE, index)
}

/**
 * Get audit trail — who changed what, when
 * @param {number} limit
 */
function audit(limit = 50) {
  try {
    const lines = fs.readFileSync(VERSIONS_FILE, 'utf-8').trim().split('\n')
    const entries = []
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const v = JSON.parse(lines[i])
        entries.push({
          fullKey: v.fullKey,
          agent: v.agent,
          taskId: v.taskId,
          reason: v.reason,
          deleted: v.deleted || false,
          ts: v.ts,
        })
      } catch {}
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Get stats about the memory store
 */
function stats() {
  const index = readJSON(INDEX_FILE) || {}
  const entries = Object.keys(index).length

  // Count namespaces
  const namespaces = new Set()
  for (const key of Object.keys(index)) {
    const ns = key.split(':')[0]
    namespaces.add(ns)
  }

  // Count versions
  let versionCount = 0
  try {
    const content = fs.readFileSync(VERSIONS_FILE, 'utf-8')
    versionCount = content.split('\n').filter(Boolean).length
  } catch {}

  return {
    entries,
    namespaces: [...namespaces],
    namespaceCount: namespaces.size,
    totalVersions: versionCount,
  }
}

// Simple inverted search index update
function updateSearchIndex(fullKey, value) {
  try {
    const searchIndex = readJSON(SEARCH_INDEX_FILE) || {}
    const text = `${fullKey} ${JSON.stringify(value)}`.toLowerCase()
    const words = text.match(/\b[a-z0-9]{3,}\b/g) || []
    const unique = [...new Set(words)]

    // Remove old entries for this key
    for (const [word, keys] of Object.entries(searchIndex)) {
      searchIndex[word] = keys.filter(k => k !== fullKey)
      if (searchIndex[word].length === 0) delete searchIndex[word]
    }

    // Add new entries
    for (const word of unique) {
      if (!searchIndex[word]) searchIndex[word] = []
      if (!searchIndex[word].includes(fullKey)) searchIndex[word].push(fullKey)
    }

    writeAtomic(SEARCH_INDEX_FILE, searchIndex)
  } catch {}
}

module.exports = { write, read, history, list, search, remove, audit, stats }
