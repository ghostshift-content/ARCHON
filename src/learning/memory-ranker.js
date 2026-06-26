// /root/agents/memory-ranker.js
// Universal Memory Ranking — scores lessons by relevance to current task
// Used by ALL squads, ALL agents. No external dependencies.

const fs = require('fs')
const agentPaths = require('../../paths') // Phase-1 resolver chokepoint (GATE-121)

/**
 * Score a lesson's relevance to the current task context
 * Returns 0-100 (higher = more relevant)
 */
function scoreLessonRelevance(lesson, context) {
  let score = 0
  const lessonLower = (lesson.text || '').toLowerCase()
  const targetDomain = (context.targetDomain || '').toLowerCase()
  const techStack = (context.techStack || '').toLowerCase()
  const agentName = (context.agentName || '').toLowerCase()
  const squad = (context.squad || '').toLowerCase()

  // 1. Target domain match (highest weight — same domain = very relevant)
  if (targetDomain && lesson.targetDomain) {
    const lessonDomain = lesson.targetDomain.toLowerCase()
    if (lessonDomain === targetDomain) {
      score += 40 // Exact domain match
    } else if (extractBaseDomain(lessonDomain) === extractBaseDomain(targetDomain)) {
      score += 25 // Same base domain (e.g., both *.emiratesnbd.com)
    }
  }

  // 2. Tech stack match (same tech = relevant lessons)
  if (techStack && lesson.techStack) {
    const lessonTech = lesson.techStack.toLowerCase()
    const techTerms = techStack.split(/[,\s]+/).filter(t => t.length > 2)
    const matchCount = techTerms.filter(t => lessonTech.includes(t)).length
    if (matchCount > 0) {
      score += Math.min(20, matchCount * 7) // Up to 20 points for tech match
    }
  }

  // 3. Agent relevance (lesson from same agent type = more relevant)
  if (agentName && lesson.agent) {
    if (lesson.agent.toLowerCase() === agentName) {
      score += 15 // Same agent's own lesson
    }
  }

  // 4. Recency (newer lessons = more relevant, decay over time)
  if (lesson.date) {
    const daysSince = Math.max(0, (Date.now() - new Date(lesson.date).getTime()) / (1000 * 60 * 60 * 24))
    if (daysSince < 1) score += 15       // Today
    else if (daysSince < 3) score += 12  // Last 3 days
    else if (daysSince < 7) score += 8   // Last week
    else if (daysSince < 14) score += 4  // Last 2 weeks
    // Older than 2 weeks = no recency bonus
  }

  // 5. Keyword relevance (lesson text contains task-relevant terms)
  if (context.keywords && context.keywords.length > 0) {
    const matches = context.keywords.filter(kw => lessonLower.includes(kw.toLowerCase())).length
    score += Math.min(10, matches * 3) // Up to 10 points for keyword matches
  }

  // 6. Lesson effectiveness (if tracked)
  if (lesson.hitCount !== undefined && lesson.missCount !== undefined) {
    const total = lesson.hitCount + lesson.missCount
    if (total > 0) {
      const hitRate = lesson.hitCount / total
      if (hitRate > 0.7) score += 5   // Lesson proven effective
      if (hitRate < 0.2) score -= 10  // Lesson rarely helps
    }
  }

  // 7. Archived penalty
  if (lesson.archived) {
    score -= 20 // Archived lessons get deprioritized but still findable
  }

  return Math.max(0, Math.min(100, score))
}

/**
 * Extract base domain from full domain
 * e.g., "finpro.demo.emiratesnbd.com" → "emiratesnbd.com"
 */
function extractBaseDomain(domain) {
  const parts = domain.split('.')
  if (parts.length >= 2) {
    return parts.slice(-2).join('.')
  }
  return domain
}

/**
 * Parse lessons.md into structured entries with metadata
 */
function parseLessonsFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return []
    const content = fs.readFileSync(filePath, 'utf-8')
    const sections = content.split(/^## /gm).filter(Boolean)

    return sections.map(section => {
      const lines = section.trim().split('\n')
      const header = lines[0] || ''

      // Parse date from header: "YYYY-MM-DD — Task Title (Grade: NN%)"
      const dateMatch = header.match(/(\d{4}-\d{2}-\d{2})/)
      const gradeMatch = header.match(/Grade:\s*(\d+)%/)
      const taskMatch = header.match(/—\s*(.+?)(?:\s*\(|$)/)

      // Extract target domain from task title
      const domainMatch = (taskMatch?.[1] || '').match(/([\w.-]+\.[\w.-]+\.\w{2,})/)

      // Extract metadata tags if present
      const metaMatch = section.match(/<!--\s*META:\s*({[^}]+})\s*-->/)
      let metadata = {}
      if (metaMatch) {
        try { metadata = JSON.parse(metaMatch[1]) } catch {}
      }

      return {
        text: section,
        date: dateMatch?.[1] || null,
        grade: gradeMatch ? parseInt(gradeMatch[1]) : null,
        taskTitle: taskMatch?.[1]?.trim() || '',
        targetDomain: metadata.targetDomain || domainMatch?.[1] || '',
        techStack: metadata.techStack || '',
        agent: metadata.agent || '',
        hitCount: metadata.hitCount || 0,
        missCount: metadata.missCount || 0,
        archived: metadata.archived || false,
        rules: lines.filter(l => l.includes('RULE:') || l.includes('Rule:')).map(l => l.trim())
      }
    })
  } catch {
    return []
  }
}

/**
 * Get TOP N most relevant lessons for a task context
 * This is the main function called by event-bus.js
 */
function getRelevantLessons(agentName, squad, taskContext, maxLessons = 10) {
  const agentLessonsPath = agentPaths.lessonsPath(agentName.toLowerCase())
  const squadLessonsPath = `${agentPaths.INTEL_ROOT}/squad-lessons-${squad}.md`

  // Parse both agent and squad lessons
  const agentLessons = parseLessonsFile(agentLessonsPath).map(l => ({ ...l, source: 'agent' }))
  const squadLessons = parseLessonsFile(squadLessonsPath).map(l => ({ ...l, source: 'squad' }))
  const allLessons = [...agentLessons, ...squadLessons]

  if (allLessons.length === 0) return { text: '', count: 0 }

  // Score each lesson
  const scored = allLessons.map(lesson => ({
    ...lesson,
    relevanceScore: scoreLessonRelevance(lesson, taskContext)
  }))

  // Sort by relevance (highest first)
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore)

  // Take top N
  const topLessons = scored.slice(0, maxLessons).filter(l => l.relevanceScore > 5)

  if (topLessons.length === 0) return { text: '', count: 0 }

  // Anti-bias: find counterbalance lessons (opposing outcomes for same topics)
  const counterbalances = findCounterbalances(topLessons, scored, taskContext)

  // Format as injectable text with anti-bias framing
  let text = `\n## RELEVANT LESSONS (${topLessons.length} most relevant — HYPOTHESES, not facts)
⚠️ ANTI-BIAS WARNING: These lessons are from PREVIOUS targets/stocks. They are HYPOTHESES to test, NOT conclusions to apply. Your current target is UNIQUE. Verify everything independently FIRST, then compare with past lessons.\n`

  for (const lesson of topLessons) {
    const sourceTag = lesson.source === 'agent' ? '(your lesson)' : '(squad lesson)'
    const relevanceTag = lesson.relevanceScore >= 50 ? '🔴 HIGH' : lesson.relevanceScore >= 25 ? '🟡 MED' : '🟢 LOW'

    // Anti-bias: frame lesson with specific context
    const domainNote = lesson.targetDomain && lesson.targetDomain !== (taskContext.targetDomain || '')
      ? `⚠️ From different target: ${lesson.targetDomain}. May NOT apply here.`
      : lesson.targetDomain ? `Same domain family: ${lesson.targetDomain}.` : ''

    text += `\n### ${relevanceTag} ${sourceTag} — ${lesson.date || 'unknown'}\n`
    if (domainNote) text += `${domainNote}\n`

    if (lesson.rules.length > 0) {
      text += lesson.rules.join('\n') + '\n'
    } else {
      const keyLines = lesson.text.split('\n')
        .filter(l => l.includes('❌') || l.includes('Rule:') || l.includes('RULE:') || l.includes('ALWAYS') || l.includes('NEVER'))
        .slice(0, 5)
      text += keyLines.join('\n') + '\n'
    }
  }

  // Inject counterbalances to prevent anchoring
  if (counterbalances.length > 0) {
    text += `\n### ⚖️ COUNTERBALANCE (opposing outcomes — prevent bias):\n`
    for (const cb of counterbalances) {
      text += `- On ${cb.date || '?'} (${cb.targetDomain || 'other target'}): ${cb.summary}\n`
    }
  }

  return { text, count: topLessons.length, scores: topLessons.map(l => ({ agent: l.agent, score: l.relevanceScore, date: l.date })) }
}

/**
 * Find counterbalance lessons — opposing outcomes for the same topics
 * Prevents anchoring bias by showing agents that outcomes vary
 */
