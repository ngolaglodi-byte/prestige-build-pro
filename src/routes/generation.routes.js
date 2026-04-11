// ─── GENERATION ROUTES ───
// AI generation, jobs, plans, feedback, hot-reload, admin AI stats

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const crypto = require('crypto');
  const path = require('path');
  const fs = require('fs');
  const db = ctx.db;
  const generationJobs = ctx.generationJobs;
  const cache = ctx.cache;
  const ai = ctx.ai;
  const log = ctx.log;
  const {
    generateClaude, generateClaudeWithImage, generatePlan,
    callClaudeAPI, classifyIntent, needsClarification,
    generateClarificationQuestions, checkUserQuota, selectFilesWithLLM,
    savePreviewFiles, saveProjectVersion, extractCredentials, stripCodeArtifacts,
    notifyProjectClients, getProjectCollaborators,
    writeGeneratedFiles, readProjectFilesRecursive, formatProjectCode,
    isDockerAvailable, getContainerName, isContainerRunningAsync, getContainerLogsAsync,
    validateString, validateId
  } = ctx.services;
  const { activeGenerations, MAX_CONCURRENT_GENERATIONS, OPENAI_API_KEY,
    DOCKER_PROJECTS_DIR, executedPlans, MAX_TRACKED_EXECUTED_PLANS,
    clientLogs, CODE_TOOLS, containerExecService, conversationMemoryService,
    agentModeService, docker
  } = ctx;

  // ─── GET JOB STATUS (POLLING) ───
  router.get('/api/jobs/:id', async (req, res) => {
    const user = req.user;
    const jobId = req.params.id;
    const job = generationJobs.get(jobId);
    if (!job) { json(res, 404, { error: 'Job non trouvé' }); return; }

    // Only the job owner can access it
    if (job.user_id !== user.id) { json(res, 403, { error: 'Accès refusé' }); return; }

    // ─── PLAN JOBS: lightweight finalize (no code artifacts) ───
    if (job.status === 'done' && job.type === 'plan' && !job.finalized) {
      job.finalized = true;
    }

    // If done, finalize project and cleanup (code generation jobs only)
    if (job.status === 'done' && job.project_id && job.type !== 'plan' && !job.finalized) {
      // Set finalized FIRST to prevent race condition with concurrent poll requests
      job.finalized = true;
      // Final artifact cleanup before persisting to DB
      const fullCode = stripCodeArtifacts(job.code);
      db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(job.project_id, 'assistant', fullCode);
      db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready',version=version+1 WHERE id=?").run(fullCode, job.project_id);
      saveProjectVersion(job.project_id, fullCode, user.id, `Génération via chat: ${(job.message || '').substring(0,50)}...`);
      try {
        const previewResult = savePreviewFiles(job.project_id, fullCode);
        job.preview_url = `/run/${job.project_id}/`;
        job.framework = previewResult.framework;
      } catch(e) {
        console.error('Preview save error:', e.message);
      }
      // Extract admin credentials from generated code
      const creds = extractCredentials(fullCode);
      if (creds) {
        job.credentials = creds;
        const credMsg = `✅ Projet prêt ! Identifiants admin : ${creds.email} / ${creds.password}`;
        db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(job.project_id, 'assistant', credMsg);
      }
      // Extract conversational message and suggestions from Claude response
      const sugMatch = fullCode.match(/SUGGESTIONS:\s*(.+)/);
      if (sugMatch) {
        job.suggestions = sugMatch[1].split('|').map(s => s.trim()).filter(Boolean);
      } else {
        // Generate sector-based suggestions
        const project = db.prepare('SELECT brief FROM projects WHERE id=?').get(job.project_id);
        if (ai && project) {
          job.suggestions = ai.getSuggestionsForSector(project.brief).slice(0, 3);
        }
      }
      // Extract conversational message (text before ### markers)
      const convoMatch = fullCode.match(/^([\s\S]*?)(?=###\s)/);
      if (convoMatch && convoMatch[1].trim().length > 5 && convoMatch[1].trim().length < 500) {
        job.chat_message = convoMatch[1].trim();
      }
      notifyProjectClients(job.project_id, 'code_updated', {
        userName: user.name,
        previewUrl: `/run/${job.project_id}/`,
        message: `${user.name} a généré une nouvelle version`
      }, user.id);
      if (ctx.activeGenerations > 0) ctx.activeGenerations--;
    }
    // Also decrement counter on error (prevents counter leak blocking all future generations)
    if (job.status === 'error' && !job.finalized) {
      job.finalized = true;
      if (ctx.activeGenerations > 0) ctx.activeGenerations--;
    }
    // ─── CANCELLED jobs: cleanup like error path, but distinct status ───
    if (job.status === 'cancelled' && !job.finalized) {
      job.finalized = true;
      if (ctx.activeGenerations > 0 && job.type !== 'plan') ctx.activeGenerations--;
      log('info', 'job', 'finalized as cancelled', { jobId, projectId: job.project_id, userId: job.user_id });
    }

    // Return user-friendly message from Claude Code progress
    const progressMessage = job.progressMessage || (job.status === 'pending' ? 'En attente...' :
      job.status === 'running' ? 'Génération en cours...' :
      job.status === 'done' ? 'Terminé !' :
      job.status === 'error' ? 'Erreur' :
      job.status === 'cancelled' ? 'Génération annulée' : 'En cours...');

    json(res, 200, {
      job_id: jobId,
      status: job.status,
      type: job.type || 'generate',
      code: job.code,
      error: job.error,
      progress: job.progress,
      progress_message: progressMessage,
      preview_url: job.preview_url,
      framework: job.framework,
      credentials: job.credentials || null,
      suggestions: job.suggestions || null,
      chat_message: job.chat_message || null,
      plan_markdown: job.plan_markdown || null,
      plan_id: job.plan_id || null,
      coherence_warnings: job.coherence_warnings || null,
      runtime_warnings: job.runtime_warnings || null,
      visual_warnings: job.visual_warnings || null
    });
  });

  // ─── STOP A RUNNING JOB ───
  router.post('/api/generate/stop/:id', async (req, res) => {
    const user = req.user;
    const jobId = req.params.id;
    const job = generationJobs.get(jobId);
    if (!job) { json(res, 404, { error: 'Job introuvable.' }); return; }

    // Owner-only (admin can stop too)
    if (user.role !== 'admin' && job.user_id !== user.id) {
      json(res, 403, { error: 'Accès refusé à ce job.' });
      return;
    }

    // Idempotent: already finished or cancelled
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      json(res, 200, { job_id: jobId, status: job.status, already: true });
      return;
    }

    // Trigger abort
    if (job.abortController && !job.abortController.signal.aborted) {
      try {
        job.abortController.abort();
        log('info', 'job', 'stop requested', { jobId, projectId: job.project_id, userId: user.id });
      } catch (e) {
        log('error', 'job', 'abort threw', { jobId, error: e.message });
      }
    }

    // Set transitional state
    if (job.status !== 'cancelled') {
      job.progressMessage = 'Annulation en cours...';
    }

    // Notify SSE so other collaborators see the stop
    if (job.project_id) {
      try {
        notifyProjectClients(job.project_id, 'user_action', {
          action: 'generation_stopped',
          userName: user.name
        }, user.id);
      } catch (_) { /* swallow */ }
    }

    json(res, 200, { job_id: jobId, status: 'cancelling' });
  });

  // ─── GENERATE START (POLLING) ───
  router.post('/api/generate/start', async (req, res) => {
    const user = req.user;
    const {project_id, message, skip_clarification, mode}=await getBody(req);

    // Validate input
    if (!message || typeof message !== 'string' || message.trim().length < 3) {
      json(res, 400, { error: 'Message requis (min 3 caractères).' }); return;
    }

    // ─── CLARIFICATION PROTOCOL ───
    if (!skip_clarification && project_id) {
      const projectForCheck = db.prepare('SELECT user_id, generated_code FROM projects WHERE id=?').get(project_id);
      if (projectForCheck && (user.role === 'admin' || projectForCheck.user_id === user.id)) {
        if (needsClarification(message, projectForCheck)) {
          try {
            const questions = await generateClarificationQuestions(message, user.id, project_id);
            log('info', 'clarify', 'asked', { userId: user.id, projectId: project_id, count: questions.length });
            json(res, 200, { type: 'clarification_needed', questions, original_message: message });
          } catch (e) {
            log('warn', 'clarify', 'failed open', { error: e.message });
          }
          if (res.headersSent || res.writableEnded) return;
        }
      }
    }

    // Check concurrent generation limit
    if (ctx.activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      json(res, 429, { error: `Serveur occupé (${ctx.activeGenerations}/${MAX_CONCURRENT_GENERATIONS} générations en cours). Réessayez dans 30 secondes.` }); return;
    }

    // Check user quota before starting generation
    const quota = checkUserQuota(user.id);
    if (!quota.allowed) {
      json(res, 429, { error: quota.reason, quota: { daily: quota.daily, dailyLimit: quota.dailyLimit, monthly: quota.monthly, monthlyLimit: quota.monthlyLimit } });
      return;
    }

    // Detect intent: LLM-based classifier with regex fallback
    const intentResult = await classifyIntent(message);
    const isQuestion = intentResult.intent === 'discuss';
    log('info', 'intent', 'classified', { intent: intentResult.intent, confidence: intentResult.confidence, source: intentResult.source });

    const jobId = crypto.randomUUID();

    // Initialize job in Map (with AbortController for user-initiated stop)
    generationJobs.set(jobId, {
      status: 'pending',
      code: '',
      error: null,
      progress: 0,
      project_id: project_id,
      user_id: user.id,
      message: message,
      finalized: false,
      abortController: new AbortController()
    });

    // Return immediately with job_id
    json(res, 200, { job_id: jobId, status: 'pending' });

    // Start generation in background
    let project = null, history = [];
    if (project_id) {
      project = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
      history = db.prepare('SELECT role,content FROM project_messages WHERE project_id=? ORDER BY id ASC LIMIT 30').all(project_id);
      notifyProjectClients(project_id, 'user_action', { action: 'generating', userName: user.name }, user.id);
    }
    const savedApis = db.prepare('SELECT name,service,description FROM api_keys').all();
    const projectKeys = project_id ? db.prepare('SELECT env_name, service FROM project_api_keys WHERE project_id=?').all(project_id) : [];
    let userMsg = ai ? ai.buildProfessionalPrompt(message, project, savedApis) : message;

    // ── LOVABLE TWO-TIER: GPT-4 Mini selects files BEFORE Claude Sonnet generates ──
    let llmSelectedFiles = null;
    if (OPENAI_API_KEY && project?.generated_code && ai) {
      try {
        const files = ai.parseCodeFiles ? ai.parseCodeFiles(project.generated_code) : {};
        const fileList = Object.keys(files).map(fn => {
          const size = (files[fn] || '').length;
          return `  ${fn} (${size} chars)`;
        }).join('\n');
        llmSelectedFiles = await selectFilesWithLLM(fileList, message);
      } catch (e) { console.warn(`[FileSelect] Skipped: ${e.message}`); }
    }

    // ── Auto-inject console logs when user reports a bug ──
    const isBugReport = /\b(erreur|bug|marche pas|fonctionne pas|cassé|crash|blanc|blanche|broken|fix|corrige|problème|ne s'affiche|ne charge)\b/i.test(message);
    if (isBugReport && project_id) {
      const logs = clientLogs.get(String(project_id)) || [];
      if (logs.length > 0) {
        const logText = logs.slice(-10).map(l => `[${l.level}] ${l.message}`).join('\n');
        userMsg = `${userMsg}\n\n[CONSOLE LOGS AUTOMATIQUES — lis ces erreurs AVANT de coder]\n${logText}`;
        console.log(`[Debug] Auto-injected ${logs.length} console logs for bug report`);
      }
    }

    // Load persistent project memory + conversation summaries
    let projectMemory = null;
    if (project_id) {
      try {
        const memoryBlock = conversationMemoryService.buildConversationMemoryBlock(project_id);
        if (memoryBlock && memoryBlock.trim().length > 0) projectMemory = memoryBlock;
      } catch (e) { /* fail silent */ }
    }

    const messages = ai ? ai.buildConversationContext(project, history, userMsg, projectKeys, llmSelectedFiles, projectMemory) : [{role:'user', content: userMsg}];
    if (project_id) db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id, 'user', message);
    const brief = project?.brief || message;

    if (isQuestion) {
      // Discussion mode: lightweight chat, no code generation, no tools
      console.log(`[Chat] Discussion mode for: "${message.substring(0, 60)}..."`);
      const job = generationJobs.get(jobId);
      try {
        const chatSystemBlocks = [{ type: 'text', text: ai ? ai.CHAT_SYSTEM_PROMPT : 'Réponds en français.' }];
        const chatReply = await callClaudeAPI(chatSystemBlocks, messages, 2000, { userId: user.id, projectId: project_id, operation: 'chat' });
        job.code = ''; // no code for discussion
        job.chat_message = chatReply;
        job.status = 'done';
        job.progressMessage = 'Réponse prête';
      } catch (e) {
        job.status = 'error';
        job.error = e.message;
      }
    } else if (mode === 'agent') {
      // ─── AGENT MODE: autonomous plan/execute/validate/fix loop ───
      ctx.activeGenerations++;
      const agentProject = project || { id: project_id, title: '', project_type: '', brief: message };
      agentModeService.runAgentLoop(jobId, user, agentProject, message, {
        callClaudeAPI,
        tools: CODE_TOOLS,
        containerExec: containerExecService,
        readProjectFiles: readProjectFilesRecursive,
        formatProjectCode
      }).finally(() => { ctx.activeGenerations--; });

      // Auto-summarize conversation in background
      if (project_id) {
        conversationMemoryService.autoSummarizeIfNeeded(project_id).catch(() => {});
      }
    } else {
      // Code mode: full generation pipeline
      ctx.activeGenerations++;
      generateClaude(messages, jobId, brief);

      // Auto-summarize conversation in background
      if (project_id) {
        conversationMemoryService.autoSummarizeIfNeeded(project_id).catch(() => {});
      }
    }
  });

  // ─── GENERATE FROM IMAGE START (POLLING) ───
  router.post('/api/generate/image/start', async (req, res) => {
    const user = req.user;
    const body = await getBody(req);
    const { project_id, image_base64, media_type, prompt } = body;
    if (!image_base64) { json(res, 400, { error: 'Image requise' }); return; }

    const jobId = crypto.randomUUID();

    // Initialize job in Map (with AbortController for user-initiated stop)
    generationJobs.set(jobId, {
      status: 'pending',
      code: '',
      error: null,
      progress: 0,
      project_id: project_id,
      user_id: user.id,
      message: '[Image uploadée pour reproduction de design]',
      finalized: false,
      is_image_gen: true,
      abortController: new AbortController()
    });

    // Return immediately with job_id
    json(res, 200, { job_id: jobId, status: 'pending' });

    // Start generation in background
    let project = null;
    if (project_id) {
      project = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
      db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id, 'user', '[Image uploadée pour reproduction de design]');
      notifyProjectClients(project_id, 'user_action', { action: 'generating_from_image', userName: user.name }, user.id);
    }

    const imagePrompt = prompt || "Analyse cette image et reproduis fidèlement ce design en HTML/CSS/JS moderne, responsive, professionnel. Adapte les couleurs, la typographie, la structure et les sections exactement comme dans l'image.";

    generateClaudeWithImage(image_base64, media_type || 'image/png', imagePrompt, jobId);
  });

  // ─── PLAN MODE — START ───
  router.post('/api/plan/start', async (req, res) => {
    const user = req.user;
    const body = await getBody(req);
    const { project_id: rawProjectId, message, skip_clarification } = body || {};

    // Input validation
    const msgErr = validateString(message, 'Message', 3, 10000);
    if (msgErr) { json(res, 400, { error: msgErr }); return; }
    const idErr = validateId(rawProjectId, 'project_id');
    if (idErr) { json(res, 400, { error: idErr }); return; }
    const project_id = parseInt(rawProjectId, 10);

    // Project ownership check
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
      return;
    }

    // ─── CLARIFICATION PROTOCOL ───
    if (!skip_clarification && needsClarification(message, project)) {
      try {
        const questions = await generateClarificationQuestions(message, user.id, project_id);
        log('info', 'clarify', 'asked (plan)', { userId: user.id, projectId: project_id, count: questions.length });
        json(res, 200, { type: 'clarification_needed', questions, original_message: message });
        return;
      } catch (e) {
        log('warn', 'clarify', 'failed open (plan)', { error: e.message });
      }
    }

    // Quota check
    const quota = checkUserQuota(user.id);
    if (!quota.allowed) {
      json(res, 429, { error: quota.reason, quota: { daily: quota.daily, dailyLimit: quota.dailyLimit, monthly: quota.monthly, monthlyLimit: quota.monthlyLimit } });
      return;
    }

    // Concurrency limit
    if (ctx.activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      json(res, 429, { error: `Serveur occupé (${ctx.activeGenerations}/${MAX_CONCURRENT_GENERATIONS} générations en cours). Réessayez dans 30 secondes.` });
      return;
    }

    // Create plan job
    const jobId = crypto.randomUUID();
    generationJobs.set(jobId, {
      status: 'pending',
      type: 'plan',
      code: '',
      error: null,
      progress: 0,
      project_id,
      user_id: user.id,
      message,
      finalized: false,
      plan_markdown: null,
      plan_id: null,
      abortController: new AbortController()
    });

    // Respond immediately
    json(res, 200, { job_id: jobId, status: 'pending' });

    // Persist user request
    try {
      db.prepare('INSERT INTO project_messages (project_id, role, content) VALUES (?,?,?)')
        .run(project_id, 'user', message);
    } catch (e) {
      log('warn', 'plan', 'user message insert failed', { jobId, error: e.message });
    }

    // Fire-and-forget background generation
    generatePlan(jobId, user, project, message).catch(err => {
      log('error', 'plan', 'unhandled in generatePlan', { jobId, error: err.message });
      const j = generationJobs.get(jobId);
      if (j && j.status !== 'done') { j.status = 'error'; j.error = j.error || err.message; }
    });
  });

  // ─── PLAN MODE — APPROVE ───
  router.post('/api/plan/:id/approve', async (req, res) => {
    const user = req.user;
    const planId = parseInt(req.params.id, 10);
    if (!Number.isInteger(planId) || planId < 1) {
      json(res, 400, { error: 'plan_id invalide.' });
      return;
    }

    // Anti-double-approve guard
    if (executedPlans.has(planId)) {
      json(res, 409, { error: 'Ce plan a déjà été exécuté.' });
      return;
    }

    // Fetch plan row
    const planRow = db.prepare("SELECT id, project_id, content FROM project_messages WHERE id=? AND role='plan'").get(planId);
    if (!planRow) { json(res, 404, { error: 'Plan introuvable.' }); return; }

    // Project ownership check
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(planRow.project_id);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé à ce plan.' });
      return;
    }

    // Quota check
    const quota = checkUserQuota(user.id);
    if (!quota.allowed) {
      json(res, 429, { error: quota.reason, quota: { daily: quota.daily, dailyLimit: quota.dailyLimit, monthly: quota.monthly, monthlyLimit: quota.monthlyLimit } });
      return;
    }

    // Concurrency check
    if (ctx.activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      json(res, 429, { error: `Serveur occupé (${ctx.activeGenerations}/${MAX_CONCURRENT_GENERATIONS} générations en cours). Réessayez dans 30 secondes.` });
      return;
    }

    // Mark as executed BEFORE creating the job
    executedPlans.add(planId);
    if (executedPlans.size > MAX_TRACKED_EXECUTED_PLANS) {
      const arr = Array.from(executedPlans).slice(MAX_TRACKED_EXECUTED_PLANS / 2);
      executedPlans.clear();
      arr.forEach(id => executedPlans.add(id));
    }

    // Build generation message
    const genMessage = `INSTRUCTION OBLIGATOIRE : Utilise write_file et edit_file pour modifier CHAQUE fichier listé ci-dessous. NE RÉPONDS PAS en texte. UTILISE LES OUTILS MAINTENANT.\n\nPlan validé par l'utilisateur — implémente chaque étape avec les outils :\n\n${planRow.content}`;

    // Create generation job
    const jobId = crypto.randomUUID();
    generationJobs.set(jobId, {
      status: 'pending',
      type: 'plan_execution',
      code: '',
      error: null,
      progress: 0,
      project_id: project.id,
      user_id: user.id,
      message: genMessage,
      plan_id: planId,
      finalized: false,
      abortController: new AbortController()
    });

    json(res, 200, { job_id: jobId, status: 'pending', plan_id: planId });

    // Build generation context
    let history = [];
    try {
      history = db.prepare('SELECT role,content FROM project_messages WHERE project_id=? ORDER BY id ASC LIMIT 30').all(project.id);
    } catch (e) {
      log('warn', 'plan', 'history fetch failed in approve', { planId, error: e.message });
    }
    const savedApis = (() => { try { return db.prepare('SELECT name,service,description FROM api_keys').all(); } catch (_) { return []; } })();
    const projectKeys = (() => { try { return db.prepare('SELECT env_name, service FROM project_api_keys WHERE project_id=?').all(project.id); } catch (_) { return []; } })();

    const userMsg = (ai && ai.buildProfessionalPrompt) ? ai.buildProfessionalPrompt(genMessage, project, savedApis) : genMessage;
    // Load project memory (best-effort)
    let approveMemory = null;
    try {
      const row = db.prepare('SELECT content FROM project_memory WHERE project_id=?').get(project.id);
      if (row && row.content && row.content.trim().length > 0) approveMemory = row.content;
    } catch (e) { /* fail silent */ }
    const messagesForGen = (ai && ai.buildConversationContext)
      ? ai.buildConversationContext(project, history, userMsg, projectKeys, null, approveMemory)
      : [{ role: 'user', content: userMsg }];

    // Persist a marker in history
    try {
      db.prepare('INSERT INTO project_messages (project_id, role, content) VALUES (?,?,?)')
        .run(project.id, 'user', `[Plan #${planId} approuvé et exécuté]`);
    } catch (e) { /* non-fatal */ }

    log('info', 'plan', 'plan approved and execution enqueued', {
      planId, jobId, projectId: project.id, userId: user.id
    });

    notifyProjectClients(project.id, 'user_action', { action: 'plan_executing', userName: user.name }, user.id);

    ctx.activeGenerations++;
    generateClaude(messagesForGen, jobId, project.brief);
  });

  // ─── AI FEEDBACK ───
  router.post('/api/feedback', async (req, res) => {
    const user = req.user;
    const body = await getBody(req);
    const { project_id, job_id, rating, comment } = body || {};
    if (rating !== 1 && rating !== -1) {
      json(res, 400, { error: 'rating must be 1 or -1' });
      return;
    }
    if (project_id !== null && project_id !== undefined) {
      const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(project_id);
      if (project && user.role !== 'admin' && project.user_id !== user.id) {
        json(res, 403, { error: 'Accès refusé à ce projet.' });
        return;
      }
    }
    if (comment && typeof comment === 'string' && comment.length > 1000) {
      json(res, 400, { error: 'commentaire trop long (max 1000)' });
      return;
    }
    try {
      db.prepare('INSERT INTO ai_feedback (project_id, user_id, job_id, rating, comment) VALUES (?,?,?,?,?)')
        .run(project_id || null, user.id, job_id || null, rating, comment || null);
      log('info', 'feedback', 'recorded', { userId: user.id, projectId: project_id, rating });
      json(res, 200, { ok: true });
    } catch (e) {
      log('error', 'feedback', 'insert failed', { error: e.message });
      json(res, 500, { error: 'Erreur enregistrement feedback' });
    }
  });

  // ─── ADMIN: AI STATS DASHBOARD ───
  router.get('/api/admin/ai-stats', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin only' }); return; }
    const urlParts = req.url.split('?');
    const params = urlParts.length > 1 ? new URLSearchParams(urlParts[1]) : new URLSearchParams();
    const days = Math.max(1, Math.min(90, parseInt(params.get('days') || '7', 10)));

    try {
      const totals = db.prepare(`
        SELECT
          COUNT(*) as total_calls,
          SUM(input_tokens) as total_input,
          SUM(output_tokens) as total_output,
          SUM(cache_read_tokens) as total_cache_read,
          SUM(cost_usd) as total_cost
        FROM token_usage
        WHERE created_at >= datetime('now', ?)
      `).get(`-${days} days`);

      const byOp = db.prepare(`
        SELECT operation, COUNT(*) as count, SUM(cost_usd) as cost,
               AVG(input_tokens) as avg_input, AVG(output_tokens) as avg_output
        FROM token_usage
        WHERE created_at >= datetime('now', ?)
        GROUP BY operation
        ORDER BY cost DESC
        LIMIT 20
      `).all(`-${days} days`);

      const dailySeries = db.prepare(`
        SELECT date(created_at) as day, COUNT(*) as calls, SUM(cost_usd) as cost
        FROM token_usage
        WHERE created_at >= datetime('now', ?)
        GROUP BY day
        ORDER BY day ASC
      `).all(`-${days} days`);

      const fb = db.prepare(`
        SELECT
          SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as negative,
          COUNT(*) as total
        FROM ai_feedback
        WHERE created_at >= datetime('now', ?)
      `).get(`-${days} days`);

      const topUsers = db.prepare(`
        SELECT u.id, u.email, u.name, COUNT(t.id) as calls, SUM(t.cost_usd) as cost
        FROM token_usage t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= datetime('now', ?)
        GROUP BY t.user_id
        ORDER BY cost DESC
        LIMIT 10
      `).all(`-${days} days`);

      json(res, 200, {
        period_days: days,
        totals: {
          calls: totals?.total_calls || 0,
          input_tokens: totals?.total_input || 0,
          output_tokens: totals?.total_output || 0,
          cache_read_tokens: totals?.total_cache_read || 0,
          cost_usd: Math.round((totals?.total_cost || 0) * 10000) / 10000
        },
        by_operation: byOp.map(r => ({
          operation: r.operation,
          count: r.count,
          cost_usd: Math.round((r.cost || 0) * 10000) / 10000,
          avg_input: Math.round(r.avg_input || 0),
          avg_output: Math.round(r.avg_output || 0)
        })),
        daily_series: dailySeries,
        feedback: {
          positive: fb?.positive || 0,
          negative: fb?.negative || 0,
          total: fb?.total || 0,
          satisfaction: fb?.total > 0 ? Math.round((fb.positive / fb.total) * 100) : null
        },
        top_users: topUsers.map(u => ({
          id: u.id, email: u.email, name: u.name,
          calls: u.calls, cost_usd: Math.round((u.cost || 0) * 10000) / 10000
        }))
      });
    } catch (e) {
      log('error', 'admin', 'ai-stats query failed', { error: e.message });
      json(res, 500, { error: 'Erreur stats: ' + e.message });
    }
  });

  // ─── ADMIN: AUDIT LOG ───
  router.get('/api/admin/audit-log', async (req, res) => {
    const user = req.user;
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin only' }); return; }
    try {
      const urlParts = req.url.split('?');
      const params = urlParts.length > 1 ? new URLSearchParams(urlParts[1]) : new URLSearchParams();
      const limit = Math.max(1, Math.min(500, parseInt(params.get('limit') || '100', 10)));
      const action = params.get('action');
      let query = 'SELECT id, user_id, user_email, action, resource_type, resource_id, ip, details, created_at FROM audit_log';
      const args = [];
      if (action) { query += ' WHERE action = ?'; args.push(action); }
      query += ' ORDER BY id DESC LIMIT ?';
      args.push(limit);
      const rows = db.prepare(query).all(...args);
      json(res, 200, { count: rows.length, entries: rows });
    } catch (e) {
      json(res, 500, { error: 'Failed to read audit log: ' + e.message });
    }
  });

  // ─── HOT RELOAD ───
  router.post('/api/hot-reload', async (req, res) => {
    const user = req.user;
    const { project_id } = await getBody(req);
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project?.generated_code) { json(res, 400, { error: 'Pas de code.' }); return; }
    if (user.role !== 'admin' && project.user_id !== user.id) { json(res, 403, { error: 'Accès refusé.' }); return; }

    const containerName = getContainerName(project_id);
    const running = await isContainerRunningAsync(project_id);

    if (!running) {
      json(res, 200, { hot: false, reason: 'container_not_running' }); return;
    }

    try {
      const startTime = Date.now();
      console.log(`[HMR] Copying files into ${containerName}...`);
      const projDir = path.join(DOCKER_PROJECTS_DIR, String(project_id));
      const { execSync } = require('child_process');
      let serverChanged = false;

      // Copy React source files — Vite HMR detects changes automatically
      if (fs.existsSync(path.join(projDir, 'src'))) {
        // bind mount — no docker cp needed for src/
      }
      // Root HTML and config
      if (fs.existsSync(path.join(projDir, 'index.html'))) {
        // bind mount — no docker cp needed for index.html
      }

      // Backend — only restart Express if server.js changed AND has no syntax errors
      if (fs.existsSync(path.join(projDir, 'server.js'))) {
        const { spawnSync } = require('child_process');
        const syntaxCheck = spawnSync('node', ['--check', path.join(projDir, 'server.js')], { encoding: 'utf8', timeout: 5000 });
        if (syntaxCheck.status === 0) {
          serverChanged = true;
        } else {
          console.warn(`[HMR] server.js has syntax errors — NOT copying to container`);
        }
      }

      // Only restart if server.js changed
      if (serverChanged) {
        console.log(`[HMR] server.js changed — restarting Express...`);
        const container = docker.getContainer(containerName);
        try {
          execSync(`docker exec ${containerName} sh -c 'kill $(cat /tmp/express.pid 2>/dev/null) 2>/dev/null; cp server.js server.cjs 2>/dev/null; node server.cjs & echo $! > /tmp/express.pid'`, { timeout: 10000 });
        } catch {
          // Fallback: full container restart
          await container.restart({ t: 2 });
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      const elapsed = Date.now() - startTime;
      db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(`/run/${project_id}/`, project_id);
      console.log(`[HMR] ${containerName} updated in ${elapsed}ms`);

      // Check Vite logs for errors AFTER hot-reload
      await new Promise(r => setTimeout(r, 2000));
      const postHmrLogs = await getContainerLogsAsync(project_id, 30);
      const hmrErrors = postHmrLogs.split('\n').filter(l =>
        /Failed to resolve|error TS|SyntaxError|Cannot find module|expected|Transform failed/i.test(l) &&
        !/✅|Prêt|Ready|watching|hmr update/i.test(l)
      );

      if (hmrErrors.length > 0) {
        console.warn(`[HMR] Vite errors after hot-reload: ${hmrErrors.length}`);
        hmrErrors.forEach(e => console.warn(`  ${e.trim().substring(0, 100)}`));

        // Auto-fix: send errors to Claude
        try {
          const fixPrompt = `Après la modification, Vite affiche ces erreurs:\n\n${hmrErrors.join('\n').substring(0, 2000)}\n\nCorrige les fichiers en cause. Imports: @/ alias, fichiers UI en lowercase.`;
          const fixCode = await callClaudeAPI(
            [{ type: 'text', text: ai ? ai.CHAT_SYSTEM_PROMPT : 'Corrige.' }],
            [{ role: 'user', content: fixPrompt }],
            16000,
            { userId: user.id, projectId: project_id, operation: 'auto-correct' },
            { useTools: true }
          );
          if (fixCode) {
            const projDir2 = path.join(DOCKER_PROJECTS_DIR, String(project_id));
            writeGeneratedFiles(projDir2, fixCode, project_id);
            console.log(`[HMR] Auto-fixed Vite errors and re-applied`);
          }
        } catch (fixErr) {
          console.warn(`[HMR] Auto-fix failed: ${fixErr.message}`);
        }
        json(res, 200, { hot: true, url: `/run/${project_id}/`, elapsed, viteErrors: hmrErrors.length, autoFixed: true });
      } else {
        json(res, 200, { hot: true, url: `/run/${project_id}/`, elapsed, viteErrors: 0 });
      }
    } catch (e) {
      console.error(`[HMR] Error: ${e.message}`);
      json(res, 200, { hot: false, reason: e.message });
    }
  });
};
