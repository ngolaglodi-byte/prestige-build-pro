// ─── PROJECTS ROUTES ───
// CRUD, versions, logs, errors, auto-correct, restart, close, collaborators, typing, SSE stream, memory, upload

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const path = require('path');
  const fs = require('fs');
  const db = ctx.db;
  const ai = ctx.ai;
  const log = ctx.log;
  const {
    savePreviewFiles, saveProjectVersion, notifyProjectClients,
    getProjectCollaborators, isDockerAvailable, getContainerName,
    isContainerRunningAsync, getContainerLogsAsync, restartContainerAsync,
    launchTemplateContainer, translateLogsToFrench, getErrorHistory,
    translateErrorType, autoCorrectProject, addClientLog,
    writeGeneratedFiles, callClaudeAPI
  } = ctx.services;
  const {
    DOCKER_PROJECTS_DIR, containerLastAccess, correctionAttempts,
    correctionInProgress, projectSSEClients, MAX_COLLABORATORS_PER_PROJECT,
    SLEEP_TIMEOUT_MS, clientLogs, conversationMemoryService
  } = ctx;

  // ─── LIST PROJECTS ───
  router.get('/api/projects', async (req, res) => {
    const user = req.user;
    const p=user.role==='admin'?db.prepare('SELECT p.*,u.name as agent_name FROM projects p JOIN users u ON p.user_id=u.id ORDER BY p.updated_at DESC').all():db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC').all(user.id);
    json(res,200,p);
  });

  // ─── CREATE PROJECT ───
  router.post('/api/projects', async (req, res) => {
    const user = req.user;
    const {title,client_name,project_type,brief,subdomain,domain,apis}=await getBody(req);
    const info=db.prepare("INSERT INTO projects (user_id,title,client_name,project_type,brief,subdomain,domain,apis,status) VALUES (?,?,?,?,?,?,?,?,'draft')").run(user.id,title,client_name,project_type,brief,subdomain,domain,JSON.stringify(apis||[]));
    const projectId = info.lastInsertRowid;

    // Launch isolated container
    if (isDockerAvailable()) {
      launchTemplateContainer(projectId).then(result => {
        if (result.success) console.log(`[Container] Project ${projectId} ready`);
        else console.warn(`[Container] Project ${projectId} failed: ${result.error}`);
      }).catch(err => console.error(`[Container] Error: ${err.message}`));
    }

    json(res,200,{id:projectId,title,status:'draft',preview:`/run/${projectId}/`});
  });

  // ─── GET PROJECT ───
  router.get('/api/projects/:id', async (req, res) => {
    const user = req.user;
    const id=parseInt(req.params.id);
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p||(user.role!=='admin'&&p.user_id!==user.id)) { json(res,403,{error:'Accès refusé.'}); return; }
    // Track access so auto-sleep doesn't kill the container
    containerLastAccess.set(id, Date.now());
    json(res,200,{...p,messages:db.prepare('SELECT * FROM project_messages WHERE project_id=? ORDER BY id ASC').all(id)});
  });

  // ─── UPDATE PROJECT ───
  router.put('/api/projects/:id', async (req, res) => {
    const user = req.user;
    const id=parseInt(req.params.id);
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!project||(user.role!=='admin'&&project.user_id!==user.id)) { json(res,403,{error:'Accès refusé.'}); return; }

    const {title,client_name,brief,subdomain,domain,apis,notes,generated_code,status}=await getBody(req);
    try {
      db.prepare("UPDATE projects SET title=COALESCE(?,title),client_name=COALESCE(?,client_name),brief=COALESCE(?,brief),subdomain=COALESCE(?,subdomain),domain=COALESCE(?,domain),apis=COALESCE(?,apis),notes=COALESCE(?,notes),generated_code=COALESCE(?,generated_code),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=?").run(title,client_name,brief,subdomain,domain,apis?JSON.stringify(apis):null,notes,generated_code,status,id);
      json(res,200,{ok:true});
    } catch(e) {
      json(res,500,{error:'Erreur lors de la mise à jour: ' + e.message});
    }
  });

  // ─── DELETE PROJECT ───
  router.delete('/api/projects/:id', async (req, res) => {
    const user = req.user;
    if (user.role!=='admin') { json(res,403,{error:'Interdit.'}); return; }
    const id=parseInt(req.params.id);

    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);

    // Delete all related records
    db.prepare('DELETE FROM analytics WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project_versions WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project_messages WHERE project_id=?').run(id);
    db.prepare('DELETE FROM builds WHERE project_id=?').run(id);
    db.prepare('DELETE FROM error_history WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project_api_keys WHERE project_id=?').run(id);
    db.prepare('DELETE FROM projects WHERE id=?').run(id);
    if (global.auditLog) global.auditLog(req, user, 'project_deleted', 'project', id, { title: project?.title });

    // Clean up correction attempts tracking
    correctionAttempts.delete(id);
    correctionInProgress.delete(id);

    // Clean up preview files
    const { PREVIEWS_DIR, SITES_DIR, BACKUP_DIR } = ctx;
    const previewDir = path.join(PREVIEWS_DIR, String(id));
    if (fs.existsSync(previewDir)) {
      try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch(e) { console.warn('Preview cleanup error:', e.message); }
    }

    // Clean up Docker container and image
    if (isDockerAvailable()) {
      try {
        await ctx.services.removeContainerAsync(id);
        await ctx.services.removeContainerImageAsync(id);
      } catch(e) { console.warn('Docker cleanup error:', e.message); }
    }

    // Clean up Docker project files
    const dockerProjectDir = path.join(DOCKER_PROJECTS_DIR, String(id));
    if (fs.existsSync(dockerProjectDir)) {
      try { fs.rmSync(dockerProjectDir, { recursive: true, force: true }); } catch(e) { console.warn('Docker project cleanup error:', e.message); }
    }

    // Clean up published site files
    if (project && project.subdomain && project.is_published) {
      const safeSubdomain = project.subdomain.replace(/[^a-zA-Z0-9-]/g, '');
      const siteDir = path.join(SITES_DIR, safeSubdomain);
      if (fs.existsSync(siteDir) && ctx.services.isPathSafe(SITES_DIR, siteDir)) {
        try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch(e) { console.warn('Site cleanup error:', e.message); }
      }
    }

    // Clean up backups
    const backupDir = path.join(BACKUP_DIR, String(id));
    if (fs.existsSync(backupDir)) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch(e) { console.warn('Backup cleanup error:', e.message); }
    }

    // Clean up sleep tracking
    containerLastAccess.delete(id);

    console.log(`[Delete] Project ${id} fully cleaned up`);
    json(res,200,{ok:true});
  });

  // ─── PROJECT VERSIONS ───
  router.get('/api/projects/:id/versions', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const versions = db.prepare('SELECT v.*, u.name as author_name FROM project_versions v LEFT JOIN users u ON v.created_by = u.id WHERE v.project_id = ? ORDER BY v.version_number DESC').all(projectId);
    json(res, 200, versions);
  });

  router.get('/api/projects/:id/versions/:vid', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);
    const versionId = parseInt(req.params.vid);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const version = db.prepare('SELECT * FROM project_versions WHERE id = ? AND project_id = ?').get(versionId, projectId);
    if (!version) { json(res, 404, { error: 'Version non trouvée.' }); return; }
    json(res, 200, version);
  });

  router.post('/api/projects/:id/versions/:vid/restore', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);
    const versionId = parseInt(req.params.vid);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const version = db.prepare('SELECT * FROM project_versions WHERE id = ? AND project_id = ?').get(versionId, projectId);
    if (!version) { json(res, 404, { error: 'Version non trouvée.' }); return; }
    // Restore the version
    db.prepare("UPDATE projects SET generated_code = ?, updated_at = datetime('now'), version = version + 1 WHERE id = ?").run(version.generated_code, projectId);
    // Save as new version
    saveProjectVersion(projectId, version.generated_code, user.id, `Restauration de la version ${version.version_number}`);
    // Regenerate preview
    try {
      savePreviewFiles(projectId, version.generated_code);
    } catch(e) {}
    // Notify other clients
    notifyProjectClients(projectId, 'version_restored', { userName: user.name, versionNumber: version.version_number }, user.id);
    json(res, 200, { ok: true, message: `Version ${version.version_number} restaurée.` });
  });

  // ─── PROJECT LOGS (Docker container logs) ───
  router.get('/api/projects/:id/logs', async (req, res) => {
    const user = req.user;
    const id = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }

    if (!isDockerAvailable()) {
      json(res, 503, { error: 'Docker non disponible.' });
      return;
    }

    const rawLogs = await getContainerLogsAsync(id, 100);
    const translatedLogs = translateLogsToFrench(rawLogs);
    const errorHistory = getErrorHistory(id);
    const running = await isContainerRunningAsync(id);

    json(res, 200, {
      logs: translatedLogs,
      rawLogs,
      container: getContainerName(id),
      running,
      errorHistory: errorHistory.map(e => ({
        type: translateErrorType(e.error_type),
        attempt: e.correction_attempt,
        corrected: e.corrected === 1,
        timestamp: e.created_at
      }))
    });
  });

  // ─── CLIENT-SIDE LOGS ───
  router.post('/api/projects/:id/client-logs', async (req, res) => {
    const id = parseInt(req.params.id);
    const { level, message: logMsg } = await getBody(req);
    if (level && logMsg) addClientLog(id, level, logMsg);
    json(res, 200, { ok: true });
  });

  // ─── PROJECT ERROR HISTORY ───
  router.get('/api/projects/:id/errors', async (req, res) => {
    const user = req.user;
    const id = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }

    const errorHistory = getErrorHistory(id);
    json(res, 200, errorHistory.map(e => ({
      id: e.id,
      type: e.error_type,
      typeFr: translateErrorType(e.error_type),
      message: e.error_message,
      attempt: e.correction_attempt,
      corrected: e.corrected === 1,
      timestamp: e.created_at
    })));
  });

  // ─── PROJECT AUTO-CORRECT ───
  router.post('/api/projects/:id/auto-correct', async (req, res) => {
    const user = req.user;
    const id = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }

    if (!isDockerAvailable()) {
      json(res, 503, { error: 'Docker non disponible.' });
      return;
    }

    // Reset correction attempts
    correctionAttempts.delete(id);

    // Trigger auto-correction
    autoCorrectProject(id, (progress) => {
      console.log(`Auto-correct ${id}:`, progress);
    }).then(result => {
      if (result.success) {
        db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)')
          .run(p.user_id, `Projet "${p.title}" corrigé automatiquement par Prestige AI.`, 'success');
      }
    });

    json(res, 200, { ok: true, message: 'Correction automatique lancée.' });
  });

  // ─── PROJECT RESTART ───
  router.post('/api/projects/:id/restart', async (req, res) => {
    const user = req.user;
    const id = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }

    if (!isDockerAvailable()) {
      json(res, 503, { error: 'Docker non disponible.' });
      return;
    }

    const success = await restartContainerAsync(id);
    if (success) {
      json(res, 200, { ok: true, message: 'Projet redémarré avec succès.' });
    } else {
      json(res, 500, { error: 'Échec du redémarrage. Essayez de recompiler le projet.' });
    }
  });

  // ─── CLOSE WORKSPACE ───
  router.post('/api/projects/:id/close', async (req, res) => {
    const id = parseInt(req.params.id);
    containerLastAccess.set(id, Date.now());
    console.log(`[Close] Workspace closed for project ${id} — container will auto-stop in ${SLEEP_TIMEOUT_MS/60000}min`);
    json(res, 200, { ok: true });
  });

  // ─── COLLABORATORS ───
  router.get('/api/projects/:id/collaborators', async (req, res) => {
    const projectId = parseInt(req.params.id);
    json(res, 200, { collaborators: getProjectCollaborators(projectId) });
  });

  // ─── TYPING INDICATOR ───
  router.post('/api/projects/:id/typing', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);
    notifyProjectClients(projectId, 'user_typing', { userName: user.name, userId: user.id }, user.id);
    json(res, 200, { ok: true });
  });

  // ─── REAL-TIME COLLABORATION (SSE) ───
  router.get('/api/projects/:id/stream', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }

    // Setup SSE connection
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Register this client (with collaborator limit)
    if (!projectSSEClients.has(projectId)) {
      projectSSEClients.set(projectId, new Set());
    }
    const clients = projectSSEClients.get(projectId);
    if (clients.size >= MAX_COLLABORATORS_PER_PROJECT) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Maximum de collaborateurs atteint (20).' })}\n\n`);
      res.end();
      return;
    }
    const clientInfo = { res, userId: user.id, userName: user.name, connectedAt: new Date().toISOString() };
    clients.add(clientInfo);

    // Notify others that this user joined
    notifyProjectClients(projectId, 'user_joined', { userName: user.name, userId: user.id }, user.id);

    // Send initial connection confirmation + current collaborators list
    const collaborators = getProjectCollaborators(projectId);
    res.write(`data: ${JSON.stringify({ type: 'connected', userId: user.id, userName: user.name, collaborators })}\n\n`);

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`); } catch(e) {}
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      const clients = projectSSEClients.get(projectId);
      if (clients) {
        clients.delete(clientInfo);
        if (clients.size === 0) projectSSEClients.delete(projectId);
      }
      notifyProjectClients(projectId, 'user_left', { userName: user.name, userId: user.id }, user.id);
    });

    // Keep connection open
  });

  // ─── PROJECT MEMORY (persistent preferences) ───
  router.get('/api/projects/:id/memory', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const memory = conversationMemoryService.getProjectMemory(projectId);
    const summaries = conversationMemoryService.getConversationSummaries(projectId);
    json(res, 200, { memory: memory || '', summaries });
  });

  router.put('/api/projects/:id/memory', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const { content } = await getBody(req);
    const ok = conversationMemoryService.setProjectMemory(projectId, content || '', user.id);
    json(res, ok ? 200 : 500, ok ? { ok: true } : { error: 'Erreur sauvegarde mémoire' });
  });

  // ─── PROJECT FILE UPLOAD ───
  router.post('/api/projects/:id/upload', async (req, res) => {
    const user = req.user;
    const projectId = parseInt(req.params.id, 10);

    // Auth + ownership
    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé.' });
      return;
    }

    const body = await getBody(req, 15 * 1024 * 1024); // 15MB max
    const { filename, base64, content_type } = body || {};

    // Validate filename
    if (!filename || typeof filename !== 'string') {
      json(res, 400, { error: 'filename requis.' });
      return;
    }
    const sanitized = filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '.')
      .substring(0, 100);
    if (!sanitized || sanitized === '.' || sanitized === '_') {
      json(res, 400, { error: 'Nom de fichier invalide.' });
      return;
    }

    // Validate content type
    const ALLOWED_TYPES = new Set([
      'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
      'image/svg+xml', 'image/x-icon', 'image/ico',
      'application/pdf'
    ]);
    if (content_type && !ALLOWED_TYPES.has(content_type)) {
      json(res, 400, { error: `Type non supporté: ${content_type}. Acceptés: images, SVG, PDF.` });
      return;
    }

    // Validate base64
    if (!base64 || typeof base64 !== 'string' || base64.length < 10) {
      json(res, 400, { error: 'base64 requis.' });
      return;
    }
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      json(res, 400, { error: 'Fichier trop volumineux (max 10MB).' });
      return;
    }

    // Save to BOTH public/images/ AND src/assets/images/
    const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
    const publicImagesDir = path.join(projectDir, 'public', 'images');
    const assetsImagesDir = path.join(projectDir, 'src', 'assets', 'images');
    if (!fs.existsSync(publicImagesDir)) fs.mkdirSync(publicImagesDir, { recursive: true });
    if (!fs.existsSync(assetsImagesDir)) fs.mkdirSync(assetsImagesDir, { recursive: true });

    const publicPath = path.join(publicImagesDir, sanitized);
    const assetsPath = path.join(assetsImagesDir, sanitized);
    try {
      fs.writeFileSync(publicPath, buffer);
      fs.writeFileSync(assetsPath, buffer);
      log('info', 'upload', 'file saved (public + assets)', {
        projectId, filename: sanitized, size: buffer.length, userId: user.id
      });
      json(res, 200, {
        ok: true,
        path: `/images/${sanitized}`,
        assetPath: `@/assets/images/${sanitized}`,
        filename: sanitized,
        size: buffer.length,
        url: `/run/${projectId}/images/${sanitized}`
      });
    } catch (e) {
      log('error', 'upload', 'write failed', { projectId, error: e.message });
      json(res, 500, { error: 'Erreur sauvegarde fichier: ' + e.message });
    }
  });
};