function findCounterbalances(topLessons, allScored, context) {
  const counterbalances = []
  const topKeywords = new Set()

  // Extract key topics from top lessons
  for (const lesson of topLessons) {
    const words = (lesson.text || '').toLowerCase().split(/\s+/)
    const meaningful = words.filter(w =>
      w.length > 4 && !['should', 'always', 'never', 'found', 'confirmed', 'tested', 'check'].includes(w)
    )
    meaningful.forEach(w => topKeywords.add(w))
  }

  // Find lessons NOT in top set that share keywords but have different outcomes
  const topIds = new Set(topLessons.map(l => l.date + l.taskTitle))

  for (const lesson of allScored) {
    if (topIds.has(lesson.date + lesson.taskTitle)) continue // Skip same lessons
    if (counterbalances.length >= 3) break // Max 3 counterbalances

    const lessonText = (lesson.text || '').toLowerCase()
    const sharedKeywords = [...topKeywords].filter(kw => lessonText.includes(kw))

    if (sharedKeywords.length >= 2) {
      // Check if outcome is different (e.g., one says CONFIRMED, other says DISPROVEN)
      const hasConfirmed = lessonText.includes('confirmed') || lessonText.includes('works') || lessonText.includes('buy')
      const hasDisproven = lessonText.includes('disproven') || lessonText.includes('failed') || lessonText.includes('sell') || lessonText.includes('blocked')

      // Check if top lessons have opposite outcomes
      const topHasConfirmed = topLessons.some(t => {
        const tt = (t.text || '').toLowerCase()
        return tt.includes('confirmed') || tt.includes('works') || tt.includes('buy')
      })
      const topHasDisproven = topLessons.some(t => {
        const tt = (t.text || '').toLowerCase()
        return tt.includes('disproven') || tt.includes('failed') || tt.includes('sell')
      })

      // Only add if outcome is opposing
      const isOpposing = (topHasConfirmed && hasDisproven) || (topHasDisproven && hasConfirmed)
      if (isOpposing) {
        // Extract a summary line
        const summaryLine = (lesson.rules?.[0] || '').replace(/^-\s*/, '') ||
          lesson.text.split('\n').find(l => l.includes('DISPROVEN') || l.includes('CONFIRMED') || l.includes('RULE'))?.trim()?.slice(0, 120) ||
          `Different outcome on ${sharedKeywords.slice(0, 3).join(', ')}`

        counterbalances.push({
          date: lesson.date,
          targetDomain: lesson.targetDomain,
          summary: summaryLine
        })
      }
    }
  }

  return counterbalances
}

/**
 * Add metadata to a lesson entry when writing
 * Called by feedback-loop.js
 */
function formatLessonWithMetadata(lessonText, metadata) {
  const metaJson = JSON.stringify({
    targetDomain: metadata.targetDomain || '',
    techStack: metadata.techStack || '',
    agent: metadata.agent || '',
    authType: metadata.authType || '',
    hitCount: 0,
    missCount: 0,
    archived: false
  })
  return `${lessonText}\n<!-- META: ${metaJson} -->\n`
}

/**
 * Update lesson effectiveness tracking
 * Called after grading — marks lessons as hit (helped) or miss (didn't help)
 */
function updateLessonEffectiveness(agentName, taskId, gradeResult) {
  const lessonsPath = agentPaths.lessonsPath(agentName.toLowerCase())
  try {
    if (!fs.existsSync(lessonsPath)) return

    let content = fs.readFileSync(lessonsPath, 'utf-8')
    const grade = gradeResult?.passRate || 0

    // Find META tags and update hit/miss counts
    content = content.replace(/<!-- META: ({[^}]+}) -->/g, (match, jsonStr) => {
      try {
        const meta = JSON.parse(jsonStr)
        if (grade >= 85) {
          meta.hitCount = (meta.hitCount || 0) + 1
        } else {
          meta.missCount = (meta.missCount || 0) + 1
        }
        // Archive if consistently ineffective (>5 tasks, <20% hit rate)
        const total = meta.hitCount + meta.missCount
        if (total >= 5 && meta.hitCount / total < 0.2) {
          meta.archived = true
        }
        return `<!-- META: ${JSON.stringify(meta)} -->`
      } catch {
        return match
      }
    })

    fs.writeFileSync(lessonsPath, content)
  } catch {}
}

module.exports = {
  scoreLessonRelevance,
  getRelevantLessons,
  formatLessonWithMetadata,
  updateLessonEffectiveness,
  parseLessonsFile,
  extractBaseDomain
}
