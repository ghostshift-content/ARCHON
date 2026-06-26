
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/attack-graph.js
// Level 3: Lightweight Attack Graph — enables multi-hop chain reasoning
// Pure JS, no external dependencies (no Neo4j needed)
// Universal: works for all squads

const fs = require('fs')
const path = require('path')

const INTEL_DIR = __roots.INTEL_ROOT

/**
 * Node types in the attack graph
 */
const NODE_TYPES = {
  // Universal
  ASSET: 'asset',           // URL, endpoint, service (pentest) / Company, ticker (stocks)
  FINDING: 'finding',       // Vulnerability (pentest) / Risk factor (stocks)
  TECHNIQUE: 'technique',   // Attack technique (pentest) / Analysis method (stocks)
  IMPACT: 'impact',         // Business impact (universal)
  // Pentest-specific
  VULN: 'vuln',             // Alias for finding (backward compat)
  CREDENTIAL: 'credential', // Discovered credential/token
  // Stocks-specific
  METRIC: 'metric',         // Financial metric (PE, ROE, etc.)
  CATALYST: 'catalyst',     // Growth catalyst or risk trigger
  SECTOR: 'sector',         // Industry sector
}

/**
 * Edge types connecting nodes
 */
const EDGE_TYPES = {
  HAS_VULN: 'has_vuln',           // asset → vuln
  EXPLOITED_BY: 'exploited_by',   // vuln → technique
  LEADS_TO: 'leads_to',           // vuln → impact OR vuln → vuln (chain)
  DISCOVERED_ON: 'discovered_on', // vuln → asset
  ENABLES: 'enables',             // vuln → vuln (chaining)
  BACKEND_OF: 'backend_of',       // asset → asset
  REDIRECTS_TO: 'redirects_to',   // asset → asset
  AUTHENTICATED_BY: 'authenticated_by', // asset → credential
}

