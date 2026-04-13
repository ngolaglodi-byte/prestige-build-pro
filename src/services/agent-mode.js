// ─── AGENT MODE — AUTONOMOUS PLAN/EXECUTE/VALIDATE/FIX LOOP ───
// Uses callClaudeAPI (passed from server.js) for ALL API calls.
// No raw HTTPS — reuses existing retry logic, rate limiting, error handling.

const fs = require('fs');
const path = require('path');

module.exports = function(ctx) {
  const AGENT_PLAN_MAX_TOKENS = 4000;
  const AGENT_EXECUTE_MAX_TOKENS = 64000;
  const AGENT_FIX_MAX_TOKENS = 32000;

  function getMaxIterations(message, project) {
    const wordCount = (message || '').split(/\s+/).length;
    const hasExistingCode = project?.generated_code?.length > 500;
    if (wordCount > 100 || !hasExistingCode) return 5;
    if (wordCount > 30) return 4;
    return 3;
  }

  // ─── STEP 1: PLAN ───
  // Uses callClaudeAPI (same as all other AI calls) — NOT raw HTTPS
  async function generateAgentPlan(project, message, previousSteps, existingFiles, callClaudeAPI, user) {
    const fileList = existingFiles
      ? Object.keys(existingFiles).map(name => `  - ${name} (${existingFiles[name].length} chars)`).join('\n')
      : '  (aucun)';

    const prevContext = previousSteps.length > 0
      ? `\nTENTATIVES PRÉCÉDENTES:\n${previousSteps.map((s, i) => `${i + 1}. [${s.type}] ${s.summary || 'OK'}${s.errors ? ' — Erreurs: ' + s.errors.join(', ') : ''}`).join('\n')}`
      : '';

    const systemBlocks = [{ type: 'text', text: `Tu es un architecte logiciel. Produis un plan JSON pour cette demande.
PROJET: ${project.title || 'Nouveau'} (${project.project_type || 'web'})
FICHIERS:\n${fileList}${prevContext}

RÉPONDS UNIQUEMENT en JSON valide:
{"analysis":"...", "steps":[{"action":"write_file|edit_file","path":"...","description":"..."}], "expectedOutcome":"..."}` }];

    const messages = [{ role: 'user', content: message }];

    const reply = await callClaudeAPI(systemBlocks, messages, AGENT_PLAN_MAX_TOKENS,
      { userId: user?.id, projectId: project?.id, operation: 'agent-plan' }, {});

    // Parse JSON from reply
    if (typeof reply === 'string') {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch(e) {}
      }
      return { analysis: reply.substring(0, 200), steps: [{ action: 'write_file', description: 'Generate directly' }], expectedOutcome: 'Working application' };
    }
    return { analysis: message, steps: [{ action: 'write_file', description: 'Generate directly' }], expectedOutcome: 'Working application' };
  }

  // ─── STEP 2: EXECUTE ───
  async function executeAgentPlan(plan, project, job, callClaudeAPI) {
    const stepsText = (plan.steps || []).map((s, i) =>
      `${i + 1}. [${s.action}] ${s.description}${s.path ? ' → ' + s.path : ''}`
    ).join('\n');

    const systemBlocks = [{ type: 'text', text: `Tu es un développeur senior. Exécute ce plan avec les outils (write_file, edit_file, run_command). Code en React 19 + Vite 6 + TailwindCSS 3. Imports @/ alias. server.js en CommonJS. FAIS-LE, ne décris pas.` }];
    const messages = [{ role: 'user', content: `Exécute ce plan:\n${stepsText}\n\nRésultat attendu: ${plan.expectedOutcome}` }];

    try {
      const result = await callClaudeAPI(systemBlocks, messages, AGENT_EXECUTE_MAX_TOKENS,
        { userId: job.user_id, projectId: job.project_id, operation: 'agent-execute' },
        { useTools: true }
      );
      return { success: true, code: result };
    } catch(e) {
      return { success: false, error: e.message };
    }
  }

  // ─── STEP 3: VALIDATE ───
  async function validateAgentResult(projectId, containerExec) {
    const errors = [];
    const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));

    // 3a. Syntax check server.js
    const serverJsPath = path.join(projDir, 'server.js');
    if (fs.existsSync(serverJsPath)) {
      try {
        require('child_process').execSync(`node --check "${serverJsPath}"`, { timeout: 5000, stdio: 'pipe' });
      } catch(e) {
        errors.push({ type: 'syntax', severity: 'critical', message: 'server.js syntax error', details: e.stderr?.toString()?.substring(0, 500) || e.message });
      }
    }

    // 3b. Back-tests
    try {
      const ai = require('../ai');
      if (ai.runBackTests) {
        const files = readProjectFiles(projDir);
        if (Object.keys(files).length > 0) {
          const issues = ai.runBackTests(files).filter(i => i.severity === 'error');
          for (const issue of issues) {
            errors.push({ type: 'backtest', severity: 'error', message: issue.message, details: issue.details || '' });
          }
        }
      }
    } catch(e) { /* skip */ }

    // 3c. Coherence checks
    try {
      const coherence = require('../coherence');
      const files = readProjectFiles(projDir);
      if (Object.keys(files).length > 0) {
        const result = coherence.runCoherenceChecks(files);
        for (const issue of (result.issues || []).filter(i => i.severity === 'error')) {
          errors.push({ type: 'coherence', severity: 'error', message: issue.message });
        }
      }
    } catch(e) { /* skip */ }

    // 3d. Docker build (optional)
    if (containerExec) {
      try {
        const buildResult = await containerExec.buildInContainer(projectId);
        if (buildResult.exitCode !== 0) {
          errors.push({ type: 'build', severity: 'critical', message: 'Build failed', details: (buildResult.stderr || buildResult.stdout || '').substring(0, 2000) });
        }
      } catch(e) { /* Docker not available — skip */ }
    }

    const critical = errors.filter(e => e.severity === 'critical');
    return {
      success: critical.length === 0,
      errors,
      critical,
      warnings: errors.filter(e => e.severity !== 'critical'),
      summary: critical.length === 0 ? 'OK' : `${critical.length} erreur(s) critique(s)`
    };
  }

  // Helper: read project files from disk
  function readProjectFiles(projDir) {
    const files = {};
    const srcDir = path.join(projDir, 'src');
    if (fs.existsSync(srcDir)) {
      const scan = (dir, prefix) => {
        try {
          for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (f.isDirectory() && f.name !== 'node_modules') scan(path.join(dir, f.name), prefix + f.name + '/');
            else if (f.isFile() && /\.(tsx|ts|jsx|js|css)$/.test(f.name)) {
              files[prefix + f.name] = fs.readFileSync(path.join(dir, f.name), 'utf8');
            }
          }
        } catch(e) {}
      };
      scan(srcDir, 'src/');
    }
    const serverJs = path.join(projDir, 'server.js');
    if (fs.existsSync(serverJs)) files['server.js'] = fs.readFileSync(serverJs, 'utf8');
    return files;
  }

  // ─── STEP 4: FIX ───
  function buildFixPrompt(validation, plan) {
    const errorText = validation.critical.map(e => `[${e.type}] ${e.message}\n${e.details || ''}`).join('\n\n');
    return `La validation a échoué. Corrige ces erreurs:\n\n${errorText}\n\nCorrige avec write_file (fichiers ENTIERS). Ne réexplique pas — CORRIGE.`;
  }

  // ─── MAIN LOOP ───
  async function runAgentLoop(jobId, user, project, message, deps) {
    const { callClaudeAPI, containerExec, readProjectFiles: readFiles, formatProjectCode } = deps;
    const job = ctx.generationJobs.get(jobId);
    if (!job) return;

    const maxIterations = getMaxIterations(message, project);
    job.status = 'running';
    job.agentMode = true;
    job.agentSteps = [];

    const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(project.id));
    let existingFiles = null;
    if (fs.existsSync(projDir)) {
      try { existingFiles = readFiles(projDir); } catch(e) {}
    }

    let bestCode = job.code || '';
    let currentMessage = message;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const label = `${iteration + 1}/${maxIterations}`;

      if (job.abortController?.signal?.aborted) {
        job.status = 'cancelled';
        job.progressMessage = 'Agent annulé';
        return;
      }

      // ── PLAN ──
      job.progressMessage = `Agent: planification (${label})...`;
      let plan;
      try {
        plan = await generateAgentPlan(project, currentMessage, job.agentSteps, existingFiles, callClaudeAPI, user);
        job.agentSteps.push({ type: 'plan', summary: plan.analysis || 'OK', iteration });
        console.log(`[Agent] Plan ${label}: ${plan.analysis || message.substring(0, 50)}`);
      } catch(e) {
        console.error(`[Agent] Plan failed ${label}: ${e.message}`);
        job.agentSteps.push({ type: 'plan_error', summary: e.message, iteration });
        plan = { analysis: message, steps: [{ action: 'write_file', description: 'Direct generation' }], expectedOutcome: 'Working app' };
      }

      // ── EXECUTE ──
      job.progressMessage = `Agent: exécution (${label})...`;
      let execResult = { success: false, error: 'not started' };
      for (let retry = 0; retry < 2; retry++) {
        execResult = await executeAgentPlan(plan, project, job, callClaudeAPI);
        if (execResult.success) break;
        if (retry === 0) job.progressMessage = `Agent: nouvelle tentative (${label})...`;
      }

      job.agentSteps.push({ type: 'execute', summary: execResult.success ? 'OK' : execResult.error, iteration });
      if (execResult.code) job.code = execResult.code;

      if (!execResult.success) {
        currentMessage = `Exécution échouée: ${execResult.error}. Reformule et réessaye.`;
        continue;
      }

      // ── VALIDATE ──
      job.progressMessage = `Agent: validation (${label})...`;
      await new Promise(r => setTimeout(r, 2000)); // Vite HMR needs time

      const validation = await validateAgentResult(project.id, containerExec);
      job.agentSteps.push({ type: 'validate', summary: validation.summary, errors: validation.errors.map(e => e.message), iteration });

      if (validation.success) {
        bestCode = job.code;
        job.status = 'done';
        job.progressMessage = `Agent: terminé en ${iteration + 1} itération(s)`;
        console.log(`[Agent] Success after ${iteration + 1} iterations`);
        return;
      }

      // ── FIX ──
      console.log(`[Agent] Validation failed ${label}: ${validation.summary}`);
      job.progressMessage = `Agent: correction (${label})...`;
      currentMessage = buildFixPrompt(validation, plan);
    }

    // Max iterations — use best version
    if (bestCode) job.code = bestCode;
    job.status = 'done';
    job.progressMessage = `Agent: terminé (${maxIterations} itérations)`;
  }

  return { runAgentLoop, generateAgentPlan, validateAgentResult, buildFixPrompt, getMaxIterations };
};
