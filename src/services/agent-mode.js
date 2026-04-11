// ─── AGENT MODE — AUTONOMOUS PLAN/EXECUTE/VALIDATE/FIX LOOP ───
// Lovable-level Agent Mode: multi-step autonomous development.
// Breaks down complex requests, builds, validates, fixes errors in a loop.
// Features: streaming progress, error recovery, full tool set, web search,
// dynamic iteration scaling, rollback on failure, fix validation.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { log } = require('../config');

module.exports = function(ctx) {
  const AGENT_PLAN_MAX_TOKENS = 4000;
  const AGENT_EXECUTE_MAX_TOKENS = 64000;
  const AGENT_FIX_MAX_TOKENS = 32000;
  const STEP_TIMEOUT_MS = 120000; // 2 min per step

  // Dynamic iteration scaling based on complexity
  function getMaxIterations(message, project) {
    const wordCount = (message || '').split(/\s+/).length;
    const hasExistingCode = project?.generated_code?.length > 500;
    if (wordCount > 100 || !hasExistingCode) return 7; // complex/new project
    if (wordCount > 30) return 5; // moderate
    return 3; // simple modification
  }

  // ─── STEP 1: PLAN ───
  async function generateAgentPlan(project, message, previousSteps, existingFiles) {
    const fileContext = existingFiles
      ? Object.entries(existingFiles).map(([name, content]) =>
          `### ${name} (${content.length} chars)\n${content.substring(0, 200)}...`
        ).join('\n').substring(0, 3000)
      : 'Aucun fichier existant';

    const systemPrompt = `Tu es un architecte logiciel senior. Analyse la demande et produis un plan d'exécution JSON.

PROJET: ${project.title || 'Nouveau'} (${project.project_type || 'web'})
FICHIERS EXISTANTS:
${fileContext}

${previousSteps.length > 0 ? `TENTATIVES PRÉCÉDENTES (évite les mêmes erreurs):\n${previousSteps.map((s, i) => `${i + 1}. [${s.type}] ${s.summary || 'OK'}${s.errors ? ' | Erreurs: ' + s.errors.join(', ') : ''}`).join('\n')}` : ''}

OUTILS DISPONIBLES:
- write_file: créer/réécrire un fichier complet
- edit_file: modifier une partie d'un fichier (search/replace)
- run_command: exécuter une commande (node, npm, cat, ls, grep)
- web_search: chercher sur le web (docs API, exemples, best practices)

RÉPONDS UNIQUEMENT en JSON:
{
  "analysis": "Analyse (1-2 phrases)",
  "complexity": "simple|moderate|complex",
  "steps": [
    { "action": "write_file|edit_file|run_command|web_search", "path": "...", "command": "...", "query": "...", "description": "..." }
  ],
  "validation": { "build": true, "healthCheck": true, "syntaxCheck": ["server.js"] },
  "expectedOutcome": "Résultat attendu"
}`;

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: AGENT_PLAN_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: STEP_TIMEOUT_MS
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) { reject(new Error(parsed.error.message)); return; }
            const text = parsed.content?.[0]?.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              resolve(JSON.parse(jsonMatch[0]));
            } else {
              resolve({ analysis: text, steps: [], expectedOutcome: 'Plan non structuré', complexity: 'moderate' });
            }
          } catch(e) {
            reject(new Error(`Plan parsing failed: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Plan generation timeout')); });
      req.write(payload);
      req.end();
    });
  }

  // ─── STEP 2: EXECUTE ───
  async function executeAgentPlan(plan, project, job, callClaudeAPI) {
    const stepsDescription = plan.steps.map((s, i) =>
      `${i + 1}. [${s.action}] ${s.description}${s.path ? ` → ${s.path}` : ''}${s.command ? ` → \`${s.command}\`` : ''}${s.query ? ` → "${s.query}"` : ''}`
    ).join('\n');

    const executePrompt = `Exécute ce plan en utilisant les outils disponibles.
Exécute TOUTES les étapes en parallèle dans UNE SEULE réponse.

PLAN:
${stepsDescription}

RÉSULTAT ATTENDU: ${plan.expectedOutcome}

RÈGLES:
- Utilise les outils pour exécuter chaque étape. FAIS-LE, ne décris pas.
- Si tu as besoin d'info, utilise web_search AVANT de coder.
- Si tu as besoin de vérifier un fichier existant, utilise run_command cat.
- Code en React 19 + Vite 6 + TailwindCSS 3. Imports via @/ alias.
- Lucide React pour les icônes. JAMAIS de CDN.
- server.js en CommonJS (require). Port 3000, 0.0.0.0.`;

    const systemBlocks = [{ type: 'text', text: `Tu es un développeur senior autonome. Tu exécutes un plan en utilisant les outils fournis (write_file, edit_file, run_command, web_search). Tu ne poses AUCUNE question — tu agis.` }];
    const messages = [{ role: 'user', content: executePrompt }];

    try {
      const result = await callClaudeAPI(systemBlocks, messages, AGENT_EXECUTE_MAX_TOKENS,
        { userId: job.user_id, projectId: job.project_id, operation: 'agent-execute' },
        { useTools: true, webSearch: true }
      );
      return { success: true, code: result, plan };
    } catch(e) {
      return { success: false, error: e.message, plan };
    }
  }

  // ─── STEP 3: VALIDATE ───
  // 5-layer validation: syntax → back-tests → coherence → build → health
  async function validateAgentResult(projectId, containerExec) {
    const errors = [];
    const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));

    // 3a. Syntax check server.js
    const serverJsPath = path.join(projDir, 'server.js');
    if (fs.existsSync(serverJsPath)) {
      try {
        const { execSync } = require('child_process');
        execSync(`node --check "${serverJsPath}"`, { timeout: 5000, stdio: 'pipe' });
      } catch(e) {
        errors.push({
          type: 'syntax',
          severity: 'critical',
          message: 'server.js syntax error',
          details: e.stderr?.toString()?.substring(0, 500) || e.message,
          file: 'server.js'
        });
      }
    }

    // 3b. Back-tests (via ai module if available)
    try {
      const ai = require('../ai');
      const files = {};
      const srcDir = path.join(projDir, 'src');
      if (fs.existsSync(srcDir)) {
        const scan = (dir, prefix) => {
          for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (f.isDirectory() && f.name !== 'node_modules') scan(path.join(dir, f.name), prefix + f.name + '/');
            else if (f.isFile() && /\.(tsx|ts|jsx|js|css)$/.test(f.name)) {
              try { files[prefix + f.name] = fs.readFileSync(path.join(dir, f.name), 'utf8'); } catch(e) {}
            }
          }
        };
        scan(srcDir, 'src/');
      }
      if (fs.existsSync(serverJsPath)) files['server.js'] = fs.readFileSync(serverJsPath, 'utf8');

      if (ai.runBackTests && Object.keys(files).length > 0) {
        const issues = ai.runBackTests(files);
        const criticalIssues = issues.filter(i => i.severity === 'error');
        for (const issue of criticalIssues) {
          errors.push({
            type: 'backtest',
            severity: 'error',
            message: issue.message,
            details: issue.details || '',
            file: issue.file
          });
        }
      }
    } catch(e) { /* ai module not available, skip */ }

    // 3c. Coherence checks
    try {
      const coherence = require('../coherence');
      const files = {};
      const srcDir = path.join(projDir, 'src');
      if (fs.existsSync(srcDir)) {
        const scan = (dir, prefix) => {
          for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (f.isDirectory() && f.name !== 'node_modules') scan(path.join(dir, f.name), prefix + f.name + '/');
            else if (f.isFile() && /\.(tsx|ts|jsx|js)$/.test(f.name)) {
              try { files[prefix + f.name] = fs.readFileSync(path.join(dir, f.name), 'utf8'); } catch(e) {}
            }
          }
        };
        scan(srcDir, 'src/');
      }
      if (fs.existsSync(serverJsPath)) files['server.js'] = fs.readFileSync(serverJsPath, 'utf8');

      if (Object.keys(files).length > 0) {
        const result = coherence.runCoherenceChecks(files);
        const criticalIssues = (result.issues || []).filter(i => i.severity === 'error');
        for (const issue of criticalIssues) {
          errors.push({
            type: 'coherence',
            severity: 'error',
            message: issue.message,
            details: issue.details || '',
            file: issue.file
          });
        }
      }
    } catch(e) { /* coherence module not available, skip */ }

    // 3d. Vite build check (in container)
    if (containerExec) {
      try {
        const buildResult = await containerExec.buildInContainer(projectId);
        if (buildResult.exitCode !== 0) {
          const errorOutput = (buildResult.stderr || buildResult.stdout || '').substring(0, 2000);
          errors.push({
            type: 'build',
            severity: 'critical',
            message: `Vite build failed (exit ${buildResult.exitCode})`,
            details: errorOutput
          });
        }
      } catch(e) {
        errors.push({ type: 'build', severity: 'warning', message: `Build check skipped: ${e.message}`, details: '' });
      }

      // 3e. Runtime health check
      try {
        const healthResult = await containerExec.healthCheckInContainer(projectId);
        if (healthResult.exitCode !== 0 || !(healthResult.stdout || '').includes('<div id="root"')) {
          errors.push({
            type: 'runtime',
            severity: 'warning',
            message: 'Health check: page may not render correctly',
            details: (healthResult.stdout || '').substring(0, 500)
          });
        }
      } catch(e) { /* non-fatal */ }
    }

    // Categorize results
    const critical = errors.filter(e => e.severity === 'critical');
    const warnings = errors.filter(e => e.severity !== 'critical');

    return {
      success: critical.length === 0,
      errors,
      critical,
      warnings,
      summary: critical.length === 0
        ? (warnings.length > 0 ? `OK avec ${warnings.length} avertissement(s)` : 'OK')
        : `${critical.length} erreur(s) critique(s)`
    };
  }

  // ─── STEP 4: FIX ───
  function buildFixPrompt(validation, plan, iteration) {
    const criticalErrors = validation.critical.map(e =>
      `[${e.type.toUpperCase()}] ${e.message}${e.file ? ` (fichier: ${e.file})` : ''}\n${e.details || ''}`
    ).join('\n\n');

    const warningErrors = validation.warnings.map(e =>
      `[WARNING] ${e.message}${e.file ? ` (${e.file})` : ''}`
    ).join('\n');

    return `ITÉRATION ${iteration}: La validation a échoué. Corrige les erreurs critiques.

ERREURS CRITIQUES (à corriger OBLIGATOIREMENT):
${criticalErrors}

${warningErrors ? `AVERTISSEMENTS (corrige si possible):\n${warningErrors}` : ''}

PLAN ORIGINAL: ${plan.analysis}

INSTRUCTION:
- Corrige TOUTES les erreurs critiques avec write_file (réécris les fichiers en ENTIER).
- Utilise run_command pour vérifier tes corrections (node --check, cat, etc.).
- Ne réexplique pas — CORRIGE directement.`;
  }

  // ─── MAIN LOOP ───
  async function runAgentLoop(jobId, user, project, message, { callClaudeAPI, tools, containerExec, readProjectFiles, formatProjectCode }) {
    const job = ctx.generationJobs.get(jobId);
    if (!job) return;

    const maxIterations = getMaxIterations(message, project);

    job.status = 'running';
    job.agentMode = true;
    job.agentSteps = [];
    job.agentMaxIterations = maxIterations;

    // Read existing files for context
    const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(project.id));
    let existingFiles = null;
    if (fs.existsSync(projDir)) {
      try { existingFiles = readProjectFiles(projDir); } catch(e) {}
    }

    // Save best working version for rollback
    let bestCode = job.code || '';
    let bestIteration = 0;
    let currentMessage = message;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const iterLabel = `${iteration + 1}/${maxIterations}`;

      // Check abort
      if (job.abortController?.signal?.aborted) {
        job.status = 'cancelled';
        job.progressMessage = 'Agent: annulé par l\'utilisateur';
        return;
      }

      // ── PLAN ──
      job.progressMessage = `🔍 Agent: planification (${iterLabel})...`;
      log('info', 'agent', `Plan ${iterLabel}`, { projectId: project.id });
      let plan;
      try {
        plan = await generateAgentPlan(project, currentMessage, job.agentSteps, existingFiles);
        job.agentSteps.push({ type: 'plan', summary: plan.analysis, complexity: plan.complexity, stepCount: plan.steps?.length || 0, iteration });
        console.log(`[Agent] Plan ${iterLabel}: ${plan.analysis} (${plan.steps?.length || 0} steps, ${plan.complexity || 'unknown'})`);
      } catch(e) {
        console.error(`[Agent] Plan failed ${iterLabel}: ${e.message}`);
        job.agentSteps.push({ type: 'plan_error', summary: e.message, iteration });
        plan = { analysis: message, steps: [{ action: 'write_file', description: 'Generate directly' }], expectedOutcome: 'Working application', complexity: 'moderate' };
      }

      // ── EXECUTE (with retry on failure) ──
      job.progressMessage = `⚡ Agent: exécution du plan (${iterLabel})...`;
      let execResult;
      const maxExecRetries = 2;
      for (let retry = 0; retry < maxExecRetries; retry++) {
        try {
          execResult = await executeAgentPlan(plan, project, job, callClaudeAPI);
          if (execResult.success) break;
          if (retry < maxExecRetries - 1) {
            console.log(`[Agent] Execute retry ${retry + 1}/${maxExecRetries}`);
            job.progressMessage = `⚡ Agent: nouvelle tentative d'exécution (${iterLabel})...`;
          }
        } catch(e) {
          console.error(`[Agent] Execute error ${iterLabel}: ${e.message}`);
          execResult = { success: false, error: e.message, plan };
        }
      }

      job.agentSteps.push({ type: 'execute', summary: execResult.success ? 'OK' : (execResult.error || 'Failed'), iteration });
      if (execResult.code) job.code = execResult.code;

      if (!execResult.success) {
        // Execute failed even after retries — skip validation, try fix
        currentMessage = `L'exécution a échoué: ${execResult.error}. Reformule le plan et réessaye.`;
        continue;
      }

      // ── VALIDATE (5-layer) ──
      job.progressMessage = `✅ Agent: validation (${iterLabel})...`;
      // Wait for Vite to process file changes
      await new Promise(r => setTimeout(r, 3000));

      const validation = await validateAgentResult(project.id, containerExec);
      job.agentSteps.push({
        type: 'validate',
        summary: validation.summary,
        critical: validation.critical.length,
        warnings: validation.warnings.length,
        errors: validation.errors.map(e => `[${e.type}] ${e.message}`),
        iteration
      });

      if (validation.success) {
        // Save as best version
        bestCode = job.code;
        bestIteration = iteration + 1;

        job.status = 'done';
        job.progressMessage = `✨ Agent: terminé en ${iteration + 1} itération(s)${validation.warnings.length > 0 ? ` (${validation.warnings.length} avertissement(s))` : ''}`;
        console.log(`[Agent] Success after ${iteration + 1} iterations`);
        return;
      }

      // ── FIX ──
      console.log(`[Agent] Validation failed ${iterLabel}: ${validation.summary}`);
      job.progressMessage = `🔧 Agent: correction des erreurs (${iterLabel})...`;
      currentMessage = buildFixPrompt(validation, plan, iteration + 1);
    }

    // Max iterations reached — rollback to best working version if available
    if (bestCode && bestCode !== job.code) {
      console.log(`[Agent] Max iterations — rolling back to best version (iteration ${bestIteration})`);
      job.code = bestCode;
      job.progressMessage = `⚠️ Agent: limite atteinte, version stable restaurée (itération ${bestIteration})`;
    } else {
      job.progressMessage = `⚠️ Agent: terminé (limite de ${maxIterations} itérations atteinte)`;
    }
    job.status = 'done';
    console.log(`[Agent] Max iterations reached — returning best result`);
  }

  return { runAgentLoop, generateAgentPlan, validateAgentResult, buildFixPrompt, getMaxIterations };
};