class AttackGraph {
  constructor(taskId) {
    this.taskId = taskId
    this.nodes = new Map() // id → {type, label, properties}
    this.edges = []        // [{from, to, type, label}]
    this.filePath = path.join(INTEL_DIR, `attack-graph-${taskId}.json`)
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
        this.nodes = new Map(Object.entries(data.nodes || {}))
        this.edges = data.edges || []
      }
    } catch {}
  }

  save() {
    const data = {
      taskId: this.taskId,
      nodes: Object.fromEntries(this.nodes),
      edges: this.edges,
      stats: {
        nodeCount: this.nodes.size,
        edgeCount: this.edges.length,
        updatedAt: new Date().toISOString(),
      }
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2))
  }

  addNode(id, type, label, properties = {}) {
    this.nodes.set(id, { type, label, properties, addedAt: new Date().toISOString() })
    return this
  }

  addEdge(from, to, type, label = '', weight = 1.0) {
    // Deduplicate
    const exists = this.edges.some(e => e.from === from && e.to === to && e.type === type)
    if (!exists) {
      this.edges.push({ from, to, type, label, weight, cost: weight, addedAt: new Date().toISOString() })
    }
    return this
  }

  /**
   * Mark a node as validated — reduces cost of connected edges by 50%
   * Called after AUDITOR confirms a finding
   */
  validateNode(nodeId) {
    const node = this.nodes.get(nodeId)
    if (!node) return
    node.properties = node.properties || {}
    node.properties.validated = true
    node.properties.validatedAt = new Date().toISOString()

    // Reduce cost of all edges connected to this node
    for (const edge of this.edges) {
      if (edge.from === nodeId || edge.to === nodeId) {
        edge.cost = (edge.weight || 1.0) * 0.5 // Validated = 50% cheaper
      }
    }
  }

  /**
   * Compute edge cost based on severity + validation
   */
  static computeCost(severity, validated = false) {
    const severityMult = { critical: 0.4, high: 0.6, medium: 1.0, low: 1.6, info: 2.5 }
    const base = severityMult[severity] || 1.0
    return validated ? base * 0.5 : base
  }

  /**
   * Find all paths between two nodes (BFS, max depth)
   */
  /**
   * Find paths with cost tracking (cost-weighted BFS)
   */
  findPaths(startId, endId, maxDepth = 5, maxCost = 20.0) {
    const paths = []
    const queue = [{ path: [startId], totalCost: 0 }]

    while (queue.length > 0) {
      const { path: currentPath, totalCost } = queue.shift()
      const currentNode = currentPath[currentPath.length - 1]

      if (currentPath.length > maxDepth) continue
      if (totalCost > maxCost) continue

      if (currentNode === endId && currentPath.length > 1) {
        paths.push({ path: currentPath, totalCost })
        continue
      }

      // Find adjacent nodes with edge costs
      const outEdges = this.edges.filter(e => e.from === currentNode && !currentPath.includes(e.to))
      for (const edge of outEdges) {
        queue.push({
          path: [...currentPath, edge.to],
          totalCost: totalCost + (edge.cost || edge.weight || 1.0)
        })
      }
    }

    // Sort by cost (cheapest = easiest to exploit)
    paths.sort((a, b) => a.totalCost - b.totalCost)
    return paths
  }

  /**
   * Find all attack chains — paths from any asset to any impact
   */
  findAttackChains() {
    const assets = [...this.nodes.entries()].filter(([_, n]) => n.type === NODE_TYPES.ASSET).map(([id]) => id)
    const impacts = [...this.nodes.entries()].filter(([_, n]) => n.type === NODE_TYPES.IMPACT).map(([id]) => id)
    const chains = []

    for (const asset of assets) {
      for (const impact of impacts) {
        const pathResults = this.findPaths(asset, impact, 6, 20.0)
        for (const { path, totalCost } of pathResults) {
          const nodes = path.map(id => this.nodes.get(id))
          const vulns = nodes.filter(n => n && (n.type === NODE_TYPES.VULN || n.type === NODE_TYPES.FINDING))
          const validatedCount = vulns.filter(v => v?.properties?.validated).length
          if (vulns.length >= 2) { // Only multi-hop chains
            chains.push({
              path,
              nodes: path.map(id => ({ id, ...this.nodes.get(id) })),
              hops: path.length - 1,
              vulnCount: vulns.length,
              validatedCount,
              totalCost,
              severity: totalCost < 2.0 ? 'CRITICAL' : totalCost < 5.0 ? 'HIGH' : 'MEDIUM',
              description: `${nodes[0]?.label} → ${vulns.map(v => v?.label).join(' → ')} → ${nodes[nodes.length - 1]?.label}`
            })
          }
        }
      }
    }

    // Deduplicate: chains sharing same vulns are near-duplicates — keep unique vuln combinations
    const seen = new Set()
    const unique = []
    for (const chain of chains) {
      const vulnKey = chain.nodes
        .filter(n => n.type === NODE_TYPES.VULN)
        .map(n => n.label?.slice(0, 40))
        .sort()
        .join('|')
      if (!seen.has(vulnKey)) {
        seen.add(vulnKey)
        unique.push(chain)
      }
    }

    // Sort by vuln count (more hops = more interesting), cap at 15
    unique.sort((a, b) => b.vulnCount - a.vulnCount)
    return unique.slice(0, 15)
  }

  /**
   * Get graph summary for agent context injection
   */
  getSummary() {
    if (this.nodes.size === 0) return ''

    const assets = [...this.nodes.values()].filter(n => n.type === NODE_TYPES.ASSET)
    const vulns = [...this.nodes.values()].filter(n => n.type === NODE_TYPES.VULN)
    const impacts = [...this.nodes.values()].filter(n => n.type === NODE_TYPES.IMPACT)
    const chains = this.findAttackChains()

    let summary = `\n## ATTACK GRAPH (${this.nodes.size} nodes, ${this.edges.length} edges)\n`
    summary += `Assets: ${assets.length} | Vulns: ${vulns.length} | Impacts: ${impacts.length}\n`

    if (chains.length > 0) {
      summary += `\n### MULTI-HOP ATTACK CHAINS (${chains.length}):\n`
      for (const chain of chains.slice(0, 5)) {
        summary += `- [${chain.severity}] ${chain.description} (${chain.hops} hops)\n`
      }
    }

    return summary
  }
}

/**
 * Build attack graph from structured findings (live-findings file)
 * Called after Phase 2 completes
 */
