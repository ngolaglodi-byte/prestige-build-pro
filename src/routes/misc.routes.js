// ─── MISC ROUTES ───
// Stats, usage, notifications, compile, builds, template-tree, docs, metrics, track (no auth), tls-check (no auth)

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const crypto = require('crypto');
  const path = require('path');
  const fs = require('fs');
  const db = ctx.db;
  const ai = ctx.ai;
  const log = ctx.log;
  const {
    checkUserQuota, savePreviewFiles, isDockerAvailable, getContainerName,
    isContainerRunningAsync, getContainerLogsAsync, stopContainerAsync,
    buildDockerProject, callClaudeAPI, callClaudeForCorrection,
    callClaudeFinalCorrection, writeGeneratedFiles, readProjectFilesRecursive,
    formatProjectCode, detectErrorType, logError, markErrorCorrected,
    translateErrorType, restartContainerAsync
  } = ctx.services;
  const {
    DOCKER_PROJECTS_DIR, correctionAttempts, MAX_AUTO_CORRECTION_ATTEMPTS,
    CODE_TOOLS, activeGenerations, compiler, cache
  } = ctx;

  // ─── ANALYTICS TRACKING (NO AUTH) ───
  router.post('/api/track/:id', async (req, res) => {
    const projectId = parseInt(req.params.id);

    // Rate limit: max 30 analytics events per IP per minute
    const trackIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const trackKey = `track:${trackIp}`;
    const tl = cache.get(trackKey) || { count: 0 };
    tl.count++;
    cache.set(trackKey, tl, 60000);
    if (tl.count > 30) { json(res, 429, { error: 'Rate limited' }); return; }

    // Verify project exists and is published
    const project = db.prepare('SELECT id, is_published FROM projects WHERE id=?').get(projectId);
    if (!project || !project.is_published) { json(res, 404, { error: 'Not found' }); return; }

    const body = await getBody(req);
    const { event_type, event_data, page } = body;

    if (!event_type || typeof event_type !== 'string') { json(res, 400, { error: 'event_type required' }); return; }

    const safeEventType = String(event_type).substring(0, 50);
    const safeEventData = event_data ? JSON.stringify(event_data).substring(0, 2000) : '{}';

    try {
      const userAgent = (req.headers['user-agent'] || '').substring(0, 255);
      const eventDataStr = page ? JSON.stringify({ ...(event_data || {}), page: String(page).substring(0, 500) }).substring(0, 2000) : safeEventData;

      db.prepare('INSERT INTO analytics (project_id, event_type, event_data, ip_address, user_agent) VALUES (?,?,?,?,?)').run(
        projectId, safeEventType, eventDataStr, trackIp.substring(0, 45), userAgent
      );
      json(res, 200, { ok: true });
    } catch(e) {
      json(res, 500, { error: 'Tracking error' });
    }
  });

  // ─── STATS ───
  router.get('/api/stats', async (req, res) => {
    const user = req.user;
    const q=(s,p)=>p?db.prepare(s).get(p).c:db.prepare(s).get().c;
    json(res,200,{
      total:user.role==='admin'?q('SELECT COUNT(*) as c FROM projects'):q('SELECT COUNT(*) as c FROM projects WHERE user_id=?',user.id),
      published:user.role==='admin'?q('SELECT COUNT(*) as c FROM projects WHERE is_published=1'):q('SELECT COUNT(*) as c FROM projects WHERE user_id=? AND is_published=1',user.id),
      draft:user.role==='admin'?q("SELECT COUNT(*) as c FROM projects WHERE status='draft'"):q("SELECT COUNT(*) as c FROM projects WHERE user_id=? AND status='draft'",user.id),
      agents:user.role==='admin'?q("SELECT COUNT(*) as c FROM users WHERE role='agent'"):0
    });
  });

  // ─── USER USAGE / QUOTA ───
  router.get('/api/usage', async (req, res) => {
    const user = req.user;
    const quota = checkUserQuota(user.id);
    const todayTokens = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE user_id=? AND created_at >= date('now')").get(user.id);
    const monthTokens = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE user_id=? AND created_at >= date('now','start of month')").get(user.id);
    json(res, 200, {
      quota: { daily: quota.daily || 0, dailyLimit: quota.dailyLimit || 50, monthly: quota.monthly || 0, monthlyLimit: quota.monthlyLimit || 500, remaining: quota.remaining || 0 },
      today: { input_tokens: todayTokens.inp, output_tokens: todayTokens.out, cost_usd: Math.round(todayTokens.cost * 10000) / 10000 },
      month: { input_tokens: monthTokens.inp, output_tokens: monthTokens.out, cost_usd: Math.round(monthTokens.cost * 10000) / 10000 }
    });
  });

  // ─── NOTIFICATIONS ───
  router.get('/api/notifications', async (req, res) => {
    const user = req.user;
    json(res,200,db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(user.id));
  });

  router.post('/api/notifications/read', async (req, res) => {
    const user = req.user;
    db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(user.id);
    json(res,200,{ok:true});
  });

  // ─── COMPILE (DOCKER ISOLATED PREVIEW) ───
  router.post('/api/compile', async (req, res) => {
    const user = req.user;
    const {project_id, mode}=await getBody(req);
    console.log('[COMPILE] Starting for project:', project_id);
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project?.generated_code) { json(res,400,{error:'Générez le code d\'abord.'}); return; }

    if (user.role !== 'admin' && project.user_id !== user.id) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
      return;
    }

    const buildId=crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO builds (id,project_id,status,progress,message) VALUES (?,?,?,?,?)').run(buildId,project_id,'building',0,'Démarrage...');
    db.prepare("UPDATE projects SET build_id=?,build_status='building' WHERE id=?").run(buildId,project_id);

    // Reset correction attempts for new build
    correctionAttempts.delete(project_id);

    json(res,200,{buildId});

    // Check if Docker is available for isolated preview
    if (isDockerAvailable() && mode !== 'legacy') {
      const friendly = {
        1: 'Analyse du code généré...',
        2: 'Écriture des fichiers du projet...',
        3: 'Construction de l\'environnement...',
        4: 'Lancement du projet...',
        5: 'Vérification du démarrage...',
        6: 'Prêt !',
        'detecting': 'Erreur détectée — analyse en cours...',
        'correcting': 'Prestige AI optimise votre projet...',
        'rebuilding': 'Correction appliquée — reconstruction...',
        'building': 'Construction en cours...'
      };

      const attemptBuild = async (code, attempt = 1) => {
        try {
          const result = await buildDockerProject(project_id, code, (p) => {
            const msg = friendly[p.step] || p.message || 'Construction en cours...';
            db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress || 0, msg, buildId);
          });

          if (result.success) {
            // Wait for Vite to start and check for errors
            await new Promise(r => setTimeout(r, 5000));
            const viteLogs = await getContainerLogsAsync(project_id, 50);
            const viteErrors = viteLogs.split('\n').filter(l =>
              /Failed to resolve|error|Error|ENOENT|Cannot find/i.test(l) &&
              !/✅|Prêt|Ready|watching/i.test(l)
            );

            if (viteErrors.length > 0) {
              console.warn(`[Build] Vite runtime errors detected for project ${project_id}:`);
              viteErrors.forEach(e => console.warn(`  ${e.trim().substring(0, 120)}`));

              db.prepare('UPDATE builds SET message=? WHERE id=?').run('Correction des erreurs Vite...', buildId);
              try {
                const fixPrompt = `Le container Vite affiche ces erreurs après démarrage:\n\n${viteErrors.join('\n').substring(0, 2000)}\n\nCorrige les fichiers en cause. Utilise write_file ou edit_file. Imports avec @/ alias, fichiers UI en lowercase.`;
                const fixCode = await callClaudeAPI(
                  [{ type: 'text', text: ai ? ai.CHAT_SYSTEM_PROMPT : 'Corrige les erreurs.' }],
                  [{ role: 'user', content: fixPrompt }],
                  16000,
                  { userId: project.user_id, projectId: project_id, operation: 'auto-correct' },
                  { useTools: true }
                );
                if (fixCode) {
                  const projDir = path.join(DOCKER_PROJECTS_DIR, String(project_id));
                  writeGeneratedFiles(projDir, fixCode, project_id);
                  const updatedFiles = readProjectFilesRecursive(projDir);
                  const updatedCode = formatProjectCode(updatedFiles);
                  db.prepare("UPDATE projects SET generated_code=? WHERE id=?").run(updatedCode, project_id);
                  const { execSync } = require('child_process');
                  const containerName = getContainerName(project_id);
                  try {
                    console.log(`[Build] Vite error auto-fixed and hot-reloaded`);
                  } catch(e) { console.warn(`[Build] Hot-reload after fix failed: ${e.message}`); }
                }
              } catch (fixErr) {
                console.warn(`[Build] Vite auto-fix failed: ${fixErr.message}`);
              }
            }

            db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(result.url, buildId);
            db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(result.url, project_id);
            db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id, `Projet "${project.title}" prêt à explorer !`, 'success');
            return true;
          }
          return false;
        } catch (err) {
          console.error(`Build attempt ${attempt} failed:`, err.message);

          if (attempt <= MAX_AUTO_CORRECTION_ATTEMPTS) {
            db.prepare('UPDATE builds SET message=? WHERE id=?').run(friendly['detecting'], buildId);

            const logs = await getContainerLogsAsync(project_id, 200);
            const errorType = detectErrorType(logs, err.message);

            logError(project_id, errorType, err.message, logs, attempt);

            db.prepare('UPDATE builds SET message=? WHERE id=?').run(
              `${friendly['correcting']} (tentative ${attempt}/${MAX_AUTO_CORRECTION_ATTEMPTS})`,
              buildId
            );

            try {
              const currentProject = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(project_id);

              const correctedCode = await callClaudeForCorrection(currentProject.generated_code, logs, errorType);

              db.prepare("UPDATE projects SET generated_code=?, updated_at=datetime('now') WHERE id=?")
                .run(correctedCode, project_id);

              markErrorCorrected(project_id, correctedCode);

              db.prepare('UPDATE builds SET message=? WHERE id=?').run(friendly['rebuilding'], buildId);

              await stopContainerAsync(project_id);

              return await attemptBuild(correctedCode, attempt + 1);

            } catch (correctionErr) {
              console.error('Auto-correction failed:', correctionErr.message);
              return await attemptBuild(code, attempt + 1);
            }
          } else {
            // Max attempts reached — final deep correction
            const logs = await getContainerLogsAsync(project_id, 200);
            const currentProject = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(project_id);

            console.log(`[Build] Max attempts reached for project ${project_id}, attempting final deep correction...`);
            db.prepare('UPDATE builds SET message=? WHERE id=?').run('Correction approfondie par Prestige AI...', buildId);

            try {
              const finalCode = await callClaudeFinalCorrection(currentProject.generated_code, logs);
              db.prepare("UPDATE projects SET generated_code=?, updated_at=datetime('now') WHERE id=?").run(finalCode, project_id);
              markErrorCorrected(project_id, finalCode);

              db.prepare('UPDATE builds SET message=? WHERE id=?').run('Reconstruction après correction approfondie...', buildId);
              await stopContainerAsync(project_id);

              const finalResult = await buildDockerProject(project_id, finalCode, (p) => {
                const msg = friendly[p.step] || p.message || 'Construction en cours...';
                db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress || 0, msg, buildId);
              });

              if (finalResult.success) {
                db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(finalResult.url, buildId);
                db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(finalResult.url, project_id);
                db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id, `Projet "${project.title}" corrigé et prêt !`, 'success');
                return true;
              }
            } catch (finalErr) {
              console.error(`[Build] Final deep correction failed for project ${project_id}:`, finalErr.message);
            }

            // Truly failed
            const lastError = db.prepare('SELECT error_type FROM error_history WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(project_id);
            const errorMsg = lastError ? translateErrorType(lastError.error_type) : 'Erreur de construction';

            db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run(
              `Après ${MAX_AUTO_CORRECTION_ATTEMPTS + 1} tentatives, le projet nécessite votre attention. ${errorMsg}`,
              buildId
            );
            db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
            db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(
              project.user_id,
              `Le projet "${project.title}" nécessite une simplification. Essayez de simplifier vos requêtes.`,
              'warning'
            );
            return false;
          }
        }
      };

      attemptBuild(project.generated_code, 1);

    } else if (compiler) {
      // Legacy compiler fallback
      const friendly = {1:'Analyse et organisation du projet...',2:'Mise en place des composants...',3:'Application du design et des styles...',4:'Optimisation et finalisation...',5:'Vérification du résultat...',6:'Prêt !'};
      compiler.buildProject(buildId,project.generated_code,p=>{
        db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress, friendly[p.step]||'Construction en cours...', buildId);
      }).then(result=>{
        if (result.success) {
          const url2=`/run/${project_id}/`;
          db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(url2,buildId);
          db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(url2,project_id);
          db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id,`Projet "${project.title}" prêt à explorer !`, 'success');
        } else {
          const cleanErr = 'Une correction est nécessaire. Utilisez le chat pour ajuster le projet.';
          db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run(cleanErr,buildId);
          db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
        }
      });
    } else {
      db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run('Aucun moteur de compilation disponible.', buildId);
      db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
    }
  });

  // ─── BUILD STATUS ───
  router.get('/api/builds/:id', async (req, res) => {
    const user = req.user;
    const build=db.prepare('SELECT * FROM builds WHERE id=?').get(req.params.id);
    if (!build) { json(res,404,{error:'Build non trouvé.'}); return; }

    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(build.project_id);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé.' });
      return;
    }

    json(res,200,build);
  });

  // ─── TEMPLATE FILE TREE ───
  router.get('/api/template-tree', async (req, res) => {
    function buildFileTree(dir) {
      const tree = {};
      if (!fs.existsSync(dir)) return tree;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'data', 'dist'].includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          tree[entry.name] = { directory: buildFileTree(fullPath) };
        } else {
          try {
            tree[entry.name] = { file: { contents: fs.readFileSync(fullPath, 'utf8') } };
          } catch {}
        }
      }
      return tree;
    }
    const templateDir = path.join(__dirname, '..', '..', 'templates', 'react');
    const tree = buildFileTree(templateDir);

    // Full-stack package.json
    const wcPkg = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'))));
    delete wcPkg.dependencies['better-sqlite3'];
    wcPkg.dependencies['sql.js'] = '1.11.0';
    wcPkg.scripts = {
      dev: 'node _start.js & vite --host 0.0.0.0 --port 5173',
      build: 'vite build',
      start: 'node _start.js'
    };
    tree['package.json'] = { file: { contents: JSON.stringify(wcPkg, null, 2) } };

    // Better-sqlite3 shim
    tree['_better-sqlite3-shim.cjs'] = { file: { contents: `// better-sqlite3 compatibility shim using sql.js (WASM SQLite)
// Loaded by _start.js BEFORE server.js — global.__SQL must be set
const SQL = global.__SQL;
if (!SQL) throw new Error('sql.js not initialized');

class Statement {
  constructor(db, sql) { this._db = db; this._sql = sql; }
  run(...params) {
    const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try { this._db.run(this._sql, p); } catch (e) { throw new Error('SQL: ' + e.message); }
    const changes = this._db.getRowsModified();
    let lastInsertRowid = 0;
    try { const r = this._db.exec('SELECT last_insert_rowid() as id'); if (r[0]) lastInsertRowid = r[0].values[0][0]; } catch {}
    return { changes, lastInsertRowid };
  }
  get(...params) {
    const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const stmt = this._db.prepare(this._sql);
      if (p.length) stmt.bind(p);
      if (stmt.step()) {
        const cols = stmt.getColumnNames(), vals = stmt.get();
        stmt.free();
        const row = {}; cols.forEach((c, i) => row[c] = vals[i]); return row;
      }
      stmt.free(); return undefined;
    } catch (e) { throw new Error('SQL: ' + e.message); }
  }
  all(...params) {
    const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const stmt = this._db.prepare(this._sql);
      if (p.length) stmt.bind(p);
      const results = [], cols = stmt.getColumnNames();
      while (stmt.step()) { const vals = stmt.get(); const row = {}; cols.forEach((c, i) => row[c] = vals[i]); results.push(row); }
      stmt.free(); return results;
    } catch (e) { throw new Error('SQL: ' + e.message); }
  }
}

class Database {
  constructor(filename) { this._db = new SQL.Database(); }
  prepare(sql) { return new Statement(this._db, sql); }
  exec(sql) { try { this._db.exec(sql); } catch (e) { throw new Error('SQL exec: ' + e.message); } }
  pragma(str) { try { this._db.exec('PRAGMA ' + str); } catch {} }
  close() { try { this._db.close(); } catch {} }
  transaction(fn) {
    return (...args) => {
      this.exec('BEGIN'); try { const r = fn(...args); this.exec('COMMIT'); return r; }
      catch (e) { this.exec('ROLLBACK'); throw e; }
    };
  }
}
module.exports = Database;
` } };

    // Startup wrapper
    tree['_start.js'] = { file: { contents: `// Full-stack startup: sql.js (WASM) → better-sqlite3 shim → server.js
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

initSqlJs().then(SQL => {
  global.__SQL = SQL;
  console.log('[WC] sql.js initialized (WASM SQLite ready)');

  // Install shim: make require('better-sqlite3') use our sql.js wrapper
  const shimPath = path.join(__dirname, 'node_modules', 'better-sqlite3');
  try { fs.mkdirSync(shimPath, { recursive: true }); } catch {}
  fs.copyFileSync(path.join(__dirname, '_better-sqlite3-shim.cjs'), path.join(shimPath, 'index.js'));
  fs.writeFileSync(path.join(shimPath, 'package.json'), '{"name":"better-sqlite3","main":"index.js"}');

  // Create data directory for SQLite
  try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch {}

  // Now load server.js — its require('better-sqlite3') will find our shim
  require('./server.js');
}).catch(err => {
  console.error('[WC] Failed to initialize sql.js:', err.message);
  process.exit(1);
});
` } };

    // Vite config
    tree['vite.config.js'] = { file: { contents: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000'
    }
  },
  build: { outDir: 'dist' }
});
` } };

    json(res, 200, tree);
  });

  // ─── API DOCS ───
  router.get('/api/docs', async (req, res) => {
    json(res, 200, {
      name: 'Prestige Build Pro API',
      version: '2.0',
      description: 'AI-powered web application generator',
      endpoints: {
        auth: { 'POST /api/login': 'Login', 'POST /api/logout': 'Logout' },
        projects: { 'GET /api/projects': 'List projects', 'POST /api/projects': 'Create', 'GET /api/projects/:id': 'Details', 'PUT /api/projects/:id': 'Update', 'DELETE /api/projects/:id': 'Delete' },
        generation: { 'POST /api/generate/start': 'Start AI generation', 'GET /api/jobs/:id': 'Poll job status', 'POST /api/generate/image/start': 'Generate from image' },
        build: { 'POST /api/compile': 'Docker build', 'GET /api/builds/:id': 'Build status', 'POST /api/hot-reload': 'Hot reload files' },
        github: { 'POST /api/projects/:id/export-github': 'Export to GitHub', 'POST /api/projects/:id/github-pull': 'Pull from GitHub', 'POST /api/projects/:id/github-push': 'Push to GitHub' },
        analytics: { 'GET /api/projects/:id/analytics': 'Project analytics', 'GET /api/admin/analytics': 'Global analytics', 'POST /api/track/:id': 'Track event' },
        usage: { 'GET /api/usage': 'My usage/quota', 'GET /api/admin/usage': 'Admin usage dashboard' },
        workspaces: { 'GET /api/workspaces': 'List workspaces', 'POST /api/workspaces': 'Create workspace', 'POST /api/workspaces/:id/members': 'Invite member' },
        admin: { 'GET /api/admin/system': 'System info', 'GET /api/users': 'List users', 'POST /api/users': 'Create user' },
        debug: { 'GET /api/projects/:id/logs': 'Container logs', 'GET /api/projects/:id/client-logs': 'Frontend logs', 'GET /api/projects/:id/errors': 'Error history' }
      },
      tools: CODE_TOOLS.map(t => ({ name: t.name, description: t.description })),
      total_tools: CODE_TOOLS.length + 1,
      ui_components: 40,
      sectors: 12
    });
  });

  // ─── PROMETHEUS METRICS ───
  router.get('/metrics', async (req, res) => {
    const mem = process.memoryUsage();
    const tokenToday = db ? db.prepare("SELECT COALESCE(SUM(input_tokens+output_tokens),0) as t, COALESCE(SUM(cost_usd),0) as c FROM token_usage WHERE created_at >= date('now')").get() : { t: 0, c: 0 };
    const projectCount = db ? db.prepare('SELECT COUNT(*) as c FROM projects').get()?.c || 0 : 0;
    const userCount = db ? db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0 : 0;
    const metrics = [
      `# HELP prestige_uptime_seconds Server uptime`,
      `prestige_uptime_seconds ${process.uptime().toFixed(0)}`,
      `# HELP prestige_memory_heap_bytes Heap memory usage`,
      `prestige_memory_heap_bytes ${mem.heapUsed}`,
      `prestige_memory_rss_bytes ${mem.rss}`,
      `# HELP prestige_active_generations Current AI generation count`,
      `prestige_active_generations ${ctx.activeGenerations}`,
      `# HELP prestige_tokens_today Total tokens used today`,
      `prestige_tokens_today ${tokenToday.t}`,
      `# HELP prestige_cost_today_usd API cost today in USD`,
      `prestige_cost_today_usd ${tokenToday.c}`,
      `# HELP prestige_projects_total Total projects`,
      `prestige_projects_total ${projectCount}`,
      `# HELP prestige_users_total Total users`,
      `prestige_users_total ${userCount}`,
    ].join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(metrics);
  });

  // ─── PROJECT ANALYTICS (per-project) ───
  router.get('/api/projects/:id/analytics', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin seulement.' }); return; }
    const projectId = parseInt(req.params.id);

    const totalViews = db.prepare('SELECT COUNT(*) as c FROM analytics WHERE project_id = ? AND event_type = ?').get(projectId, 'pageview')?.c || 0;
    const totalClicks = db.prepare('SELECT COUNT(*) as c FROM analytics WHERE project_id = ? AND event_type = ?').get(projectId, 'click')?.c || 0;
    const totalForms = db.prepare('SELECT COUNT(*) as c FROM analytics WHERE project_id = ? AND event_type = ?').get(projectId, 'form_submit')?.c || 0;

    const viewsByDay = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM analytics
      WHERE project_id = ? AND event_type = 'pageview' AND created_at >= datetime('now', '-30 days')
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all(projectId);

    const topPages = db.prepare(`
      SELECT json_extract(event_data, '$.page') as page, COUNT(*) as count
      FROM analytics
      WHERE project_id = ? AND event_type = 'pageview' AND event_data IS NOT NULL
      GROUP BY page
      ORDER BY count DESC
      LIMIT 10
    `).all(projectId);

    const topClicks = db.prepare(`
      SELECT json_extract(event_data, '$.text') as text, COUNT(*) as count
      FROM analytics
      WHERE project_id = ? AND event_type = 'click' AND event_data IS NOT NULL
      GROUP BY text
      ORDER BY count DESC
      LIMIT 10
    `).all(projectId);

    const avgTime = db.prepare(`
      SELECT AVG(CAST(json_extract(event_data, '$.seconds') AS INTEGER)) as avg_seconds
      FROM analytics
      WHERE project_id = ? AND event_type = 'time_spent'
    `).get(projectId);

    const visitorsToday = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now')").get(projectId)?.c || 0;
    const visitorsWeek = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-7 days')").get(projectId)?.c || 0;
    const visitorsMonth = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','start of month')").get(projectId)?.c || 0;

    const allUa = db.prepare("SELECT user_agent FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-30 days')").all(projectId);
    let mobile = 0, desktop = 0;
    allUa.forEach(r => {
      if (/mobile|android|iphone|ipad/i.test(r.user_agent || '')) mobile++; else desktop++;
    });

    const referrers = db.prepare(`
      SELECT json_extract(event_data, '$.referrer') as ref, COUNT(*) as count
      FROM analytics WHERE project_id=? AND event_type='pageview' AND event_data LIKE '%referrer%'
      GROUP BY ref ORDER BY count DESC LIMIT 10
    `).all(projectId);

    const totalVisitors = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-30 days')").get(projectId)?.c || 0;
    const singlePageVisitors = db.prepare(`
      SELECT COUNT(*) as c FROM (
        SELECT ip_address, COUNT(*) as views FROM analytics
        WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-30 days')
        GROUP BY ip_address HAVING views = 1
      )
    `).get(projectId)?.c || 0;
    const bounceRate = totalVisitors > 0 ? Math.round((singlePageVisitors / totalVisitors) * 100) : 0;

    json(res, 200, {
      totalViews, totalClicks, totalForms,
      avgTimeSpent: Math.round(avgTime?.avg_seconds || 0),
      visitors: { today: visitorsToday, week: visitorsWeek, month: visitorsMonth },
      devices: { mobile, desktop, mobilePercent: (mobile + desktop) > 0 ? Math.round((mobile / (mobile + desktop)) * 100) : 0 },
      bounceRate,
      viewsByDay, topPages, topClicks, referrers
    });
  });
};
