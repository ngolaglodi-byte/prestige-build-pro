// ─── PUBLISHING ROUTES ───
// Publish, publish-update, unpublish, DNS instructions

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const crypto = require('crypto');
  const path = require('path');
  const fs = require('fs');
  const db = ctx.db;
  const ai = ctx.ai;
  const log = ctx.log;
  const {
    savePreviewFiles, isDockerAvailable, getContainerName,
    isContainerRunningAsync, stopContainerAsync, restartContainerAsync,
    ensureDockerNetwork, addCustomDomainToCaddy, injectTrackingScript, isPathSafe,
    decryptValue
  } = ctx.services;
  const {
    DOCKER_PROJECTS_DIR, PREVIEWS_DIR, SITES_DIR, PUBLISH_DOMAIN,
    CNAME_TARGET, SERVER_IP, DOCKER_NETWORK, READY_IMAGE, docker
  } = ctx;

  // ─── DNS INSTRUCTIONS ───
  router.get('/api/projects/:id/dns-instructions', async (req, res) => {
    const user = req.user;
    if (user.role!=='admin') { json(res,403,{error:'Admin seulement.'}); return; }
    const id=parseInt(req.params.id);
    const p=db.prepare('SELECT domain,subdomain,is_published FROM projects WHERE id=?').get(id);
    if (!p) { json(res,404,{error:'Projet non trouvé.'}); return; }

    const subdomain = p.subdomain || `project-${id}`;
    const defaultUrl = `https://${subdomain}.${PUBLISH_DOMAIN}`;

    const response = {
      defaultUrl,
      cname: { type: 'CNAME', name: 'www', value: CNAME_TARGET },
      a: { type: 'A', name: '@', value: SERVER_IP }
    };

    if (p.domain) {
      response.customDomain = p.domain;
      response.customDomainUrl = `https://${p.domain}`;
      response.isActive = p.is_published === 1;
    }

    json(res,200,response);
  });

  // ─── PUBLISH ───
  router.post('/api/projects/:id/publish', async (req, res) => {
    const user = req.user;
    const id=parseInt(req.params.id);

    // Authorization check
    if (user.role !== 'admin') {
      const pCheck = db.prepare('SELECT user_id FROM projects WHERE id=?').get(id);
      if (!pCheck || pCheck.user_id !== user.id) {
        json(res, 403, { error: 'Accès refusé.' }); return;
      }
    }

    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) { json(res,404,{error:'Projet non trouvé.'}); return; }

    // Pre-publish validation
    if (!p.generated_code || p.generated_code.length < 500) {
      json(res, 400, { error: 'Le projet n\'a pas encore de code généré. Générez le site d\'abord.' });
      return;
    }
    if (p.build_status !== 'done' && p.status !== 'ready') {
      json(res, 400, { error: 'Le projet n\'est pas encore prêt. Attendez la fin de la génération.' });
      return;
    }

    const body = await getBody(req);
    let subdomain = body.subdomain || p.subdomain || p.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 30) || `project-${id}`;

    // Subdomain validation
    subdomain = subdomain.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').substring(0, 40) || `project-${id}`;
    const RESERVED_SUBDOMAINS = new Set(['admin', 'api', 'app', 'www', 'mail', 'ftp', 'preview', 'static', 'cdn', 'assets']);
    if (RESERVED_SUBDOMAINS.has(subdomain)) {
      subdomain = `${subdomain}-${id}`;
    }
    const existing = db.prepare('SELECT id FROM projects WHERE subdomain=? AND id!=? AND is_published=1').get(subdomain, id);
    if (existing) {
      subdomain = `${subdomain}-${id}`;
    }

    // Copy project files to sites directory
    try {
      const containerName = getContainerName(id);
      const containerRunning = await isContainerRunningAsync(id);
      const distDir = path.join(DOCKER_PROJECTS_DIR, String(id), 'dist');
      let sourceDir = null;

      if (containerRunning) {
        try {
          const { execSync } = require('child_process');
          console.log(`[Publish] Building production dist/ in ${containerName}...`);
          execSync(`docker exec ${containerName} ./node_modules/.bin/vite build`, { timeout: 60000, encoding: 'utf8' });
          execSync(`docker cp ${containerName}:/app/dist/. ${distDir}/`, { timeout: 15000 });
          sourceDir = distDir;
          console.log(`[Publish] Production build completed`);
        } catch (buildErr) {
          console.warn(`[Publish] Vite build failed: ${buildErr.message}`);
        }
      }

      if (!sourceDir && fs.existsSync(distDir)) {
        sourceDir = distDir;
      }
      if (!sourceDir) {
        sourceDir = path.join(PREVIEWS_DIR, String(id));
      }
      if (!fs.existsSync(sourceDir)) {
        if (p.generated_code) {
          savePreviewFiles(id, p.generated_code);
          sourceDir = path.join(PREVIEWS_DIR, String(id));
        } else {
          json(res, 400, { error: 'Aucun fichier à publier. Compilez le projet d\'abord.' }); return;
        }
      }
      const previewDir = sourceDir;

      const safeSubdomain = subdomain.replace(/[^a-zA-Z0-9-]/g, '');
      const siteDir = path.join(SITES_DIR, safeSubdomain);

      if (!isPathSafe(SITES_DIR, siteDir)) {
        json(res, 400, { error: 'Subdomain invalide.' }); return;
      }

      if (fs.existsSync(siteDir)) {
        fs.rmSync(siteDir, { recursive: true, force: true });
      }
      fs.mkdirSync(siteDir, { recursive: true });

      // Copy all files from preview to site
      const copyRecursive = (src, dest) => {
        if (!fs.existsSync(src)) return;
        if (!isPathSafe(previewDir, src) || !isPathSafe(siteDir, dest)) return;
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          fs.readdirSync(src).forEach(child => {
            copyRecursive(path.join(src, child), path.join(dest, child));
          });
        } else {
          let content = fs.readFileSync(src);
          if (src.endsWith('.html')) {
            content = injectTrackingScript(content.toString(), id, safeSubdomain);
          }
          fs.writeFileSync(dest, content);
        }
      };
      copyRecursive(previewDir, siteDir);

      // Production mode: Switch container from dev to prod
      try {
        const projectDir = path.join(DOCKER_PROJECTS_DIR, String(id));
        const dataDir = path.join(projectDir, 'data');

        const localDist = path.join(projectDir, 'dist');
        if (fs.existsSync(path.join(siteDir, 'assets'))) {
          if (!fs.existsSync(localDist)) fs.mkdirSync(localDist, { recursive: true });
          const copyDir = (s, d) => {
            fs.mkdirSync(d, { recursive: true });
            for (const f of fs.readdirSync(s, { withFileTypes: true })) {
              if (f.isDirectory()) copyDir(path.join(s, f.name), path.join(d, f.name));
              else fs.copyFileSync(path.join(s, f.name), path.join(d, f.name));
            }
          };
          copyDir(siteDir, localDist);
        }

        await stopContainerAsync(id);
        await ensureDockerNetwork();
        const jwtSecret = crypto.randomBytes(32).toString('hex');

        const projKeys = db.prepare('SELECT env_name, env_value FROM project_api_keys WHERE project_id=?').all(id);
        const envVars = [
          `PORT=3000`,
          `JWT_SECRET=${jwtSecret}`,
          `NODE_ENV=production`,
          `NODE_OPTIONS=--max-old-space-size=128`
        ];
        projKeys.forEach(k => envVars.push(`${k.env_name}=${decryptValue(k.env_value)}`));

        const readyImage = READY_IMAGE;
        try { await docker.getImage(readyImage).inspect(); } catch { /* use whatever is available */ }

        const prodContainer = await docker.createContainer({
          Image: readyImage,
          name: containerName,
          Env: envVars,
          Cmd: ['sh', '-c', 'cp server.js server.cjs 2>/dev/null; node server.cjs'],
          HostConfig: {
            NetworkMode: DOCKER_NETWORK,
            RestartPolicy: { Name: 'always' },
            Binds: [
              `${dataDir}:/app/data`,
              `${projectDir}/src:/app/src`,
              `${projectDir}/server.js:/app/server.js`,
              `${projectDir}/index.html:/app/index.html`,
              `${localDist}:/app/dist`
            ],
            Memory: 128 * 1024 * 1024,
            NanoCpus: 250000000,
            SecurityOpt: ['no-new-privileges']
          }
        });
        await prodContainer.start();
        console.log(`[Publish] Production container started for project ${id} (Express only, 128MB)`);
      } catch (prodErr) {
        console.warn(`[Publish] Production container failed: ${prodErr.message} — site still serves static files`);
      }

      // Update project status
      db.prepare("UPDATE projects SET is_published=1,status='published',subdomain=?,updated_at=datetime('now') WHERE id=?").run(safeSubdomain, id);
      db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(p.user_id,`Projet "${p.title}" publié sur ${safeSubdomain}.${PUBLISH_DOMAIN} !`,'success');

      const publishedUrl = `https://${safeSubdomain}.${PUBLISH_DOMAIN}`;
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(publishedUrl)}`;

      // Handle custom domain with Caddy SSL
      let customDomainResult = null;
      let customDomainUrl = null;
      if (p.domain) {
        const customDomain = p.domain.toLowerCase().trim();
        if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(customDomain)) {
          customDomainResult = await addCustomDomainToCaddy(customDomain, siteDir);
          customDomainUrl = `https://${customDomain}`;

          if (customDomainResult.success) {
            db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(
              p.user_id,
              `Domaine personnalisé ${customDomain} configuré avec SSL !`,
              'success'
            );
          }
        }
      }

      const response = {
        ok: true,
        subdomain: safeSubdomain,
        url: publishedUrl,
        qrCode: qrCodeUrl,
        localPath: siteDir
      };

      if (customDomainUrl) {
        response.customDomain = p.domain;
        response.customDomainUrl = customDomainUrl;
        response.customDomainConfigured = customDomainResult ? customDomainResult.success : false;
        response.dnsInstructions = {
          cname: { type: 'CNAME', name: 'www', value: CNAME_TARGET },
          a: { type: 'A', name: '@', value: SERVER_IP }
        };
      }

      json(res,200,response);
    } catch(e) {
      console.error('Publish error:', e);
      json(res, 500, { error: 'Erreur lors de la publication: ' + e.message });
    }
  });

  // ─── PUBLISH UPDATE ───
  router.post('/api/projects/:id/publish-update', async (req, res) => {
    const user = req.user;
    const id = parseInt(req.params.id);

    // Authorization check
    if (user.role !== 'admin') {
      const pCheck = db.prepare('SELECT user_id FROM projects WHERE id=?').get(id);
      if (!pCheck || pCheck.user_id !== user.id) {
        json(res, 403, { error: 'Accès refusé.' }); return;
      }
    }

    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) { json(res, 404, { error: 'Projet non trouvé.' }); return; }
    if (!p.is_published) { json(res, 400, { error: 'Ce projet n\'est pas publié. Publiez-le d\'abord.' }); return; }
    if (!p.subdomain) { json(res, 400, { error: 'Subdomain manquant.' }); return; }

    try {
      const projectDir = path.join(DOCKER_PROJECTS_DIR, String(id));
      const siteDir = path.join(SITES_DIR, p.subdomain.replace(/[^a-zA-Z0-9-]/g, ''));
      const { execSync } = require('child_process');

      // 1. Attempt fresh Vite build in running container
      let builtDist = false;
      try {
        const containerName = getContainerName(id);
        const isRunning = await isContainerRunningAsync(id);
        if (isRunning) {
          const distDir = path.join(projectDir, 'dist');
          execSync(`docker exec ${containerName} ./node_modules/.bin/vite build`, { timeout: 120000, encoding: 'utf8' });
          if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
          execSync(`docker cp ${containerName}:/app/dist/. ${distDir}/`, { timeout: 15000 });
          builtDist = true;
          console.log(`[PublishUpdate] Vite build + docker cp succeeded for project ${id}`);
        }
      } catch (e) {
        console.warn(`[PublishUpdate] Vite build failed (will use preview files): ${e.message}`);
      }

      // 2. Copy files to site directory
      if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
      fs.mkdirSync(siteDir, { recursive: true });

      const distDir = path.join(projectDir, 'dist');
      const previewDir = path.join(PREVIEWS_DIR, String(id));
      let sourceDir = null;
      if (builtDist && fs.existsSync(distDir) && fs.readdirSync(distDir).length > 0) {
        sourceDir = distDir;
      } else if (fs.existsSync(previewDir) && fs.readdirSync(previewDir).length > 0) {
        sourceDir = previewDir;
      }

      if (sourceDir) {
        const copyRecursive = (src, dest) => {
          if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
          for (const child of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, child.name);
            const d = path.join(dest, child.name);
            if (child.isDirectory()) copyRecursive(s, d);
            else fs.copyFileSync(s, d);
          }
        };
        copyRecursive(sourceDir, siteDir);
      } else if (p.generated_code) {
        const files = ai ? ai.parseCodeFiles(p.generated_code) : {};
        for (const [fn, content] of Object.entries(files)) {
          const fp = path.join(siteDir, fn);
          const dir = path.dirname(fp);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fp, content);
        }
      }

      // 3. Restart production container
      try {
        await restartContainerAsync(id);
        console.log(`[PublishUpdate] Container restarted for project ${id}`);
      } catch (e) {
        console.warn(`[PublishUpdate] Container restart failed: ${e.message}`);
      }

      // 4. Update timestamp
      db.prepare("UPDATE projects SET updated_at=datetime('now') WHERE id=?").run(id);

      log('info', 'publish', 'site updated', { projectId: id, userId: user.id });
      json(res, 200, {
        ok: true,
        message: `Site mis à jour sur https://${p.subdomain}.${PUBLISH_DOMAIN}`,
        url: `https://${p.subdomain}.${PUBLISH_DOMAIN}`
      });
    } catch (e) {
      log('error', 'publish', 'update failed', { projectId: id, error: e.message });
      json(res, 500, { error: 'Erreur mise à jour: ' + e.message });
    }
  });

  // ─── UNPUBLISH ───
  router.post('/api/projects/:id/unpublish', async (req, res) => {
    const user = req.user;
    if (user.role!=='admin') { json(res,403,{error:'Admin seulement.'}); return; }
    const id=parseInt(req.params.id);
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) { json(res,404,{error:'Projet non trouvé.'}); return; }
    if (!p.is_published) { json(res,400,{error:'Ce projet n\'est pas publié.'}); return; }

    try {
      // 1. Remove static site files
      if (p.subdomain) {
        const siteDir = path.join(SITES_DIR, p.subdomain.replace(/[^a-zA-Z0-9-]/g, ''));
        if (fs.existsSync(siteDir)) {
          fs.rmSync(siteDir, { recursive: true, force: true });
          console.log(`[Unpublish] Removed site files: ${siteDir}`);
        }
      }

      // 2. Stop production container
      try {
        await stopContainerAsync(id);
        console.log(`[Unpublish] Stopped container pbp-project-${id}`);
      } catch (e) { /* container might not exist */ }

      // 3. Update DB
      db.prepare("UPDATE projects SET is_published=0, status='ready', domain=NULL, updated_at=datetime('now') WHERE id=?").run(id);
      db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(p.user_id, `Projet "${p.title}" retiré de la publication.`, 'info');

      console.log(`[Unpublish] Project ${id} unpublished (domain cleared)`);
      json(res, 200, { ok: true, message: `Le site ${p.subdomain}.${PUBLISH_DOMAIN} a été retiré.` });
    } catch (e) {
      json(res, 500, { error: 'Erreur: ' + e.message });
    }
  });
};