function buildGraphFromFindings(taskId, targetUrl) {
  const findingsFile = path.join(INTEL_DIR, `live-findings-${taskId}.jsonl`)
  if (!fs.existsSync(findingsFile)) return null

  const graph = new AttackGraph(taskId)

  // Add main target as root asset
  graph.addNode(`asset-${targetUrl}`, NODE_TYPES.ASSET, targetUrl, { primary: true })

  const lines = fs.readFileSync(findingsFile, 'utf-8').trim().split('\n').filter(Boolean)

  for (const line of lines) {
    try {
      const finding = JSON.parse(line)
      const url = finding.url || targetUrl
      const agent = finding.agent || '?'
      const type = finding.type || 'unknown'
      const details = finding.details || ''
      const severity = finding.severity || 'info'

      // Add discovered asset
      const assetId = `asset-${url}`
      graph.addNode(assetId, NODE_TYPES.ASSET, url, { discoveredBy: agent })

      // Add relationship to parent if different
      if (finding.relation && finding.parent) {
        const parentId = `asset-${finding.parent}`
        graph.addNode(parentId, NODE_TYPES.ASSET, finding.parent)
        graph.addEdge(parentId, assetId, EDGE_TYPES[finding.relation.toUpperCase().replace(/-/g, '_')] || EDGE_TYPES.LEADS_TO, finding.relation)
      }

      // Add vulnerability node
      if (type === 'confirmed' || type === 'suspected') {
        const vulnId = `vuln-${agent}-${url}-${Date.now()}`
        graph.addNode(vulnId, NODE_TYPES.VULN, details.slice(0, 100), { agent, severity, url, fullDetails: details })
        graph.addEdge(assetId, vulnId, EDGE_TYPES.HAS_VULN)

        // Infer impact from severity
        if (severity === 'critical' || severity === 'high') {
          const impactId = `impact-${severity}-${vulnId}`
          const impactLabel = severity === 'critical' ? 'Full compromise / data theft' : 'Significant data access / manipulation'
          graph.addNode(impactId, NODE_TYPES.IMPACT, impactLabel, { severity })
          graph.addEdge(vulnId, impactId, EDGE_TYPES.LEADS_TO)
        }

        // Chain vulns on same asset (vuln A enables vuln B)
        const existingVulns = [...graph.nodes.entries()]
          .filter(([id, n]) => n.type === NODE_TYPES.VULN && n.properties?.url === url && id !== vulnId)
        for (const [existingId] of existingVulns) {
          graph.addEdge(existingId, vulnId, EDGE_TYPES.ENABLES, 'same-surface')
        }
      }
    } catch {}
  }

  graph.save()
  return graph
}

/**
 * Format attack chains for ATLAS chain analysis injection
 */
function formatChainsForAnalysis(graph) {
  if (!graph || graph.nodes.size === 0) return ''

  const chains = graph.findAttackChains()
  if (chains.length === 0) return ''

  let text = `\n## GRAPH-DERIVED ATTACK CHAINS (auto-discovered from ${graph.nodes.size} nodes):\n`
  text += `These chains were found by analyzing relationships between findings. Verify each chain.\n\n`

  for (const chain of chains.slice(0, 10)) {
    text += `### [${chain.severity}] ${chain.hops}-hop chain:\n`
    text += `Path: ${chain.description}\n`
    text += `Vulns involved: ${chain.vulnCount}\n\n`
  }

  return text
}

/**
 * Update graph with AUDITOR validation results — marks validated nodes, reduces costs
 * Called after AUDITOR phase completes
 */
