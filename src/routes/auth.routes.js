// ─── AUTH ROUTES ───
// POST /api/login (no auth), POST /api/logout (auth required)

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const { signToken } = require('../middleware/auth')(ctx);
  const db = ctx.db;
  const cache = ctx.cache;

  // ─── LOGIN (NO AUTH) ───
  router.post('/api/login', async (req, res) => {
    // Rate limit: max 5 login attempts per IP per minute
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const loginKey = `login:${clientIp}`;
    const now = Date.now();
    const attempts = cache.get(loginKey) || { count: 0 };
    attempts.count++;
    cache.set(loginKey, attempts, 60000); // TTL 1 minute
    if (attempts.count > 5) {
      json(res, 429, { error: 'Trop de tentatives. Réessayez dans 1 minute.' }); return;
    }

    const {email,password}=await getBody(req);
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      json(res, 400, { error: 'Email et mot de passe requis.' }); return;
    }
    if (email.length > 200 || password.length > 200) {
      json(res, 400, { error: 'Données invalides.' }); return;
    }
    const bcrypt=require('bcryptjs');
    const u=db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
    if (!u||!bcrypt.compareSync(password,u.password)) {
      console.log(`[Auth] Failed login attempt for: ${email} from ${clientIp}`);
      if (global.auditLog) global.auditLog(req, null, 'login_failed', 'user', null, { email: email.substring(0,100) });
      json(res,401,{error:'Email ou mot de passe incorrect.'}); return;
    }
    if (u.role === 'disabled') {
      console.log(`[Auth] Blocked disabled user: ${u.email}`);
      if (global.auditLog) global.auditLog(req, u, 'login_blocked_disabled', 'user', u.id);
      json(res,403,{error:'Votre compte a été désactivé. Contactez l\'administrateur.'}); return;
    }
    console.log(`[Auth] Login: ${u.email} (${u.role})`);
    if (global.auditLog) global.auditLog(req, u, 'login_success', 'user', u.id);
    json(res,200,{token:signToken({id:u.id,email:u.email,name:u.name,role:u.role,lang:u.lang}),user:{id:u.id,email:u.email,name:u.name,role:u.role,lang:u.lang}});
  });

  // ─── LOGOUT ───
  router.post('/api/logout', async (req, res) => {
    const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (headerToken) {
      if (!global._tokenBlacklist) global._tokenBlacklist = new Set();
      global._tokenBlacklist.add(headerToken);
      // Auto-cleanup every hour
      setTimeout(() => global._tokenBlacklist?.delete(headerToken), 3600000);
    }
    json(res, 200, { ok: true, message: 'Déconnecté.' });
  });
};
