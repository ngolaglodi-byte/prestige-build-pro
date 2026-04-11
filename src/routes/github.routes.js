// ─── GITHUB ROUTES ───
// Export to GitHub, pull from GitHub, push to GitHub

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const https = require('https');
  const path = require('path');
  const fs = require('fs');
  const db = ctx.db;
  const log = ctx.log;
  const {
    saveProjectVersion, readProjectFilesRecursive, formatProjectCode,
    decryptValue, isValidProjectFile, safeWriteTsx
  } = ctx.services;
  const { DOCKER_PROJECTS_DIR } = ctx;

  // ─── GITHUB EXPORT ───
  router.post('/api/projects/:id/export-github', async (req, res) => {
    const user = req.user;
    const pid = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const cfg = db.prepare('SELECT github_token, github_username, github_org FROM github_config WHERE id=1').get();
    if (!cfg) { json(res, 400, { error: 'GitHub non configuré par l\'administrateur.' }); return; }
    const body = await getBody(req);
    const repoName = (body.repo_name || p.title || 'project-' + pid).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').substring(0, 50);
    const description = body.description || p.brief || '';
    const isPrivate = body.private !== false;
    const tok = decryptValue(cfg.github_token);
    const owner = cfg.github_org || cfg.github_username;

    try {
      // Create repo
      const createRes = await new Promise((resolve, reject) => {
        const endpoint = cfg.github_org ? `/orgs/${cfg.github_org}/repos` : '/user/repos';
        const payload = JSON.stringify({ name: repoName, description: description.substring(0, 350), private: isPrivate, auto_init: false });
        const req = https.request({ hostname: 'api.github.com', path: endpoint, method: 'POST', headers: { 'Authorization': `token ${tok}`, 'User-Agent': 'PrestigeBuildPro', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, data: d }));
        }); req.on('error', reject); req.write(payload); req.end();
      });
      if (createRes.status !== 201) {
        const err = JSON.parse(createRes.data);
        json(res, 400, { error: err.message || 'Erreur création repo.' }); return;
      }
      const repo = JSON.parse(createRes.data);
      const repoUrl = repo.html_url;

      // Collect files from project directory
      const projDir = path.join(DOCKER_PROJECTS_DIR, String(pid));
      const filesToPush = {};
      const collectFiles = (dir, prefix) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(f => {
          if (['node_modules', '.git', 'data', 'Dockerfile', 'BRIEF.md', 'CLAUDE.md', 'READY', 'ERROR'].includes(f)) return;
          const fp = path.join(dir, f);
          const rel = prefix ? prefix + '/' + f : f;
          if (fs.statSync(fp).isDirectory()) { collectFiles(fp, rel); }
          else { filesToPush[rel] = fs.readFileSync(fp); }
        });
      };
      collectFiles(projDir, '');

      // Add .gitignore
      filesToPush['.gitignore'] = Buffer.from('node_modules/\n.env\n*.db\n/data/\n.DS_Store\n');

      // Add .env.example
      const envKeys = ['PORT=3000', 'JWT_SECRET=your_jwt_secret_here', 'DATABASE_PATH=./data/app.db'];
      const pKeys = db.prepare('SELECT env_name FROM project_api_keys WHERE project_id=?').all(pid);
      pKeys.forEach(k => envKeys.push(`${k.env_name}=your_value_here`));
      filesToPush['.env.example'] = Buffer.from(envKeys.join('\n') + '\n');

      // Add README.md
      const readme = `# ${p.title || 'Projet'}\n\n${p.brief || ''}\n\n**Client:** ${p.client_name || '-'}\n**Généré par:** [Prestige Build Pro](https://app.prestige-build.dev)\n**Date:** ${new Date().toLocaleDateString('fr-FR')}\n\n## Installation\n\n\`\`\`bash\nnpm install\ncp .env.example .env\n# Configurez vos variables d'environnement\nnode server.js\n\`\`\`\n\nLe serveur démarre sur http://localhost:3000\n`;
      filesToPush['README.md'] = Buffer.from(readme);

      // Push all files via GitHub API (create tree + commit)
      const ghApi = (method, apiPath, payload) => new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : '';
        const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: { 'Authorization': `token ${tok}`, 'User-Agent': 'PrestigeBuildPro', 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
        }); req.on('error', reject); if (data) req.write(data); req.end();
      });

      // Create blobs for each file
      const tree = [];
      for (const [fpath, content] of Object.entries(filesToPush)) {
        const blob = await ghApi('POST', `/repos/${owner}/${repoName}/git/blobs`, {
          content: content.toString('base64'), encoding: 'base64'
        });
        tree.push({ path: fpath, mode: '100644', type: 'blob', sha: blob.sha });
      }

      // Create tree
      const treeRes = await ghApi('POST', `/repos/${owner}/${repoName}/git/trees`, { tree });

      // Create commit
      const commitRes = await ghApi('POST', `/repos/${owner}/${repoName}/git/commits`, {
        message: `Initial commit — ${p.title || 'Projet'} via Prestige Build Pro`,
        tree: treeRes.sha
      });

      // Update default branch ref
      await ghApi('POST', `/repos/${owner}/${repoName}/git/refs`, {
        ref: 'refs/heads/main', sha: commitRes.sha
      });

      // Save repo URL in project
      db.prepare('UPDATE projects SET github_repo=? WHERE id=?').run(repoUrl, pid);
      db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(pid, 'assistant', `✅ Projet exporté sur GitHub : ${repoUrl}`);

      json(res, 200, { ok: true, url: repoUrl, repo: repoName });
    } catch (e) {
      console.error('[GitHub Export] Error:', e.message);
      json(res, 500, { error: 'Erreur export GitHub: ' + e.message });
    }
  });

  // ─── GITHUB PULL ───
  router.post('/api/projects/:id/github-pull', async (req, res) => {
    const user = req.user;
    const pid = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    if (!p.github_repo) { json(res, 400, { error: 'Aucun repo GitHub lié. Exportez d\'abord.' }); return; }
    const cfg = db.prepare('SELECT github_token, github_username, github_org FROM github_config WHERE id=1').get();
    if (!cfg) { json(res, 400, { error: 'GitHub non configuré.' }); return; }

    const tok = decryptValue(cfg.github_token);
    const repoMatch = p.github_repo.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!repoMatch) { json(res, 400, { error: 'URL GitHub invalide.' }); return; }
    const [, ghOwner, ghRepo] = repoMatch;

    try {
      console.log(`[GitHub Pull] Fetching ${ghOwner}/${ghRepo} for project ${pid}`);
      const ghApi = (apiPath) => new Promise((resolve, reject) => {
        const req = https.request({ hostname: 'api.github.com', path: apiPath, method: 'GET',
          headers: { 'Authorization': `token ${tok}`, 'User-Agent': 'PrestigeBuildPro' }
        }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
        req.on('error', reject); req.end();
      });

      // Get repo tree recursively
      const branch = await ghApi(`/repos/${ghOwner}/${ghRepo}/git/ref/heads/main`);
      if (!branch.object?.sha) { json(res, 400, { error: 'Branche main introuvable.' }); return; }
      const tree = await ghApi(`/repos/${ghOwner}/${ghRepo}/git/trees/${branch.object.sha}?recursive=1`);
      if (!tree.tree) { json(res, 400, { error: 'Arborescence introuvable.' }); return; }

      // Download each file
      const projDir = path.join(DOCKER_PROJECTS_DIR, String(pid));
      let filesUpdated = 0;
      const validFiles = tree.tree.filter(f => f.type === 'blob' && isValidProjectFile(f.path));

      for (const file of validFiles) {
        const blob = await ghApi(`/repos/${ghOwner}/${ghRepo}/git/blobs/${file.sha}`);
        if (blob.content) {
          const content = Buffer.from(blob.content, blob.encoding || 'base64').toString('utf8');
          const filePath = path.join(projDir, file.path);
          const fileDir = path.dirname(filePath);
          if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
          if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
          filesUpdated++;
        }
      }

      // Re-read all files and update DB
      const allFiles = readProjectFilesRecursive(projDir);
      const newCode = formatProjectCode(allFiles);
      db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now') WHERE id=?").run(newCode, pid);
      saveProjectVersion(pid, newCode, user.id, `Pull depuis GitHub ${ghOwner}/${ghRepo}`);
      console.log(`[GitHub Pull] Updated ${filesUpdated} files for project ${pid}`);

      json(res, 200, { ok: true, filesUpdated, files: validFiles.map(f => f.path) });
    } catch (e) {
      console.error('[GitHub Pull] Error:', e.message);
      json(res, 500, { error: 'Erreur pull GitHub: ' + e.message });
    }
  });

  // ─── GITHUB PUSH ───
  router.post('/api/projects/:id/github-push', async (req, res) => {
    const user = req.user;
    const pid = parseInt(req.params.id);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    if (!p.github_repo) { json(res, 400, { error: 'Aucun repo GitHub lié.' }); return; }
    const cfg = db.prepare('SELECT github_token, github_username, github_org FROM github_config WHERE id=1').get();
    if (!cfg) { json(res, 400, { error: 'GitHub non configuré.' }); return; }

    const tok = decryptValue(cfg.github_token);
    const repoMatch = p.github_repo.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!repoMatch) { json(res, 400, { error: 'URL GitHub invalide.' }); return; }
    const [, ghOwner, ghRepo] = repoMatch;
    const body = await getBody(req);
    const commitMsg = body.message || `Update via Prestige Build Pro — ${new Date().toISOString().split('T')[0]}`;

    try {
      console.log(`[GitHub Push] Pushing to ${ghOwner}/${ghRepo} for project ${pid}`);
      const ghApi = (method, apiPath, payload) => new Promise((resolve, reject) => {
        const data = payload ? JSON.stringify(payload) : '';
        const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
          headers: { 'Authorization': `token ${tok}`, 'User-Agent': 'PrestigeBuildPro', 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
        }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
        req.on('error', reject); if (data) req.write(data); req.end();
      });

      // Get current HEAD
      const ref = await ghApi('GET', `/repos/${ghOwner}/${ghRepo}/git/ref/heads/main`);
      const parentSha = ref.object?.sha;
      if (!parentSha) { json(res, 400, { error: 'Branche main introuvable.' }); return; }

      // Collect project files
      const projDir = path.join(DOCKER_PROJECTS_DIR, String(pid));
      const filesToPush = {};
      const collectFiles = (dir, prefix) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(f => {
          if (['node_modules', '.git', 'data', 'dist', 'Dockerfile', 'start-dev.sh', 'BRIEF.md', 'CLAUDE.md', 'READY', 'ERROR'].includes(f)) return;
          const fp = path.join(dir, f);
          const rel = prefix ? prefix + '/' + f : f;
          if (fs.statSync(fp).isDirectory()) collectFiles(fp, rel);
          else filesToPush[rel] = fs.readFileSync(fp);
        });
      };
      collectFiles(projDir, '');

      // Create blobs + tree + commit
      const treeItems = [];
      for (const [fpath, content] of Object.entries(filesToPush)) {
        const blob = await ghApi('POST', `/repos/${ghOwner}/${ghRepo}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' });
        treeItems.push({ path: fpath, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const treeRes = await ghApi('POST', `/repos/${ghOwner}/${ghRepo}/git/trees`, { tree: treeItems });
      const commitRes = await ghApi('POST', `/repos/${ghOwner}/${ghRepo}/git/commits`, {
        message: commitMsg, tree: treeRes.sha, parents: [parentSha]
      });
      await ghApi('PATCH', `/repos/${ghOwner}/${ghRepo}/git/refs/heads/main`, { sha: commitRes.sha });

      console.log(`[GitHub Push] Pushed ${Object.keys(filesToPush).length} files`);
      json(res, 200, { ok: true, commitSha: commitRes.sha, filesPushed: Object.keys(filesToPush).length });
    } catch (e) {
      console.error('[GitHub Push] Error:', e.message);
      json(res, 500, { error: 'Erreur push GitHub: ' + e.message });
    }
  });
};