function updateGraphWithValidation(taskId) {
  const graphFile = path.join(INTEL_DIR, `attack-graph-${taskId}.json`)
  if (!fs.existsSync(graphFile)) return null

  const graph = new AttackGraph(taskId)
  const activityLog = path.join(INTEL_DIR, 'ACTIVITY-LOG.jsonl')
  if (!fs.existsSync(activityLog)) return graph

  // Find AUDITOR confirmed findings
  const lines = fs.readFileSync(activityLog, 'utf-8').split('\n').filter(Boolean)
  const auditorConfirmed = []
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      if (String(e.taskId) !== String(taskId)) continue
      if (e.agent === 'AUDITOR' && (e.action || '').includes('CONFIRMED')) {
        auditorConfirmed.push(e.action)
      }
    } catch {}
  }

  if (auditorConfirmed.length === 0) return graph

  // Match AUDITOR confirmations to graph nodes and validate them
  let validatedCount = 0
  for (const [nodeId, node] of graph.nodes) {
    if (node.type !== NODE_TYPES.VULN && node.type !== NODE_TYPES.FINDING) continue
    if (node.properties?.validated) continue // Already validated

    const nodeLabel = (node.label || '').toLowerCase()
    // Check if any AUDITOR confirmation matches this node
    for (const confirmation of auditorConfirmed) {
      const confLower = confirmation.toLowerCase()
      // Match by keywords overlap
      const nodeWords = nodeLabel.split(/\s+/).filter(w => w.length > 4)
      const confWords = confLower.split(/\s+/).filter(w => w.length > 4)
      const overlap = nodeWords.filter(w => confWords.some(cw => cw.includes(w) || w.includes(cw)))
      if (overlap.length >= 2) {
        graph.validateNode(nodeId)
        validatedCount++
        break
      }
    }
  }

  graph.save()
  return { graph, validatedCount, totalauditor: auditorConfirmed.length }
}

/**
 * Build graph from stock analysis findings (activity log)
 * Universal: works for any stock
 */
function buildGraphFromStockFindings(taskId, stockName) {
  const activityLog = path.join(INTEL_DIR, 'ACTIVITY-LOG.jsonl')
  if (!fs.existsSync(activityLog)) return null

  const graph = new AttackGraph(taskId)

  // Add stock as root asset
  graph.addNode(`stock-${stockName}`, NODE_TYPES.ASSET, stockName, { type: 'stock', primary: true })

  const lines = fs.readFileSync(activityLog, 'utf-8').split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      if (String(e.taskId) !== String(taskId)) continue
      const action = (e.action || '').toLowerCase()
      const agent = e.agent || '?'
      const details = e.details || ''

      // Extract metrics
      if (action.includes('p/e') || action.includes('pe ratio') || action.includes('roe') || action.includes('roce')) {
        const metricId = `metric-${agent}-${Date.now()}`
        graph.addNode(metricId, NODE_TYPES.METRIC, (e.action || '').slice(0, 80), { agent })
        graph.addEdge(`stock-${stockName}`, metricId, 'has_metric')
      }

      // Extract risks/catalysts
      if (action.includes('risk') || action.includes('bearish') || action.includes('concern') || action.includes('weakness')) {
        const riskId = `risk-${agent}-${Date.now()}`
        graph.addNode(riskId, NODE_TYPES.FINDING, (e.action || '').slice(0, 80), { agent, signal: 'bearish' })
        graph.addEdge(`stock-${stockName}`, riskId, 'has_risk')
        const impactId = `impact-risk-${riskId}`
        graph.addNode(impactId, NODE_TYPES.IMPACT, 'Price decline / valuation compression', { signal: 'bearish' })
        graph.addEdge(riskId, impactId, EDGE_TYPES.LEADS_TO)
      }

      if (action.includes('catalyst') || action.includes('bullish') || action.includes('growth') || action.includes('strength')) {
        const catId = `catalyst-${agent}-${Date.now()}`
        graph.addNode(catId, NODE_TYPES.CATALYST, (e.action || '').slice(0, 80), { agent, signal: 'bullish' })
        graph.addEdge(`stock-${stockName}`, catId, 'has_catalyst')
      }
    } catch {}
  }

  graph.save()
  return graph
}

/**
 * Get graph context for specialist agent injection
 * Makes graph data available to Phase 2+ agents during testing
 */
function getGraphContextForAgent(taskId) {
  const graphFile = path.join(INTEL_DIR, `attack-graph-${taskId}.json`)
  if (!fs.existsSync(graphFile)) return ''

  try {
    const graph = new AttackGraph(taskId)
    return graph.getSummary()
  } catch {
    return ''
  }
}

module.exports = {
  AttackGraph,
  buildGraphFromFindings,
  buildGraphFromStockFindings,
  updateGraphWithValidation,
  formatChainsForAnalysis,
  getGraphContextForAgent,
  NODE_TYPES,
  EDGE_TYPES,
}
