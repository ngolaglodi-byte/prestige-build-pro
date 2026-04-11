// ─── DOCKER ROUTES ───
// Preview refresh, backups, restore, project API keys

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const path = require('path');
  const fs = require('fs');
  const db = ctx.db;
  const log = ctx.log;
  const {
    savePreviewFiles, restartContainerAsync, backupProject,
    encryptValue, decryptValue
  } = ctx.services;
  const { DOCKER_PROJECTS_DIR, BACKUP_DIR } = ctx;

  // ─── PREVIEW REFRESH ───
  router.post('/api/preview/:id/refresh', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);

    // Authorization check
    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
      return;
    }

    const body = await getBody(req);
    const code = body.code;
    if (!code) {
      json(res, 400, { error: 'Code required' });
      return;
    }
    try {
      const result = savePreviewFiles(projectId, code);
      json(res, 200, { success: true, previewUrl: `/run/${projectId}/`, framework: result.framework });
    } catch(e) {
      json(res, 500, { error: e.message });
    }
  });

  // ─── PROJECT BACKUPS ───
  router.get('/api/projects/:id/backups', async (req, res) => {
    const user = req.user;
    const pid = parseInt(req.params.id);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const bDir = path.join(BACKUP_DIR, String(pid));
    if (!fs.existsSync(bDir)) { json(res, 200, []); return; }
    const backups = fs.readdirSync(bDir).filter(f => f.endsWith('.db')).sort().reverse().map(f => ({
      filename: f,
      date: f.replace('.db', '').replace(/-/g, (m, i) => i < 10 ? '-' : i < 13 ? 'T' : i < 16 ? ':' : '.'),
      size: fs.statSync(path.join(bDir, f)).size
    }));
    json(res, 200, backups);
  });

  router.post('/api/projects/:id/backup', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const pid = parseInt(req.params.id);
    try {
      const file = await backupProject(pid);
      json(res, 200, { ok: true, file: file ? path.basename(file) : null });
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  router.post('/api/projects/:id/restore', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const pid = parseInt(req.params.id);
    const { filename } = await getBody(req);
    if (!filename) { json(res, 400, { error: 'filename requis.' }); return; }
    const bFile = path.join(BACKUP_DIR, String(pid), path.basename(filename));
    const dbFile = path.join(DOCKER_PROJECTS_DIR, String(pid), 'data', 'database.db');
    if (!fs.existsSync(bFile)) { json(res, 404, { error: 'Backup non trouvé.' }); return; }
    try {
      fs.copyFileSync(bFile, dbFile);
      await restartContainerAsync(pid);
      json(res, 200, { ok: true, message: 'Backup restauré et container redémarré.' });
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  // ─── PROJECT API KEYS ───
  router.get('/api/projects/:id/keys', async (req, res) => {
    const user = req.user;
    const pid = parseInt(req.params.id);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const keys = db.prepare('SELECT id, env_name, service, created_at FROM project_api_keys WHERE project_id=?').all(pid);
    json(res, 200, keys);
  });

  router.post('/api/projects/:id/keys', async (req, res) => {
    const user = req.user;
    const pid = parseInt(req.params.id);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const { env_name, env_value, service } = await getBody(req);
    if (!env_name || !env_value) { json(res, 400, { error: 'env_name et env_value requis.' }); return; }
    // Upsert: replace if same env_name exists for this project
    db.prepare('DELETE FROM project_api_keys WHERE project_id=? AND env_name=?').run(pid, env_name);
    db.prepare('INSERT INTO project_api_keys (project_id, env_name, env_value, service) VALUES (?,?,?,?)').run(pid, env_name, encryptValue(env_value), service || '');
    console.log(`[API Keys] Set ${env_name} for project ${pid}`);
    json(res, 200, { ok: true });
  });

  router.delete('/api/projects/:id/keys/:kid', async (req, res) => {
    const user = req.user;
    const pid = parseInt(req.params.id);
    const kid = parseInt(req.params.kid);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    db.prepare('DELETE FROM project_api_keys WHERE id=? AND project_id=?').run(kid, pid);
    json(res, 200, { ok: true });
  });
};
