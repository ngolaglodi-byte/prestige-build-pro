// ─── AUTHENTICATION MIDDLEWARE ───
// JWT token management: sign, verify, extract from request.

const jwt = require('jsonwebtoken');

module.exports = function(ctx) {
  function signToken(payload) {
    return jwt.sign(payload, ctx.config.JWT_SECRET, { expiresIn: '7d' });
  }

  function verifyToken(token) {
    try {
      // Check blacklist (logout)
      if (ctx.tokenBlacklist && ctx.tokenBlacklist.has(token)) return null;
      return jwt.verify(token, ctx.config.JWT_SECRET);
    } catch(e) {
      return null;
    }
  }

  function getAuth(req) {
    // Try Authorization header first
    const auth = req.headers?.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const decoded = verifyToken(auth.slice(7));
      if (decoded) return decoded;
    }

    // Try query parameter
    const urlParts = (req.url || '').split('?');
    if (urlParts.length > 1) {
      const params = new URLSearchParams(urlParts[1]);
      const tokenParam = params.get('token');
      if (tokenParam) {
        const decoded = verifyToken(tokenParam);
        if (decoded) return decoded;
      }
    }

    // Try cookie
    const cookies = req.headers?.cookie || '';
    const tokenCookie = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('pbp_token='));
    if (tokenCookie) {
      const decoded = verifyToken(tokenCookie.split('=')[1]);
      if (decoded) return decoded;
    }

    return null;
  }

  return { signToken, verifyToken, getAuth };
};
