// ─── ADMIN ROUTES ───
// Users CRUD, API keys, admin usage, system stats, analytics, GitHub config

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const https = require('https');
  const os = require('os');
  const db = ctx.db;
  const log = ctx.log;
  const {
    checkUserQuota, isContainerRunningAsync, encryptValue, decryptValue
  } = ctx.services;
  const { containerLastAccess } = ctx;

  // ─── LIST USERS ───
  router.get('/api/users', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    json(res,200,db.prepare('SELECT id,email,name,role,lang,created_at FROM users ORDER BY created_at DESC').all());
  });

  // ─── CREATE USER ───
  router.post('/api/users', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const {email,password,name,role,lang}=await getBody(req);
    try {
      const i=db.prepare('INSERT INTO users (email,password,name,role,lang) VALUES (?,?,?,?,?)').run(email,require('bcryptjs').hashSync(password,10),name,role||'agent',lang||'fr');
      json(res,200,{id:i.lastInsertRowid,email,name,role});
    }
    catch(e){json(res,400,{error:'Email déjà utilisé.'});}
  });

  // ─── UPDATE USER ───
  router.put('/api/users/:id', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const id=parseInt(req.params.id);
    const {name,role,password,lang,active,daily_generation_limit,monthly_generation_limit}=await getBody(req);
    const existing = db.prepare('SELECT id FROM users WHERE id=?').get(id);
    if (!existing) { json(res,404,{error:'Utilisateur non trouvé.'}); return; }
    if (name) db.prepare('UPDATE users SET name=? WHERE id=?').run(name, id);
    if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    if (lang) db.prepare('UPDATE users SET lang=? WHERE id=?').run(lang, id);
    if (password) db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(password, 10), id);
    if (typeof active === 'boolean') {
      db.prepare('UPDATE users SET role=? WHERE id=?').run(active ? 'agent' : 'disabled', id);
    }
    if (daily_generation_limit !== undefined) db.prepare('UPDATE users SET daily_generation_limit=? WHERE id=?').run(daily_generation_limit, id);
    if (monthly_generation_limit !== undefined) db.prepare('UPDATE users SET monthly_generation_limit=? WHERE id=?').run(monthly_generation_limit, id);
    json(res,200,{ok:true});
  });

  // ─── USER STATS ───
  router.get('/api/users/:id/stats', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const id=parseInt(req.params.id);
    const projects = db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id=?').get(id)?.c || 0;
    const published = db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id=? AND is_published=1').get(id)?.c || 0;
    const tokensToday = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as ops FROM token_usage WHERE user_id=? AND created_at >= date('now')").get(id);
    const tokensMonth = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as ops FROM token_usage WHERE user_id=? AND created_at >= date('now','start of month')").get(id);
    const lastActivity = db.prepare("SELECT created_at FROM token_usage WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(id);
    json(res,200,{ projects, published, today: { cost: tokensToday.cost, operations: tokensToday.ops }, month: { cost: tokensMonth.cost, operations: tokensMonth.ops }, lastActivity: lastActivity?.created_at || null });
  });

  // ─── DELETE USER ───
  router.delete('/api/users/:id', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const targetId = parseInt(req.params.id);
    const targetUser = db.prepare('SELECT email FROM users WHERE id=?').get(targetId);
    db.prepare('DELETE FROM users WHERE id=?').run(targetId);
    if (global.auditLog) global.auditLog(req, user, 'user_deleted', 'user', targetId, { email: targetUser?.email });
    json(res,200,{ok:true});
  });

  // ─── API KEYS ───
  router.get('/api/apikeys', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    json(res,200,db.prepare('SELECT id,name,service,description,created_at FROM api_keys').all());
  });

  router.get('/api/apikeys/names', async (req, res) => {
    json(res,200,db.prepare('SELECT name,service,description FROM api_keys').all());
  });

  router.post('/api/apikeys', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const {name,service,key_value,description}=await getBody(req);
    const i=db.prepare('INSERT INTO api_keys (name,service,key_value,description) VALUES (?,?,?,?)').run(name,service,key_value,description);
    json(res,200,{id:i.lastInsertRowid});
  });

  router.delete('/api/apikeys/:id', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    db.prepare('DELETE FROM api_keys WHERE id=?').run(parseInt(req.params.id));
    json(res,200,{ok:true});
  });

  // ─── ADMIN: USAGE DASHBOARD ───
  router.get('/api/admin/usage', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const today = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls FROM token_usage WHERE created_at >= date('now')").get();
    const month = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls FROM token_usage WHERE created_at >= date('now','start of month')").get();
    const byUser = db.prepare("SELECT u.email, u.name, COUNT(*) as calls, COALESCE(SUM(t.input_tokens),0) as inp, COALESCE(SUM(t.output_tokens),0) as out, COALESCE(SUM(t.cost_usd),0) as cost FROM token_usage t LEFT JOIN users u ON t.user_id=u.id WHERE t.created_at >= date('now','start of month') GROUP BY t.user_id ORDER BY cost DESC").all();
    const byProject = db.prepare("SELECT p.title, t.project_id, COUNT(*) as calls, COALESCE(SUM(t.input_tokens),0) as inp, COALESCE(SUM(t.output_tokens),0) as out, COALESCE(SUM(t.cost_usd),0) as cost FROM token_usage t LEFT JOIN projects p ON t.project_id=p.id WHERE t.created_at >= date('now','start of month') AND t.project_id IS NOT NULL GROUP BY t.project_id ORDER BY cost DESC LIMIT 20").all();
    const recentCalls = db.prepare("SELECT t.*, u.email FROM token_usage t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.id DESC LIMIT 50").all();
    const byComplexity = db.prepare("SELECT operation, COUNT(*) as calls, COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE created_at >= date('now','start of month') GROUP BY operation ORDER BY cost DESC").all();
    json(res, 200, {
      today: { input_tokens: today.inp, output_tokens: today.out, cost_usd: Math.round(today.cost * 10000) / 10000, api_calls: today.calls },
      month: { input_tokens: month.inp, output_tokens: month.out, cost_usd: Math.round(month.cost * 10000) / 10000, api_calls: month.calls },
      by_complexity: byComplexity.map(c => ({ ...c, cost: Math.round(c.cost * 10000) / 10000 })),
      by_user: byUser.map(u => ({ ...u, cost: Math.round(u.cost * 10000) / 10000 })),
      by_project: byProject.map(p => ({ ...p, cost: Math.round(p.cost * 10000) / 10000 })),
      recent: recentCalls.slice(0, 20)
    });
  });

  // ─── ADMIN SYSTEM STATS ───
  router.get('/api/admin/system', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const cpus = os.cpus();
    const projects = db.prepare("SELECT id, title, build_status, is_published FROM projects WHERE build_status='done'").all();
    const containers = [];
    for (const p of projects) {
      const running = await isContainerRunningAsync(p.id);
      const lastAccess = containerLastAccess.get(p.id);
      containers.push({
        id: p.id, title: p.title, running, published: !!p.is_published,
        lastAccess: lastAccess ? new Date(lastAccess).toISOString() : null,
        sleeping: !running && !p.is_published
      });
    }
    json(res, 200, {
      memory: { total: totalMem, free: freeMem, used: totalMem - freeMem, percent: usedPercent, server: mem },
      cpu: { cores: cpus.length, model: cpus[0]?.model },
      uptime: Math.round(process.uptime()),
      containers,
      alert: usedPercent > 75 ? `RAM à ${usedPercent}% — envisagez un upgrade` : null
    });
  });

  // ─── ADMIN: GLOBAL ANALYTICS ───
  router.get('/api/admin/analytics', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const totalPageviews = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type='pageview'").get()?.c || 0;
    const todayPageviews = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type='pageview' AND created_at >= date('now')").get()?.c || 0;
    const uniqueVisitorsMonth = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE event_type='pageview' AND created_at >= date('now','start of month')").get()?.c || 0;
    const topProjects = db.prepare(`
      SELECT p.title, p.id, COUNT(*) as views
      FROM analytics a JOIN projects p ON a.project_id=p.id
      WHERE a.event_type='pageview' AND a.created_at >= date('now','-30 days')
      GROUP BY a.project_id ORDER BY views DESC LIMIT 10
    `).all();
    const dailyTrend = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as views, COUNT(DISTINCT ip_address) as visitors
      FROM analytics WHERE event_type='pageview' AND created_at >= date('now','-30 days')
      GROUP BY DATE(created_at) ORDER BY date DESC
    `).all();
    json(res, 200, {
      total: { pageviews: totalPageviews, todayPageviews, uniqueVisitorsMonth },
      topProjects, dailyTrend
    });
  });

  // ─── ADMIN: ACTIVITY ───
  router.get('/api/admin/activity', async (req, res) => {
    const user = req.user;
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const activity = db.prepare(`
      SELECT t.operation, t.cost_usd, t.created_at, u.name as user_name, p.title as project_title
      FROM token_usage t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN projects p ON t.project_id = p.id
      ORDER BY t.created_at DESC LIMIT 50
    `).all();
    json(res, 200, activity);
  });

  // ─── GITHUB CONFIG ───
  router.get('/api/admin/github/config', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const cfg = db.prepare('SELECT github_username, github_org, updated_at FROM github_config WHERE id=1').get();
    json(res, 200, cfg || { github_username: '', github_org: '' });
  });

  router.post('/api/admin/github/config', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const { github_token, github_username, github_org } = await getBody(req);
    if (!github_token || !github_username) { json(res, 400, { error: 'Token et username requis.' }); return; }
    const encrypted = encryptValue(github_token);
    db.prepare('INSERT OR REPLACE INTO github_config (id, github_token, github_username, github_org, updated_at) VALUES (1,?,?,?,datetime("now"))').run(encrypted, github_username, github_org || '');
    json(res, 200, { ok: true });
  });

  router.post('/api/admin/github/test', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const cfg = db.prepare('SELECT github_token, github_username FROM github_config WHERE id=1').get();
    if (!cfg) { json(res, 404, { error: 'GitHub non configuré.' }); return; }
    try {
      const tok = decryptValue(cfg.github_token);
      const r = await new Promise((resolve, reject) => {
        const req = https.get('https://api.github.com/user', { headers: { 'Authorization': `token ${tok}`, 'User-Agent': 'PrestigeBuildPro' } }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, data: d }));
        }); req.on('error', reject);
      });
      if (r.status === 200) {
        const u = JSON.parse(r.data);
        json(res, 200, { ok: true, login: u.login, name: u.name });
      } else { json(res, 401, { error: 'Token GitHub invalide.' }); }
    } catch (e) { json(res, 500, { error: e.message }); }
  });
};
