// ─── RATE LIMITING ───

module.exports = function(ctx) {
  function checkRateLimit(req, key, maxAttempts, ttlMs = 60000) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const cacheKey = `${key}:${clientIp}`;
    const attempts = ctx.cache.get(cacheKey) || { count: 0 };
    attempts.count++;
    ctx.cache.set(cacheKey, attempts, ttlMs);
    return {
      allowed: attempts.count <= maxAttempts,
      count: attempts.count,
      ip: clientIp
    };
  }

  return { checkRateLimit };
};
