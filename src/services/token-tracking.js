// ─── TOKEN USAGE TRACKING & QUOTA MANAGEMENT ───

const { TOKEN_PRICING } = require('../config');

module.exports = function(ctx) {
  function classifyComplexity(operation, inputTokens, outputTokens) {
    const total = inputTokens + outputTokens;
    if (operation === 'chat') return 'chat';
    if (operation === 'auto-correct') return 'fix';
    if (operation === 'generate-plan') return 'plan';
    if (total < 5000) return 'simple';
    if (total < 20000) return 'moderate';
    if (total < 50000) return 'complex';
    return 'heavy';
  }

  function trackTokenUsage(userId, projectId, operation, model, usage) {
    if (!ctx.db || !usage) return;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;

    const pricing = TOKEN_PRICING[model] || TOKEN_PRICING['default'];
    const costUsd = (
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output +
      (cacheRead / 1_000_000) * pricing.cache_read +
      (cacheWrite / 1_000_000) * pricing.cache_write
    );
    const complexity = classifyComplexity(operation, inputTokens, outputTokens);

    try {
      ctx.db.prepare('INSERT INTO token_usage (user_id, project_id, operation, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(userId || null, projectId || null, `${operation}:${complexity}`, model, inputTokens, outputTokens, cacheRead, cacheWrite, Math.round(costUsd * 100000) / 100000);
      console.log(`[Tokens] ${operation}:${complexity} ${inputTokens}in+${outputTokens}out=$${costUsd.toFixed(4)} (u:${userId} p:${projectId})`);
    } catch (e) {
      console.error('[Tokens] Track error:', e.message);
    }
  }

  function checkUserQuota(userId) {
    if (!ctx.db) return { allowed: true };
    const user = ctx.db.prepare('SELECT role, daily_generation_limit, monthly_generation_limit FROM users WHERE id=?').get(userId);
    if (!user) return { allowed: false, reason: 'Utilisateur non trouvé.' };
    if (user.role === 'admin') return { allowed: true };

    const dailyLimit = user.daily_generation_limit || 50;
    const monthlyLimit = user.monthly_generation_limit || 500;

    const todayCount = ctx.db.prepare("SELECT COUNT(*) as c FROM token_usage WHERE user_id=? AND operation LIKE 'generate%' AND created_at >= date('now')").get(userId)?.c || 0;
    const monthCount = ctx.db.prepare("SELECT COUNT(*) as c FROM token_usage WHERE user_id=? AND operation LIKE 'generate%' AND created_at >= date('now','start of month')").get(userId)?.c || 0;

    if (todayCount >= dailyLimit) {
      return { allowed: false, reason: `Limite quotidienne atteinte (${dailyLimit} générations/jour). Réessayez demain.`, daily: todayCount, dailyLimit };
    }
    if (monthCount >= monthlyLimit) {
      return { allowed: false, reason: `Limite mensuelle atteinte (${monthlyLimit} générations/mois). Contactez l'administrateur.`, monthly: monthCount, monthlyLimit };
    }
    return { allowed: true, daily: todayCount, dailyLimit, monthly: monthCount, monthlyLimit, remaining: dailyLimit - todayCount };
  }

  return { classifyComplexity, trackTokenUsage, checkUserQuota };
};
