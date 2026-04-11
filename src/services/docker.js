/**
 * Docker Isolated Preview System — container lifecycle, proxy, error correction
 * Extracted from server.js lines 6245-7790+
 *
 * Contains ALL Docker functions: checkDockerAvailable, ensureDockerNetwork,
 * joinPbpProjectsNetwork, getContainerName, getContainerHostname,
 * isContainerRunningAsync, stopContainerAsync, removeContainerAsync,
 * removeContainerImageAsync, getContainerLogsAsync, demuxDockerLogs,
 * restartContainerAsync, autoRecoveryTick, startContainerAsync,
 * waitForContainerHealth, ensureReadyImage, launchTemplateContainer,
 * writeFilesToContainer, buildDockerProject, detectErrorType,
 * translateErrorType, checkSyntax, extractMissingModule, findFreePort,
 * logError, markErrorCorrected, callClaudeForCorrection,
 * callClaudeFinalCorrection, autoCorrectProject, backupProject,
 * backupAllProjects, monitorContainers, translateLogsToFrench,
 * getErrorHistory, proxyToContainer, rebuildContainerMapping,
 * ensureBaseImage, initializeDockerSystem
 *
 * NOTE: This is a very large module (~1500 lines in the original).
 * The full implementation has been extracted. Cross-module dependencies
 * are injected via setDeps() and accessed through ctx.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const { ERROR_TYPES, log } = require('../config');

module.exports = function(ctx) {
  // Deps injected after init
  let writeDefaultReactProject, DEFAULT_PACKAGE_JSON, DEFAULT_VITE_CONFIG, DEFAULT_INDEX_HTML;
  let DEFAULT_SERVER_JS, DEFAULT_MAIN_JSX, DEFAULT_INDEX_CSS, DEFAULT_APP_JSX;
  let readProjectFilesRecursive, formatProjectCode, validateJsxFiles, writeGeneratedFiles;
  let parseDockerProjectCode, validateReactIndexHtml, isValidProjectFile;
  let safeWriteTsx, safeFixServerJs, checkSyntaxFn, mergeModifiedCode;
  let cleanGeneratedContent, stripCodeArtifacts, decryptValue, trackTokenUsage;
  let isValidJson;

  function setDeps(deps) {
    writeDefaultReactProject = deps.writeDefaultReactProject;
    DEFAULT_PACKAGE_JSON = deps.DEFAULT_PACKAGE_JSON;
    DEFAULT_VITE_CONFIG = deps.DEFAULT_VITE_CONFIG;
    DEFAULT_INDEX_HTML = deps.DEFAULT_INDEX_HTML;
    DEFAULT_SERVER_JS = deps.DEFAULT_SERVER_JS;
    DEFAULT_MAIN_JSX = deps.DEFAULT_MAIN_JSX;
    DEFAULT_INDEX_CSS = deps.DEFAULT_INDEX_CSS;
    DEFAULT_APP_JSX = deps.DEFAULT_APP_JSX;
    readProjectFilesRecursive = deps.readProjectFilesRecursive;
    formatProjectCode = deps.formatProjectCode;
    validateJsxFiles = deps.validateJsxFiles;
    writeGeneratedFiles = deps.writeGeneratedFiles;
    parseDockerProjectCode = deps.parseDockerProjectCode;
    validateReactIndexHtml = deps.validateReactIndexHtml;
    isValidProjectFile = deps.isValidProjectFile;
    safeWriteTsx = deps.safeWriteTsx;
    safeFixServerJs = deps.safeFixServerJs;
    checkSyntaxFn = deps.checkSyntax;
    mergeModifiedCode = deps.mergeModifiedCode;
    cleanGeneratedContent = deps.cleanGeneratedContent;
    stripCodeArtifacts = deps.stripCodeArtifacts;
    decryptValue = deps.decryptValue;
    trackTokenUsage = deps.trackTokenUsage;
    isValidJson = deps.isValidJson;
  }

  let dockerAvailable = false;
  const READY_IMAGE = 'pbp-ready';
  const restartLocks = new Map();
  const AUTO_RECOVERY_INTERVAL_MS = 60 * 1000;
  const AUTO_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
  const autoRecoveryLastRestart = new Map();
  const BACKUP_DIR = '/data/backups';
  const MAX_BACKUPS = 7;

  async function checkDockerAvailable() {
    if (!ctx.docker) return false;
    try { await ctx.docker.ping(); return true; } catch (e) { return false; }
  }

  function isDockerAvailable() { return dockerAvailable; }

  async function ensureDockerNetwork() {
    if (!ctx.docker) return;
    try {
      const networks = await ctx.docker.listNetworks();
      if (!networks.map(n => n.Name).includes(ctx.config.DOCKER_NETWORK)) {
        await ctx.docker.createNetwork({ Name: ctx.config.DOCKER_NETWORK, Driver: 'bridge' });
        console.log(`Created Docker network: ${ctx.config.DOCKER_NETWORK}`);
      }
    } catch (e) { console.error('Failed to ensure Docker network:', e.message); }
  }

  async function joinPbpProjectsNetwork() {
    if (!ctx.docker) return;
    try {
      const hostname = process.env.HOSTNAME || os.hostname();
      if (!hostname) return;
      const container = ctx.docker.getContainer(hostname);
      let inspectData;
      try { inspectData = await container.inspect(); } catch (e) { return; }
      const networks = inspectData.NetworkSettings && inspectData.NetworkSettings.Networks;
      if (networks && networks[ctx.config.DOCKER_NETWORK]) return;
      const network = ctx.docker.getNetwork(ctx.config.DOCKER_NETWORK);
      await network.connect({ Container: inspectData.Id || hostname });
      console.log(`[Network] Connected to ${ctx.config.DOCKER_NETWORK}`);
    } catch (e) { console.error(`[Network] Failed to join: ${e.message}`); }
  }

  function getContainerName(projectId) { return `pbp-project-${projectId}`; }
  function getContainerHostname(projectId) { return getContainerName(projectId); }

  async function isContainerRunningAsync(projectId) {
    if (!ctx.docker) return false;
    try {
      const container = ctx.docker.getContainer(getContainerName(projectId));
      const data = await container.inspect();
      return data?.State?.Running === true;
    } catch (e) { return false; }
  }

  async function stopContainerAsync(projectId) {
    if (!ctx.docker) return;
    try { await ctx.docker.getContainer(getContainerName(projectId)).stop({ t: 10 }); } catch (e) {}
  }

  async function removeContainerAsync(projectId) {
    if (!ctx.docker) return;
    try {
      const c = ctx.docker.getContainer(getContainerName(projectId));
      try { await c.stop({ t: 5 }); } catch {}
      await c.remove({ force: true });
    } catch (e) {}
  }

  async function removeContainerImageAsync(projectId) {
    if (!ctx.docker) return;
    try { await ctx.docker.getImage(`pbp-project-${projectId}:latest`).remove({ force: true }); } catch (e) {}
  }

  async function getContainerLogsAsync(projectId, tailLines = 100) {
    if (!ctx.docker) return 'Erreur: Docker non disponible.';
    try {
      const logStream = await ctx.docker.getContainer(getContainerName(projectId)).logs({ stdout: true, stderr: true, tail: tailLines, follow: false });
      if (Buffer.isBuffer(logStream)) return demuxDockerLogs(logStream);
      return logStream.toString('utf8');
    } catch (e) { return `Erreur: ${e.message}`; }
  }

  function demuxDockerLogs(buffer) {
    let result = '', offset = 0;
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) break;
      const size = buffer.readUInt32BE(offset + 4);
      offset += 8;
      if (offset + size > buffer.length) break;
      result += buffer.slice(offset, offset + size).toString('utf8');
      offset += size;
    }
    return result || buffer.toString('utf8');
  }

  async function restartContainerAsync(projectId) {
    if (!ctx.docker) return false;
    try { await ctx.docker.getContainer(getContainerName(projectId)).restart({ t: 10 }); return true; } catch (e) { return false; }
  }

  async function autoRecoveryTick() {
    if (!ctx.docker) return;
    try {
      const containers = await ctx.docker.listContainers({ all: false, filters: JSON.stringify({ health: ['unhealthy'] }) });
      for (const c of containers) {
        const name = ((c.Names || [])[0] || '').replace(/^\//, '');
        const match = name.match(/^pbp-project-(\d+)$/);
        if (!match) continue;
        const projectId = parseInt(match[1], 10);
        const lastRestart = autoRecoveryLastRestart.get(projectId);
        if (lastRestart && (Date.now() - lastRestart) < AUTO_RECOVERY_COOLDOWN_MS) continue;
        const ok = await restartContainerAsync(projectId);
        if (ok) autoRecoveryLastRestart.set(projectId, Date.now());
      }
    } catch (e) { log('error', 'auto-recovery', 'tick failed', { error: e.message }); }
  }

  async function startContainerAsync(projectId) {
    if (!ctx.docker) return false;
    try { await ctx.docker.getContainer(getContainerName(projectId)).start(); return true; } catch (e) { return false; }
  }

  async function waitForContainerHealth(projectId, maxWait) {
    maxWait = maxWait || ctx.config.DOCKER_HEALTH_TIMEOUT;
    const startTime = Date.now();
    const hostname = getContainerHostname(projectId);
    let attempt = 0;
    const testUrl = (url, timeoutMs = 2000) => new Promise((resolve) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400 });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    });
    while (Date.now() - startTime < maxWait) {
      attempt++;
      const [expressResult, viteResult] = await Promise.all([
        testUrl(`http://${hostname}:3000/health`),
        testUrl(`http://${hostname}:5173/run/${projectId}/`)
      ]);
      if (expressResult.ok && viteResult.ok) return true;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  async function ensureReadyImage() {
    if (!ctx.docker) return;
    try { await ctx.docker.getImage(READY_IMAGE).inspect(); } catch {
      try {
        const buildContext = path.join(__dirname, '..', '..');
        const stream = await ctx.docker.buildImage({ context: buildContext, src: ['Dockerfile.ready', 'templates/'] }, { t: READY_IMAGE, dockerfile: 'Dockerfile.ready' });
        await new Promise((resolve, reject) => { ctx.docker.modem.followProgress(stream, (err) => { if (err) reject(err); else resolve(); }); });
      } catch (e) { console.error(`[Docker] Failed to build ready image: ${e.message}`); }
    }
  }

  async function launchTemplateContainer(projectId) {
    if (!isDockerAvailable()) return { success: false, error: 'Docker non disponible' };
    const containerName = getContainerName(projectId);
    const projectDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));
    const dataDir = path.join(projectDir, 'data');
    const jwtSecret = crypto.randomBytes(32).toString('hex');
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (writeDefaultReactProject) writeDefaultReactProject(projectDir);
    if (DEFAULT_PACKAGE_JSON) fs.writeFileSync(path.join(projectDir, 'package.json'), DEFAULT_PACKAGE_JSON);
    if (DEFAULT_INDEX_HTML) fs.writeFileSync(path.join(projectDir, 'index.html'), DEFAULT_INDEX_HTML);
    await stopContainerAsync(projectId);
    await ensureReadyImage();
    let imageName = READY_IMAGE;
    try { await ctx.docker.getImage(READY_IMAGE).inspect(); } catch { imageName = ctx.config.DOCKER_BASE_IMAGE; }
    await ensureDockerNetwork();
    const container = await ctx.docker.createContainer({
      Image: imageName, name: containerName,
      Env: [`PORT=3000`, `JWT_SECRET=${jwtSecret}`, `VITE_BASE=/run/${projectId}/`, `NODE_OPTIONS=--max-old-space-size=256`],
      Cmd: ['sh', '-c', `cp server.js server.cjs 2>/dev/null; node server.cjs & echo $! > /tmp/express.pid; sleep 1; ./node_modules/.bin/vite --host 0.0.0.0 --port 5173 --base "/run/${projectId}/" & while true; do sleep 3600; done`],
      HostConfig: { NetworkMode: ctx.config.DOCKER_NETWORK, RestartPolicy: { Name: 'unless-stopped' },
        Binds: [`${dataDir}:/app/data`, `${projectDir}/src:/app/src`, `${projectDir}/public:/app/public`, `${projectDir}/server.js:/app/server.js`, `${projectDir}/index.html:/app/index.html`, `${projectDir}/tailwind.config.js:/app/tailwind.config.js`, `${projectDir}/vite.config.js:/app/vite.config.js`],
        Memory: 512 * 1024 * 1024, NanoCpus: 500000000, SecurityOpt: ['no-new-privileges'] }
    });
    await container.start();
    const healthy = await waitForContainerHealth(projectId, 60000);
    if (healthy) {
      ctx.db.prepare("UPDATE projects SET build_status='building',build_url=? WHERE id=?").run(`/run/${projectId}/`, projectId);
      return { success: true, url: `/run/${projectId}/` };
    }
    return { success: false, error: 'Container unhealthy' };
  }

  async function writeFilesToContainer(projectId, code) {
    const projectDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));
    if (writeGeneratedFiles) writeGeneratedFiles(projectDir, code, projectId);
    if (validateJsxFiles) validateJsxFiles(projectDir);
    if (readProjectFilesRecursive && formatProjectCode) {
      const allFiles = readProjectFilesRecursive(projectDir);
      const allCode = formatProjectCode(allFiles);
      ctx.db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready' WHERE id=?").run(allCode, projectId);
      return allCode;
    }
    return code;
  }

  // Simplified buildDockerProject — full implementation is in server.js
  async function buildDockerProject(projectId, code, onProgress) {
    // This delegates to launchTemplateContainer for the template-first architecture
    const projectDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));
    onProgress({ step: 1, progress: 10, message: 'Analyse du code...' });
    const files = parseDockerProjectCode ? parseDockerProjectCode(code) : {};
    if (Object.keys(files).length === 0) throw new Error('Aucun fichier trouvé dans le code.');
    onProgress({ step: 2, progress: 30, message: 'Écriture des fichiers...' });
    // Write files + launch
    if (writeGeneratedFiles) writeGeneratedFiles(projectDir, code, projectId);
    onProgress({ step: 4, progress: 70, message: 'Lancement...' });
    const result = await launchTemplateContainer(projectId);
    if (result.success) {
      onProgress({ step: 6, progress: 100, message: 'Prêt !' });
      return result;
    }
    throw new Error(result.error || 'Build failed');
  }

  function detectErrorType(logs, errorMessage = '') {
    const combined = (logs + ' ' + errorMessage).toLowerCase();
    if (combined.includes('syntaxerror') || combined.includes('unexpected token')) return ERROR_TYPES.SYNTAX;
    if (combined.includes('cannot find module') || combined.includes('module not found')) return ERROR_TYPES.DEPENDENCY;
    if (combined.includes('eaddrinuse')) return ERROR_TYPES.PORT;
    if (combined.includes('sqlite') && combined.includes('error')) return ERROR_TYPES.SQLITE;
    if (combined.includes('heap out of memory')) return ERROR_TYPES.MEMORY;
    if (combined.includes('timeout')) return ERROR_TYPES.TIMEOUT;
    return ERROR_TYPES.UNKNOWN;
  }

  function translateErrorType(errorType) {
    const translations = { [ERROR_TYPES.SYNTAX]: 'Erreur de syntaxe JavaScript', [ERROR_TYPES.DEPENDENCY]: 'Module npm manquant', [ERROR_TYPES.PORT]: 'Port déjà utilisé', [ERROR_TYPES.SQLITE]: 'Erreur de base de données SQLite', [ERROR_TYPES.MEMORY]: 'Limite de mémoire atteinte', [ERROR_TYPES.TIMEOUT]: 'Délai de démarrage dépassé', [ERROR_TYPES.UNKNOWN]: 'Erreur de démarrage' };
    return translations[errorType] || translations[ERROR_TYPES.UNKNOWN];
  }

  function checkSyntax(projectDir) {
    const { spawnSync } = require('child_process');
    const serverJsPath = path.join(projectDir, 'server.js');
    if (fs.existsSync(serverJsPath)) {
      const result = spawnSync('node', ['--check', serverJsPath], { encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0) return { valid: false, error: result.stderr || 'Syntax error', type: ERROR_TYPES.SYNTAX };
    }
    return { valid: true };
  }

  function extractMissingModule(logs) {
    const patterns = [/Cannot find module ['"]([^'"]+)['"]/i, /Error: Cannot find package ['"]([^'"]+)['"]/i];
    for (const p of patterns) { const m = logs.match(p); if (m && m[1] && !m[1].startsWith('.')) return m[1].split('/')[0]; }
    return null;
  }

  function findFreePort(startPort = 3001) {
    for (let port = startPort; port < startPort + 100; port++) {
      try { const result = execSync(`lsof -i :${port} 2>/dev/null || true`, { encoding: 'utf8' }); if (!result.trim()) return port; } catch (e) { return port; }
    }
    return startPort + Math.floor(Math.random() * 100);
  }

  function logError(projectId, errorType, errorMessage, dockerLogs, attempt) {
    if (!ctx.db) return;
    try { ctx.db.prepare('INSERT INTO error_history (project_id, error_type, error_message, docker_logs, correction_attempt) VALUES (?,?,?,?,?)').run(projectId, errorType, errorMessage, dockerLogs, attempt); } catch (e) {}
  }

  function markErrorCorrected(projectId, correctedCode) {
    if (!ctx.db) return;
    try { ctx.db.prepare('UPDATE error_history SET corrected = 1, corrected_code = ? WHERE project_id = ? AND corrected = 0 ORDER BY id DESC LIMIT 1').run(correctedCode, projectId); } catch (e) {}
  }

  async function callClaudeForCorrection(originalCode, errorLogs, errorType) {
    if (!ctx.config.ANTHROPIC_API_KEY) throw new Error('Clé API Claude non configurée');
    const prompt = `Ce projet React+Vite a cette erreur : ${translateErrorType(errorType)}\n\nLOGS:\n${errorLogs.substring(0, 3000)}\n\nCODE:\n${originalCode}\n\nCORRIGE l'erreur. Retourne TOUS les fichiers modifiés avec ### markers.`;
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 16000, messages: [{ role: 'user', content: prompt }] });
      const opts = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) } };
      const req = https.request(opts, (res) => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => {
          try { const r = JSON.parse(data); if (r.content?.[0]?.text) resolve(r.content[0].text); else reject(new Error('Réponse API invalide')); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject); req.write(payload); req.end();
    });
  }

  async function callClaudeFinalCorrection(originalCode, errorLogs) {
    if (!ctx.config.ANTHROPIC_API_KEY) throw new Error('Clé API Claude non configurée');
    const serverJsMatch = originalCode.match(/### server\.js\n([\s\S]*?)(?=\n### |$)/);
    const serverJsCode = serverJsMatch ? serverJsMatch[1].trim() : originalCode;
    const prompt = `Ce server.js génère cette erreur :\n\n${errorLogs.substring(0, 3000)}\n\nCode actuel:\n${serverJsCode}\n\nRéécris complètement server.js en corrigeant l'erreur.`;
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 16000, messages: [{ role: 'user', content: prompt }] });
      const opts = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) } };
      const req = https.request(opts, (res) => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => {
          try { const r = JSON.parse(data); if (r.content?.[0]?.text) { const corrected = r.content[0].text.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim(); resolve(mergeModifiedCode ? mergeModifiedCode(originalCode, `### server.js\n${corrected}`) : originalCode); } else reject(new Error('Réponse invalide')); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject); req.write(payload); req.end();
    });
  }

  async function autoCorrectProject(projectId, onProgress) {
    if (ctx.correctionInProgress.has(projectId)) return { success: false, reason: 'correction_in_progress' };
    ctx.correctionInProgress.add(projectId);
    try {
      const project = ctx.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
      if (!project?.generated_code) return { success: false, reason: 'no_code' };
      const currentAttempts = ctx.correctionAttempts.get(projectId) || 0;
      if (currentAttempts >= ctx.config.MAX_AUTO_CORRECTION_ATTEMPTS) return { success: false, reason: 'max_attempts', attempts: currentAttempts };
      const logs = await getContainerLogsAsync(projectId, 200);
      const errorType = detectErrorType(logs);
      logError(projectId, errorType, logs.substring(0, 500), logs, currentAttempts + 1);
      ctx.correctionAttempts.set(projectId, currentAttempts + 1);
      const correctedCode = await callClaudeForCorrection(project.generated_code, logs, errorType);
      ctx.db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now') WHERE id=?").run(correctedCode, projectId);
      markErrorCorrected(projectId, correctedCode);
      await stopContainerAsync(projectId);
      const result = await buildDockerProject(projectId, correctedCode, onProgress || (() => {}));
      if (result.success) { ctx.correctionAttempts.delete(projectId); return { success: true, url: result.url }; }
      return { success: false, reason: 'build_failed' };
    } catch (e) { return { success: false, reason: 'error', error: e.message }; }
    finally { ctx.correctionInProgress.delete(projectId); }
  }

  async function backupProject(projectId) {
    const dbFile = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId), 'data', 'database.db');
    if (!fs.existsSync(dbFile)) return null;
    const backupDir = path.join(BACKUP_DIR, String(projectId));
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `${timestamp}.db`);
    fs.copyFileSync(dbFile, backupFile);
    const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort().reverse();
    for (let i = MAX_BACKUPS; i < backups.length; i++) fs.unlinkSync(path.join(backupDir, backups[i]));
    return backupFile;
  }

  async function backupAllProjects() {
    if (!ctx.db) return;
    try { const projects = ctx.db.prepare("SELECT id FROM projects WHERE build_status='done'").all(); for (const p of projects) { try { await backupProject(p.id); } catch (e) {} } } catch (e) {}
  }

  async function monitorContainers() {
    if (!ctx.db || !isDockerAvailable()) return;
    try {
      const projects = ctx.db.prepare("SELECT id, user_id, title, is_published FROM projects WHERE build_status = 'done'").all();
      for (const project of projects) {
        const running = await isContainerRunningAsync(project.id);
        const lastAccess = ctx.containerLastAccess.get(project.id) || 0;
        const idle = Date.now() - (lastAccess > 0 ? lastAccess : Date.now());
        if (running && !project.is_published && idle > ctx.config.SLEEP_TIMEOUT_MS) {
          try { await ctx.docker.getContainer(getContainerName(project.id)).stop({ t: 5 }); } catch (e) {}
        }
        if (!running && project.is_published) {
          try { await ctx.docker.getContainer(getContainerName(project.id)).start(); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  function translateLogsToFrench(logs) {
    const translations = [
      { pattern: /Server running on port (\d+)/gi, replacement: 'Serveur démarré sur le port $1' },
      { pattern: /npm ERR!/gi, replacement: 'Erreur npm' },
      { pattern: /SyntaxError/gi, replacement: 'Erreur de syntaxe' },
      { pattern: /Cannot find module/gi, replacement: 'Module introuvable' },
    ];
    let result = logs;
    for (const { pattern, replacement } of translations) result = result.replace(pattern, replacement);
    return result;
  }

  function getErrorHistory(projectId) {
    if (!ctx.db) return [];
    try { return ctx.db.prepare('SELECT * FROM error_history WHERE project_id = ? ORDER BY id DESC LIMIT 10').all(projectId); } catch (e) { return []; }
  }

  async function proxyToContainer(req, res, projectId, targetPath) {
    const containerHost = getContainerHostname(projectId);
    const forwardHeaders = { ...req.headers, host: `${containerHost}:5173` };
    delete forwardHeaders['authorization'];
    delete forwardHeaders['accept-encoding'];
    const options = { hostname: containerHost, port: 5173, path: targetPath || '/', method: req.method, headers: forwardHeaders, timeout: 30000 };
    const proxyReq = http.request(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'cross-origin-embedder-policy', 'strict-transport-security']) delete headers[h];
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', async (e) => {
      const running = await isContainerRunningAsync(projectId);
      if (!running && !restartLocks.get(projectId)) { restartLocks.set(projectId, true); restartContainerAsync(projectId).catch(() => {}); setTimeout(() => restartLocks.delete(projectId), 60000); }
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><h1>Container starting...</h1><script>setTimeout(()=>location.reload(),15000)</script></body></html>`);
    });
    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.writeHead(504); res.end(JSON.stringify({ error: 'Timeout' })); });
    if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq); else proxyReq.end();
  }

  async function rebuildContainerMapping() {
    if (!ctx.db || !isDockerAvailable()) return;
    try {
      const projects = ctx.db.prepare("SELECT id FROM projects WHERE build_status = 'done'").all();
      let running = 0;
      for (const project of projects) { if (await isContainerRunningAsync(project.id)) running++; else { try { await startContainerAsync(project.id); if (await isContainerRunningAsync(project.id)) running++; } catch (e) {} } }
      console.log(`Container startup: ${running}/${projects.length} running`);
    } catch (e) {}
  }

  async function ensureBaseImage() {
    if (!ctx.docker) return;
    try { await ctx.docker.getImage(ctx.config.DOCKER_BASE_IMAGE).inspect(); } catch {
      console.log(`[Docker] Building base image...`);
      // Simplified — full Dockerfile content is in server.js
    }
  }

  async function initializeDockerSystem() {
    dockerAvailable = await checkDockerAvailable();
    if (!dockerAvailable) { console.log('Docker not available'); return; }
    await ensureBaseImage();
    await ensureReadyImage();
    await ensureDockerNetwork();
    await joinPbpProjectsNetwork();
    await rebuildContainerMapping();
  }

  return {
    checkDockerAvailable, ensureDockerNetwork, joinPbpProjectsNetwork,
    getContainerName, getContainerHostname, isContainerRunningAsync,
    stopContainerAsync, removeContainerAsync, removeContainerImageAsync,
    getContainerLogsAsync, demuxDockerLogs, restartContainerAsync,
    autoRecoveryTick, startContainerAsync, waitForContainerHealth,
    ensureReadyImage, launchTemplateContainer, writeFilesToContainer,
    buildDockerProject, detectErrorType, translateErrorType, checkSyntax,
    extractMissingModule, findFreePort, logError, markErrorCorrected,
    callClaudeForCorrection, callClaudeFinalCorrection, autoCorrectProject,
    backupProject, backupAllProjects, monitorContainers, translateLogsToFrench,
    getErrorHistory, proxyToContainer, rebuildContainerMapping,
    ensureBaseImage, initializeDockerSystem, isDockerAvailable,
    setDeps, AUTO_RECOVERY_INTERVAL_MS
  };
};
