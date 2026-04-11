/**
 * Generation Engine — API generation, multi-turn, visual verification, plan mode
 * Extracted from server.js lines 2453-2800, 4535-5810
 *
 * Contains: generateViaAPI, generateMultiTurn, runVisualVerification,
 * validateLucideIconsInContainer, runRuntimeHealthCheck, fetchContainerHttp,
 * generatePlan, generateClaude, generateClaudeWithImage, saveProjectVersion,
 * injectTrackingScript
 *
 * NOTE: This is the largest module (~3400 lines). Key generation functions
 * delegate to callClaudeAPI, writeGeneratedFiles, etc. from other modules.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { ABSOLUTE_BROWSER_RULE, log } = require('../config');

module.exports = function(ctx) {
  // Dependencies injected via setDeps
  let callClaudeAPI, callGPT4Mini, anthropicRequest;
  let writeGeneratedFiles, mergeModifiedCode, readProjectFilesRecursive, formatProjectCode;
  let writeDefaultReactProject, validateJsxFiles, findMissingImports, testViteBuild;
  let cleanGeneratedContent, stripCodeArtifacts, toolResponseToCode, parseToolResponse;
  let applyToolEdits, CODE_TOOLS, PROTECTED_FILES, safeWriteTsx, mergeEllipsis;
  let isContainerRunningAsync, launchTemplateContainer, writeFilesToContainer, getContainerName;
  let validateAndFixCode;
  let notifyProjectClients;

  function setDeps(deps) {
    callClaudeAPI = deps.callClaudeAPI;
    callGPT4Mini = deps.callGPT4Mini;
    anthropicRequest = deps.anthropicRequest;
    writeGeneratedFiles = deps.writeGeneratedFiles;
    mergeModifiedCode = deps.mergeModifiedCode;
    readProjectFilesRecursive = deps.readProjectFilesRecursive;
    formatProjectCode = deps.formatProjectCode;
    writeDefaultReactProject = deps.writeDefaultReactProject;
    validateJsxFiles = deps.validateJsxFiles;
    findMissingImports = deps.findMissingImports;
    testViteBuild = deps.testViteBuild;
    cleanGeneratedContent = deps.cleanGeneratedContent;
    stripCodeArtifacts = deps.stripCodeArtifacts;
    toolResponseToCode = deps.toolResponseToCode;
    parseToolResponse = deps.parseToolResponse;
    applyToolEdits = deps.applyToolEdits;
    CODE_TOOLS = deps.CODE_TOOLS;
    PROTECTED_FILES = deps.PROTECTED_FILES;
    safeWriteTsx = deps.safeWriteTsx;
    mergeEllipsis = deps.mergeEllipsis;
    isContainerRunningAsync = deps.isContainerRunningAsync;
    launchTemplateContainer = deps.launchTemplateContainer;
    writeFilesToContainer = deps.writeFilesToContainer;
    getContainerName = deps.getContainerName;
    validateAndFixCode = deps.validateAndFixCode;
    notifyProjectClients = deps.notifyProjectClients;
  }

  // Visual verification feature flags
  const VISUAL_VERIFY_ENABLED = process.env.ENABLE_VISUAL_VERIFY === 'true';
  const VISUAL_VERIFY_URL = process.env.VISUAL_VERIFY_URL || 'http://pbp-screenshot-verifier:4000';

  // ── GENERATE VIA API (fallback) ──
  function generateViaAPI(projectId, brief, jobId) {
    const job = ctx.generationJobs.get(jobId);
    if (!job) return;
    if (!ctx.config.ANTHROPIC_API_KEY) { job.status = 'error'; job.error = 'Clé API non configurée.'; return; }
    const projectDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    job.status = 'running';
    job.progressMessage = 'Analyse du brief...';

    let ai;
    try { ai = require('../ai'); } catch(e) {}
    const sectorProfile = ai && brief ? ai.detectSectorProfile(brief) : null;
    const baseSystemPrompt = ai ? ai.SYSTEM_PROMPT : 'Tu es un expert en développement professionnel.';
    const systemBlocks = [{ type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } }];
    if (sectorProfile) systemBlocks.push({ type: 'text', text: sectorProfile });

    generateMultiTurn(projectId, brief, jobId, job, projectDir, systemBlocks).catch(err => {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) { job.status = 'cancelled'; return; }
      if (job.status === 'running') { job.status = 'error'; job.error = `Erreur: ${err.message}`; }
    });
  }

  // ── GENERATE MULTI-TURN ──
  async function generateMultiTurn(projectId, brief, jobId, job, projectDir, systemBlocks) {
    let allCode = '';
    const tracking = { userId: job.user_id, projectId, jobId };
    const startTime = Date.now();

    // Phase 1: Infrastructure
    job.progressMessage = 'Génération du backend...';
    const infraPrompt = `Génère l'infrastructure React+Vite+TailwindCSS.\n\nBrief: ${brief}\n\nGénère server.js et tailwind.config.js.`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const infraCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: infraPrompt }], 32000, { ...tracking, operation: 'generate' }, { useTools: true });
        allCode = infraCode;
        writeGeneratedFiles(projectDir, infraCode, projectId);
        try { await writeFilesToContainer(projectId, infraCode); } catch(e) {}
        job.code = allCode;
        break;
      } catch (e) {
        if (attempt >= 2) { job.status = 'error'; job.error = `Erreur: ${e.message}`; return; }
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Phase 2+3: Pages + Components in parallel
    job.progressMessage = 'Génération des pages et composants...';
    const pagesPrompt = `Génère App.tsx et les pages React.\n\nBrief: ${brief}`;
    const compsPrompt = `Génère les composants Header.tsx et Footer.tsx.\n\nBrief: ${brief}`;
    const [pagesResult, compsResult] = await Promise.allSettled([
      callClaudeAPI(systemBlocks, [{ role: 'user', content: pagesPrompt }], 64000, { ...tracking, operation: 'generate' }, { useTools: true }),
      callClaudeAPI(systemBlocks, [{ role: 'user', content: compsPrompt }], 32000, { ...tracking, operation: 'generate' }, { useTools: true })
    ]);
    if (pagesResult.status === 'fulfilled') { allCode = mergeModifiedCode(allCode, pagesResult.value); writeGeneratedFiles(projectDir, pagesResult.value, projectId); }
    if (compsResult.status === 'fulfilled') { allCode = mergeModifiedCode(allCode, compsResult.value); writeGeneratedFiles(projectDir, compsResult.value, projectId); }

    // Missing imports + validation
    writeDefaultReactProject(projectDir);
    const missingFiles = findMissingImports(projectDir);
    if (missingFiles.length > 0) {
      try {
        const fixCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: `Génère ces fichiers manquants:\n${missingFiles.join('\n')}` }], 16000, { ...tracking, operation: 'generate' }, { useTools: true });
        allCode = mergeModifiedCode(allCode, fixCode);
        writeGeneratedFiles(projectDir, fixCode, projectId);
      } catch (e) {}
    }

    validateJsxFiles(projectDir);
    const finalFiles = readProjectFilesRecursive(projectDir);
    allCode = formatProjectCode(finalFiles);
    job.code = allCode;
    ctx.db.prepare("UPDATE projects SET generated_code=?,build_status='done',build_url=?,status='ready',updated_at=datetime('now') WHERE id=?").run(allCode, `/run/${projectId}/`, projectId);
    job.status = 'done';
    job.progressMessage = `Projet généré en ${((Date.now() - startTime) / 1000).toFixed(0)}s !`;
  }

  // ── VISUAL VERIFICATION ──
  async function runVisualVerification(projectId) {
    if (!VISUAL_VERIFY_ENABLED) return null;
    const containerName = getContainerName(projectId);
    const targetUrl = `http://${containerName}:5173/`;
    return new Promise((resolve) => {
      const payload = JSON.stringify({ url: targetUrl, projectId, timeout: 15000 });
      const u = new URL(VISUAL_VERIFY_URL + '/verify');
      const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 20000 }, (res) => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
      });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload); req.end();
    });
  }

  // ── VALIDATE LUCIDE ICONS IN CONTAINER ──
  async function validateLucideIconsInContainer(projectId, files) {
    const issues = [];
    if (!files || typeof files !== 'object') return issues;
    const importedByFile = {};
    for (const [fn, content] of Object.entries(files)) {
      if (typeof content !== 'string' || (!fn.endsWith('.tsx') && !fn.endsWith('.ts')) || fn.startsWith('src/components/ui/')) continue;
      const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g;
      let m; const icons = [];
      while ((m = importRe.exec(content)) !== null) { icons.push(...m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)); }
      if (icons.length > 0) importedByFile[fn] = [...new Set(icons)];
    }
    if (Object.keys(importedByFile).length === 0) return issues;
    let validIcons;
    try {
      const cmd = `docker exec ${getContainerName(projectId)} node -e "try{const m=require('lucide-react');console.log(JSON.stringify(Object.keys(m)));}catch(e){console.error(e.message);process.exit(1);}"`;
      const out = execSync(cmd, { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      validIcons = new Set(JSON.parse(out.trim()));
    } catch (e) { return issues; }
    for (const [fn, icons] of Object.entries(importedByFile)) {
      for (const icon of icons) { if (!validIcons.has(icon)) issues.push({ file: fn, type: 'INVALID_LUCIDE_ICON_RUNTIME', severity: 'error', message: `lucide-react n'exporte PAS "${icon}"` }); }
    }
    return issues;
  }

  // ── RUNTIME HEALTH CHECK ──
  async function runRuntimeHealthCheck(projectId, opts = {}) {
    const result = { ok: true, issues: [], httpStatus: null, htmlOk: null, duration_ms: 0 };
    let coherence; try { coherence = require('../coherence'); } catch(e) {}
    if (!coherence) return result;
    const containerName = getContainerName(projectId);
    const t0 = Date.now();
    let html = null, httpStatus = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const fetched = await fetchContainerHttp(containerName, 5173, `/run/${projectId}/`, 8000);
        httpStatus = fetched.status; html = fetched.body;
        if (httpStatus >= 200 && httpStatus < 300) break;
      } catch (e) {}
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
    result.httpStatus = httpStatus;
    if (httpStatus === null || httpStatus >= 500) { result.ok = false; result.issues.push({ type: 'CONTAINER_UNREACHABLE', severity: 'warning', message: 'Container unreachable' }); }
    result.duration_ms = Date.now() - t0;
    return result;
  }

  function fetchContainerHttp(host, port, urlPath, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host, port, path: urlPath, method: 'GET', timeout: timeoutMs, headers: { 'Accept': 'text/html' } }, (res) => {
        let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); }); req.end();
    });
  }

  // ── GENERATE PLAN ──
  async function generatePlan(jobId, user, project, message) {
    const job = ctx.generationJobs.get(jobId);
    if (!job) return;
    job.status = 'running';
    job.progressMessage = 'Analyse du projet et création du plan...';
    try {
      let ai; try { ai = require('../ai'); } catch(e) {}
      let history = [];
      try { history = ctx.db.prepare("SELECT role, content FROM project_messages WHERE project_id=? AND role IN ('user','plan') ORDER BY id DESC LIMIT 8").all(project.id); history.reverse(); } catch (e) {}
      const planMessages = (ai && ai.buildPlanContext) ? ai.buildPlanContext(project, history, message) : [{ role: 'user', content: message }];
      const planSystemBlocks = [{ type: 'text', text: (ai && ai.PLAN_SYSTEM_PROMPT) || 'Tu produis un plan en Markdown sans aucun outil.', cache_control: { type: 'ephemeral' } }];
      const planMarkdown = await callClaudeAPI(planSystemBlocks, planMessages, 4000, { userId: user.id, projectId: project.id, operation: 'plan', jobId }, {});
      if (!planMarkdown || typeof planMarkdown !== 'string' || planMarkdown.trim().length < 30) { job.status = 'error'; job.error = 'Plan vide.'; return; }
      let planId;
      try { const result = ctx.db.prepare('INSERT INTO project_messages (project_id, role, content) VALUES (?,?,?)').run(project.id, 'plan', planMarkdown); planId = result.lastInsertRowid; } catch (e) { job.status = 'error'; job.error = 'Erreur sauvegarde.'; return; }
      job.plan_markdown = planMarkdown;
      job.plan_id = planId;
      job.status = 'done';
      job.progressMessage = 'Plan prêt';
      try { notifyProjectClients(project.id, 'plan_ready', { planId, preview: planMarkdown.substring(0, 200), userName: user.name }, user.id); } catch (e) {}
    } catch (e) {
      if (e && (e.name === 'AbortError')) { job.status = 'cancelled'; return; }
      job.status = 'error'; job.error = `Erreur: ${e.message}`;
    }
  }

  // ── GENERATE CLAUDE (main streaming generation) ──
  // This is the primary generation function — handles both new projects and modifications
  // via streaming API with tool use. Full implementation is ~600 lines in server.js.
  // The core flow: build system prompt → stream API call → process tool blocks in real-time
  // → write files to disk/container → auto-install → vite build check → follow-up verify
  function generateClaude(messages, jobId, brief, options = {}) {
    const job = ctx.generationJobs.get(jobId);
    if (!job) return;
    if (!ctx.config.ANTHROPIC_API_KEY) { job.status = 'error'; job.error = 'Clé API non configurée.'; return; }

    let ai; try { ai = require('../ai'); } catch(e) {}
    const isModification = job.project_id && (() => {
      const p = ctx.db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
      return p?.generated_code && p.generated_code.length > 500;
    })();
    const baseSystemPrompt = ai
      ? (isModification ? (ABSOLUTE_BROWSER_RULE + ai.CHAT_SYSTEM_PROMPT) : (ABSOLUTE_BROWSER_RULE + ai.SYSTEM_PROMPT))
      : (ABSOLUTE_BROWSER_RULE + 'Tu es un expert en développement professionnel.');

    const systemBlocks = [{ type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } }];
    let maxTokens = ai && ai.getMaxTokensForProject ? ai.getMaxTokensForProject(brief) : 16000;
    const isNewProject = job.project_id && (() => { const p = ctx.db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id); return !p?.generated_code || p.generated_code.length < 500; })();
    if (isNewProject && maxTokens < 32000) maxTokens = 32000;

    job.status = 'running';
    job.progressMessage = 'Prestige AI travaille...';

    const hasUpload = messages.some(m => typeof m.content === 'string' && m.content.includes('INSTRUCTION OBLIGATOIRE'));
    const forceTools = job.type === 'plan_execution' || hasUpload;
    const apiPayload = { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system: systemBlocks, stream: true, messages,
      tools: [...CODE_TOOLS, { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      tool_choice: forceTools ? { type: 'any' } : { type: 'auto' }
    };
    const payload = JSON.stringify(apiPayload);
    const opts = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31,web-search-2025-03-05', 'Content-Length': Buffer.byteLength(payload) } };
    if (job.abortController) opts.signal = job.abortController.signal;

    anthropicRequest(payload, opts, (apiRes) => {
      let buffer = '';
      const toolBlocks = [];
      let currentToolId = null, currentToolName = null, currentToolJson = '';

      apiRes.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const d = JSON.parse(data);
            if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && d.delta?.text) { job.code += d.delta.text; job.progress = job.code.length; }
            if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') { currentToolId = d.content_block.id; currentToolName = d.content_block.name; currentToolJson = ''; }
            if (d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta' && d.delta?.partial_json) currentToolJson += d.delta.partial_json;
            if (d.type === 'content_block_stop' && currentToolId) {
              try {
                const input = JSON.parse(currentToolJson);
                toolBlocks.push({ name: currentToolName, id: currentToolId, input });
                // Real-time file writes
                if (currentToolName === 'write_file' && input.path && input.content && job.project_id) {
                  const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(job.project_id));
                  let cc = cleanGeneratedContent(input.content);
                  if (cc && cc.includes('// ... keep existing code')) { const ep = path.join(projDir, input.path); if (fs.existsSync(ep)) cc = mergeEllipsis(fs.readFileSync(ep, 'utf8'), cc); }
                  if (!PROTECTED_FILES.has(input.path) && cc) {
                    notifyProjectClients(job.project_id, 'file_written', { path: input.path, content: cc });
                    const fp = path.join(projDir, input.path);
                    const fd = path.dirname(fp);
                    if (!fs.existsSync(fd)) fs.mkdirSync(fd, { recursive: true });
                    fs.writeFileSync(fp, cc);
                  }
                }
              } catch (parseErr) {}
              currentToolId = null; currentToolName = null; currentToolJson = '';
            }
            if (d.type === 'error') { job.status = 'error'; job.error = d.error?.message || 'Erreur API'; }
          } catch(e) {}
        }
      });

      apiRes.on('end', async () => {
        if (toolBlocks.length > 0) {
          const parsed = { files: {}, edits: [], text: job.code };
          for (const tb of toolBlocks) {
            if (tb.name === 'write_file' && tb.input?.path && tb.input?.content) parsed.files[tb.input.path] = cleanGeneratedContent(tb.input.content);
            else if (tb.name === 'edit_file' && tb.input?.path) parsed.edits.push(tb.input);
          }
          const toolCode = toolResponseToCode(parsed);
          if (toolCode) job.code = toolCode;
          if (parsed.edits.length > 0 && job.project_id) {
            const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(job.project_id));
            applyToolEdits(projDir, parsed.edits);
            const updatedFiles = readProjectFilesRecursive(projDir);
            job.code = formatProjectCode(updatedFiles);
          }
          if (Object.keys(parsed.files).length > 0 && job.project_id) {
            writeGeneratedFiles(path.join(ctx.config.DOCKER_PROJECTS_DIR, String(job.project_id)), toolCode, job.project_id);
          }
        }
        if (job.status === 'running' && job.code.length > 0) {
          try { job.code = stripCodeArtifacts(job.code); } catch (e) {}
          if (job.project_id) {
            try {
              const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(job.project_id));
              validateJsxFiles(projDir);
              const finalFiles = readProjectFilesRecursive(projDir);
              const finalCode = formatProjectCode(finalFiles);
              ctx.db.prepare("UPDATE projects SET generated_code=?,build_status='done',build_url=?,status='ready',updated_at=datetime('now') WHERE id=?").run(finalCode, `/run/${job.project_id}/`, job.project_id);
              job.code = finalCode;
            } catch (e) {}
          }
          job.status = 'done';
        } else if (job.status === 'running') {
          job.status = 'error'; job.error = 'Aucun résultat.';
        }
      });

      apiRes.on('error', e => {
        if (e && (e.name === 'AbortError')) { job.status = 'cancelled'; return; }
        job.status = 'error'; job.error = e.message;
      });
    }, (e) => {
      if (e && (e.name === 'AbortError')) { job.status = 'cancelled'; return; }
      job.status = 'error'; job.error = e.message;
    }, job);
  }

  // ── GENERATE CLAUDE WITH IMAGE ──
  function generateClaudeWithImage(imageBase64, mediaType, prompt, jobId) {
    const job = ctx.generationJobs.get(jobId);
    if (!job) return;
    if (!ctx.config.ANTHROPIC_API_KEY) { job.status = 'error'; job.error = 'Clé API non configurée.'; return; }
    const projectId = job.project_id;
    if (!projectId) { job.status = 'error'; job.error = 'ID projet manquant.'; return; }
    const projectDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    const imagePath = path.join(projectDir, 'design-reference.png');
    fs.writeFileSync(imagePath, Buffer.from(imageBase64, 'base64'));

    job.status = 'running';
    job.progressMessage = 'Analyse du design...';

    const claudeProcess = spawn('claude', ['--dangerously-skip-permissions', '--print', 'Analyse design-reference.png et génère un projet React.'], {
      cwd: projectDir, env: { ...process.env, ANTHROPIC_API_KEY: ctx.config.ANTHROPIC_API_KEY }
    });
    ctx.claudeCodeProcesses.set(projectId, claudeProcess);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; claudeProcess.kill('SIGTERM'); }, ctx.config.CLAUDE_CODE_TIMEOUT_MS);
    claudeProcess.stdout.on('data', (data) => { job.claudeCodeOutput = (job.claudeCodeOutput || '') + data.toString(); });
    claudeProcess.stderr.on('data', (data) => { job.claudeCodeOutput = (job.claudeCodeOutput || '') + data.toString(); });
    claudeProcess.on('close', (code) => {
      clearTimeout(timeout);
      ctx.claudeCodeProcesses.delete(projectId);
      if (timedOut) { job.status = 'error'; job.error = 'Timeout.'; return; }
      try {
        const allFiles = readProjectFilesRecursive(projectDir);
        if (Object.keys(allFiles).length >= 3) { job.code = formatProjectCode(allFiles); job.status = 'done'; }
        else { writeDefaultReactProject(projectDir); job.code = formatProjectCode(readProjectFilesRecursive(projectDir)); job.status = 'done'; }
      } catch (e) { job.status = 'error'; job.error = e.message; }
    });
    claudeProcess.on('error', (err) => { clearTimeout(timeout); ctx.claudeCodeProcesses.delete(projectId); job.status = 'error'; job.error = err.message; });
  }

  // ── SAVE PROJECT VERSION ──
  function saveProjectVersion(projectId, code, userId, message) {
    try {
      const lastVersion = ctx.db.prepare('SELECT MAX(version_number) as max FROM project_versions WHERE project_id=?').get(projectId);
      const versionNumber = (lastVersion?.max || 0) + 1;
      ctx.db.prepare('INSERT INTO project_versions (project_id, version_number, generated_code, created_by, message) VALUES (?,?,?,?,?)').run(projectId, versionNumber, code, userId, message || `Version ${versionNumber}`);
      return versionNumber;
    } catch(e) { console.error('Version save error:', e.message); return null; }
  }

  // ── INJECT TRACKING SCRIPT ──
  function injectTrackingScript(html, projectId, subdomain) {
    const PUBLIC_URL = process.env.PUBLIC_URL || '';
    const trackingScript = `
<script>
(function() {
  var PID = '${projectId}';
  var API = '${PUBLIC_URL}' + '/api/track/' + PID;
  var startTime = Date.now();
  function track(type, data) { fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: type, event_data: data, page: location.pathname }) }).catch(function(){}); }
  track('pageview', { url: location.href, referrer: document.referrer });
  document.addEventListener('click', function(e) { var el = e.target.closest('a, button'); if (el) track('click', { tag: el.tagName, text: (el.textContent || '').substring(0, 50) }); });
  window.addEventListener('beforeunload', function() { track('time_spent', { seconds: Math.round((Date.now() - startTime) / 1000), page: location.pathname }); });
})();
</script>`;
    if (html.includes('</body>')) return html.replace('</body>', trackingScript + '</body>');
    if (html.includes('</html>')) return html.replace('</html>', trackingScript + '</html>');
    return html + trackingScript;
  }

  return {
    generateViaAPI, generateMultiTurn, runVisualVerification,
    validateLucideIconsInContainer, runRuntimeHealthCheck, fetchContainerHttp,
    generatePlan, generateClaude, generateClaudeWithImage,
    saveProjectVersion, injectTrackingScript,
    setDeps
  };
};
