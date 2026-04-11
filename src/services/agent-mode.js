// ─── AGENT MODE — AUTONOMOUS PLAN/EXECUTE/VALIDATE/FIX LOOP ───
// Like Lovable's Agent Mode: multi-step autonomous development.
// Breaks down complex requests, builds, validates, fixes errors in a loop.

const https = require('https');
const fs = require('fs');
const path = require('path');

module.exports = function(ctx) {
  const MAX_AGENT_ITERATIONS = 5;
  const AGENT_PLAN_MAX_TOKENS = 4000;
  const AGENT_EXECUTE_MAX_TOKENS = 64000;
  const AGENT_FIX_MAX_TOKENS = 32000;

  // ─── STEP 1: PLAN ───
  // Ask Claude to analyze the request and produce a structured plan
  async function generateAgentPlan(project, message, previousSteps, existingFiles) {
    const systemPrompt = `Tu es un architecte logiciel senior. Analyse la demande de l'utilisateur et produis un plan d'exécution structuré en JSON.

PROJET ACTUEL:
- Titre: ${project.title || 'Nouveau projet'}
- Type: ${project.project_type || 'web'}
- Code existant: ${existingFiles ? Object.keys(existingFiles).length + ' fichiers' : 'aucun'}

${previousSteps.length > 0 ? `ÉTAPES PRÉCÉDENTES:\n${previousSteps.map((s, i) => `${i + 1}. [${s.type}] ${s.summary || 'OK'}`).join('\n')}` : ''}

RÉPONDS UNIQUEMENT en JSON valide avec cette structure:
{
  "analysis": "Analyse courte de la demande (1-2 phrases)",
  "steps": [
    {
      "action": "write_file|edit_file|run_command",
      "path": "chemin/du/fichier (pour write/edit)",
      "command": "commande (pour run_command)",
      "description": "Ce que cette étape fait",
      "priority": 1
    }
  ],
  "expectedOutcome": "Résultat attendu après exécution"
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
        timeout: 30000
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const text = parsed.content?.[0]?.text || '';
            // Extract JSON from response (may be wrapped in markdown)
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const plan = JSON.parse(jsonMatch[0]);
              resolve(plan);
            } else {
              resolve({ analysis: text, steps: [], expectedOutcome: 'Plan non structuré' });
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
  // Execute the plan by calling Claude with tool_use to write/edit files
  async function executeAgentPlan(plan, project, job, callClaudeAPI, tools) {
    const stepsDescription = plan.steps.map((s, i) =>
      `${i + 1}. [${s.action}] ${s.description}${s.path ? ` → ${s.path}` : ''}${s.command ? ` → ${s.command}` : ''}`
    ).join('\n');

    const executePrompt = `Exécute ce plan en utilisant les outils disponibles (write_file, edit_file, run_command).
Exécute TOUTES les étapes en parallèle dans UNE SEULE réponse.

PLAN:
${stepsDescription}

RÉSULTAT ATTENDU: ${plan.expectedOutcome}

IMPORTANT: Utilise les outils pour exécuter chaque étape. Ne décris pas ce que tu vas faire — FAIS-LE.`;

    const systemBlocks = [{ type: 'text', text: `Tu es un développeur senior qui exécute un plan de développement. Tu utilises les outils fournis pour écrire/modifier des fichiers et exécuter des commandes. Code en React + Vite + TailwindCSS. Imports via @/ alias.` }];
    const messages = [{ role: 'user', content: executePrompt }];

    try {
      const result = await callClaudeAPI(systemBlocks, messages, AGENT_EXECUTE_MAX_TOKENS,
        { userId: job.user_id, projectId: job.project_id, operation: 'agent-execute' },
        { useTools: true }
      );
      return { success: true, code: result, plan };
    } catch(e) {
      return { success: false, error: e.message, plan };
    }
  }

  // ─── STEP 3: VALIDATE ───
  // Check if the generated code builds and runs correctly
  async function validateAgentResult(projectId, containerExec) {
    const errors = [];

    // 3a. Check Vite build
    try {
      const buildResult = await containerExec.buildInContainer(projectId);
      if (buildResult.exitCode !== 0) {
        const errorOutput = (buildResult.stderr || buildResult.stdout || '').substring(0, 2000);
        errors.push({
          type: 'build',
          message: `Build failed (exit ${buildResult.exitCode})`,
          details: errorOutput
        });
      }
    } catch(e) {
      errors.push({ type: 'build', message: `Build check failed: ${e.message}`, details: '' });
    }

    // 3b. Check runtime health (HTTP GET to Vite dev server)
    try {
      const healthResult = await containerExec.healthCheckInContainer(projectId);
      if (healthResult.exitCode !== 0 || !healthResult.stdout.includes('<div id="root"')) {
        errors.push({
          type: 'runtime',
          message: 'Health check failed — page may not render',
          details: (healthResult.stdout || '').substring(0, 500)
        });
      }
    } catch(e) {
      // Health check failure is non-fatal (container might still be starting)
    }

    // 3c. Check for syntax errors in generated files
    const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));
    const serverJsPath = path.join(projDir, 'server.js');
    if (fs.existsSync(serverJsPath)) {
      try {
        const { execSync } = require('child_process');
        execSync(`node --check "${serverJsPath}"`, { timeout: 5000, stdio: 'pipe' });
      } catch(e) {
        errors.push({
          type: 'syntax',
          message: 'server.js syntax error',
          details: e.stderr?.toString()?.substring(0, 500) || e.message
        });
      }
    }

    return {
      success: errors.length === 0,
      errors
    };
  }

  // ─── STEP 4: FIX ───
  // Build a fix prompt from validation errors
  function buildFixPrompt(validation, plan, previousAttempt) {
    const errorDetails = validation.errors.map(e =>
      `[${e.type.toUpperCase()}] ${e.message}\n${e.details || ''}`
    ).join('\n\n');

    return `Le plan a été exécuté mais la validation a échoué. Corrige les erreurs suivantes:

ERREURS:
${errorDetails}

PLAN ORIGINAL:
${plan.analysis}

INSTRUCTION: Corrige TOUTES les erreurs ci-dessus. Utilise write_file pour réécrire les fichiers problématiques en ENTIER.
Ne réexplique pas le plan — CORRIGE directement avec les outils.`;
  }

  // ─── MAIN LOOP ───
  async function runAgentLoop(jobId, user, project, message, { callClaudeAPI, tools, containerExec, readProjectFiles, formatProjectCode }) {
    const job = ctx.generationJobs.get(jobId);
    if (!job) return;

    job.status = 'running';
    job.agentMode = true;
    job.agentSteps = [];

    // Read existing files for context
    const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(project.id));
    let existingFiles = null;
    if (fs.existsSync(projDir)) {
      try { existingFiles = readProjectFiles(projDir); } catch(e) {}
    }

    let currentMessage = message;

    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
      const iterLabel = `${iteration + 1}/${MAX_AGENT_ITERATIONS}`;

      // ── PLAN ──
      job.progressMessage = `Agent: planification (${iterLabel})...`;
      let plan;
      try {
        plan = await generateAgentPlan(project, currentMessage, job.agentSteps, existingFiles);
        job.agentSteps.push({ type: 'plan', summary: plan.analysis, iteration });
        console.log(`[Agent] Plan ${iterLabel}: ${plan.analysis} (${plan.steps?.length || 0} steps)`);
      } catch(e) {
        console.error(`[Agent] Plan failed ${iterLabel}: ${e.message}`);
        job.agentSteps.push({ type: 'plan_error', summary: e.message, iteration });
        // Fall back to direct generation without plan
        plan = { analysis: message, steps: [{ action: 'write_file', description: 'Generate directly' }], expectedOutcome: 'Working application' };
      }

      // ── EXECUTE ──
      job.progressMessage = `Agent: exécution du plan (${iterLabel})...`;
      let execResult;
      try {
        execResult = await executeAgentPlan(plan, project, job, callClaudeAPI, tools);
        job.agentSteps.push({ type: 'execute', summary: execResult.success ? 'OK' : execResult.error, iteration });
        if (execResult.code) job.code = execResult.code;
      } catch(e) {
        console.error(`[Agent] Execute failed ${iterLabel}: ${e.message}`);
        job.agentSteps.push({ type: 'execute_error', summary: e.message, iteration });
        continue;
      }

      // ── VALIDATE ──
      if (!containerExec) {
        // No Docker exec available — skip validation, trust the code
        job.status = 'done';
        job.progressMessage = `Agent: terminé en ${iteration + 1} itération(s) (sans validation)`;
        console.log(`[Agent] Done ${iterLabel} (no container exec for validation)`);
        return;
      }

      job.progressMessage = `Agent: validation (${iterLabel})...`;
      // Wait briefly for Vite to process file changes
      await new Promise(r => setTimeout(r, 3000));

      const validation = await validateAgentResult(project.id, containerExec);
      job.agentSteps.push({
        type: 'validate',
        summary: validation.success ? 'OK' : `${validation.errors.length} erreur(s)`,
        errors: validation.errors.map(e => e.message),
        iteration
      });

      if (validation.success) {
        job.status = 'done';
        job.progressMessage = `Agent: terminé en ${iteration + 1} itération(s)`;
        console.log(`[Agent] Success after ${iteration + 1} iterations`);
        return;
      }

      // ── FIX ──
      console.log(`[Agent] Validation failed ${iterLabel}: ${validation.errors.map(e => e.message).join(', ')}`);
      currentMessage = buildFixPrompt(validation, plan, execResult);
    }

    // Max iterations reached
    job.status = 'done';
    job.progressMessage = `Agent: terminé (limite de ${MAX_AGENT_ITERATIONS} itérations atteinte)`;
    console.log(`[Agent] Max iterations reached — returning best result`);
  }

  return { runAgentLoop, generateAgentPlan, validateAgentResult, buildFixPrompt };
};
