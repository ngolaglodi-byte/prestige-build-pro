// ─── MULTI-TURN CONVERSATION MEMORY ───
// Auto-summarization of conversations for extended context.
// Summaries are injected into the system prompt on each turn.

const https = require('https');

module.exports = function(ctx) {
  const SUMMARIZE_EVERY_N_TURNS = 5;
  const SUMMARY_MAX_TOKENS = 500;
  const MAX_SUMMARIES_IN_CONTEXT = 3;

  // Count messages since last summary for a project
  function getMessageCountSinceLastSummary(projectId) {
    if (!ctx.db) return 0;
    const lastSummary = ctx.db.prepare(
      'SELECT created_at FROM conversation_summaries WHERE project_id=? ORDER BY id DESC LIMIT 1'
    ).get(projectId);

    if (lastSummary) {
      return ctx.db.prepare(
        'SELECT COUNT(*) as c FROM project_messages WHERE project_id=? AND created_at > ?'
      ).get(projectId, lastSummary.created_at)?.c || 0;
    }

    return ctx.db.prepare(
      'SELECT COUNT(*) as c FROM project_messages WHERE project_id=?'
    ).get(projectId)?.c || 0;
  }

  // Check if summarization is needed
  function needsSummarization(projectId) {
    return getMessageCountSinceLastSummary(projectId) >= SUMMARIZE_EVERY_N_TURNS;
  }

  // Generate a summary of recent conversation turns using Claude Haiku
  async function summarizeConversation(projectId) {
    if (!ctx.db) return null;

    const messages = ctx.db.prepare(
      'SELECT role, content FROM project_messages WHERE project_id=? ORDER BY id DESC LIMIT 10'
    ).all(projectId).reverse();

    if (messages.length < 3) return null;

    const conversationText = messages.map(m =>
      `${m.role === 'user' ? 'Utilisateur' : 'Assistant'}: ${m.content.substring(0, 500)}`
    ).join('\n\n');

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: SUMMARY_MAX_TOKENS,
      system: 'Résume cette conversation de développement en 200 mots max. Inclus: décisions techniques prises, fonctionnalités implémentées, problèmes résolus, préférences de l\'utilisateur. Format: liste à puces concise.',
      messages: [{ role: 'user', content: conversationText }]
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 15000
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const summary = parsed.content?.[0]?.text || '';
            if (summary) {
              // Save to DB
              ctx.db.prepare(
                'INSERT INTO conversation_summaries (project_id, summary, turn_count) VALUES (?, ?, ?)'
              ).run(projectId, summary, messages.length);
              console.log(`[Memory] Saved conversation summary for project ${projectId} (${messages.length} turns)`);
              resolve(summary);
            } else {
              resolve(null);
            }
          } catch(e) {
            console.warn(`[Memory] Summary parse error: ${e.message}`);
            resolve(null);
          }
        });
      });
      req.on('error', (e) => {
        console.warn(`[Memory] Summary API error: ${e.message}`);
        resolve(null);
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  }

  // Get recent summaries for a project (for injection into system prompt)
  function getConversationSummaries(projectId) {
    if (!ctx.db) return [];
    try {
      return ctx.db.prepare(
        'SELECT summary, turn_count, created_at FROM conversation_summaries WHERE project_id=? ORDER BY id DESC LIMIT ?'
      ).all(projectId, MAX_SUMMARIES_IN_CONTEXT).reverse();
    } catch(e) {
      return [];
    }
  }

  // Build conversation history block for system prompt injection
  function buildConversationMemoryBlock(projectId) {
    const summaries = getConversationSummaries(projectId);
    const projectMemory = getProjectMemory(projectId);

    if (summaries.length === 0 && !projectMemory) return '';

    let block = '\n[MÉMOIRE DU PROJET]\n';

    if (projectMemory) {
      block += `\n**Mémoire persistante:**\n${projectMemory}\n`;
    }

    if (summaries.length > 0) {
      block += `\n**Historique des conversations (${summaries.length} résumés):**\n`;
      for (const s of summaries) {
        block += `\n--- ${s.created_at} (${s.turn_count} messages) ---\n${s.summary}\n`;
      }
    }

    return block;
  }

  // Get/set project memory (user-editable persistent notes)
  function getProjectMemory(projectId) {
    if (!ctx.db) return null;
    try {
      const row = ctx.db.prepare('SELECT content FROM project_memory WHERE project_id=?').get(projectId);
      return row?.content || null;
    } catch(e) { return null; }
  }

  function setProjectMemory(projectId, content, userId) {
    if (!ctx.db) return false;
    try {
      const existing = ctx.db.prepare('SELECT project_id FROM project_memory WHERE project_id=?').get(projectId);
      if (existing) {
        ctx.db.prepare('UPDATE project_memory SET content=?, updated_at=datetime("now"), updated_by=? WHERE project_id=?')
          .run(content, userId, projectId);
      } else {
        ctx.db.prepare('INSERT INTO project_memory (project_id, content, updated_by) VALUES (?, ?, ?)')
          .run(projectId, content, userId);
      }
      return true;
    } catch(e) {
      console.warn(`[Memory] Set error: ${e.message}`);
      return false;
    }
  }

  // Auto-summarize if needed (called after each generation)
  async function autoSummarizeIfNeeded(projectId) {
    try {
      if (needsSummarization(projectId)) {
        await summarizeConversation(projectId);
      }
    } catch(e) {
      console.warn(`[Memory] Auto-summarize error: ${e.message}`);
    }
  }

  return {
    summarizeConversation,
    getConversationSummaries,
    buildConversationMemoryBlock,
    getProjectMemory,
    setProjectMemory,
    autoSummarizeIfNeeded,
    needsSummarization
  };
};
