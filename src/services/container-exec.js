// ─── CONTAINER CODE EXECUTION (Enterprise-Grade, Lovable-Level) ───
// Execute commands inside Docker project containers.
// Security model: each project runs in an isolated Docker container.
// The AI can do anything INSIDE its container but NOTHING outside.
// Same model as Lovable, Bolt, Replit — sandboxed execution.

module.exports = function(ctx) {
  // ── SECURITY: Command whitelist ──
  // Only these binaries can be the FIRST command in a pipeline.
  // This prevents executing arbitrary binaries (curl attacks, reverse shells, etc.)
  const ALLOWED_COMMANDS = [
    // Node.js ecosystem
    'node', 'npm', 'npx',
    // File reading & inspection
    'cat', 'head', 'tail', 'less', 'wc', 'file',
    // Directory navigation
    'ls', 'pwd', 'du', 'tree',
    // Search & text processing
    'find', 'grep', 'awk', 'sed', 'sort', 'uniq', 'tr', 'cut', 'xargs',
    // Basic utilities
    'echo', 'printf', 'which', 'whoami', 'date', 'basename', 'dirname',
    // Environment
    'env', 'printenv',
    // File management (agent needs to create/move/delete files)
    'mkdir', 'cp', 'mv', 'touch', 'rm',
    // Text comparison
    'diff', 'comm',
    // Shell (needed for compound commands)
    'sh', 'bash',
    // Test expressions
    'test', '[', 'true', 'false',
  ];

  // ── SECURITY: Dangerous patterns (blocked even if command is allowed) ──
  const DANGEROUS_PATTERNS = [
    // Destructive filesystem
    'rm -rf /', 'rm -rf /*', 'rm -r /', 'rm -rf /app/node_modules',
    'mkfs', 'dd if=',
    // System manipulation
    '> /dev/', 'chmod 777 /', 'chmod -R 777 /',
    'shutdown', 'reboot', 'halt', 'poweroff', 'init 0',
    // Remote code execution
    'curl | sh', 'curl | bash', 'wget | sh', 'wget | bash',
    'eval $(curl', 'eval $(wget', '`curl', '`wget',
    // Sensitive files
    '/etc/shadow', '/etc/gshadow',
    // Container escape
    'docker', 'dockerd', 'containerd',
    'mount ', 'umount', 'nsenter', 'unshare',
    'chroot',
    // Network attacks
    'iptables', 'ip route', 'ip addr add',
    'nc -l', 'ncat -l', 'socat',
    // Process manipulation
    'kill -9 1', 'kill -KILL 1', 'kill -s KILL 1',
    // Package publishing
    'npm publish', 'npm adduser', 'npm login',
    // Crypto mining
    'minerd', 'xmrig', 'cpuminer',
  ];

  // ── SECURITY: Path restrictions ──
  const BLOCKED_PATHS = [
    '/proc/1', '/proc/sysrq', '/proc/kcore',
    '/sys/', '/boot/',
    '/root/.ssh', '/etc/ssh',
    '/var/run/docker.sock',
  ];

  // ── LIMITS (Lovable-level) ──
  const MAX_EXEC_TIMEOUT = 30000;     // 30s per command
  const BUILD_TIMEOUT = 120000;       // 2min for npm builds
  const VERIFY_TIMEOUT = 15000;       // 15s for health checks
  const MAX_OUTPUT_SIZE = 100000;     // 100KB — enough for large logs
  const MAX_COMMAND_LENGTH = 4000;    // 4KB command length
  const MAX_COMMANDS_PER_HOUR = 500;  // Agent can do ~8 commands per round × 25 rounds

  // ── RATE LIMITING ──
  const commandCounts = new Map();

  function checkRateLimit(projectId) {
    const now = Date.now();
    const entry = commandCounts.get(projectId);
    if (!entry || now > entry.resetTime) {
      commandCounts.set(projectId, { count: 1, resetTime: now + 3600000 });
      return true;
    }
    entry.count++;
    return entry.count <= MAX_COMMANDS_PER_HOUR;
  }

  // Clean up rate limit map periodically (prevent memory leak)
  setInterval(() => {
    const now = Date.now();
    for (const [pid, entry] of commandCounts) {
      if (now > entry.resetTime) commandCounts.delete(pid);
    }
  }, 600000); // every 10min

  function getContainerName(projectId) {
    return `pbp-project-${projectId}`;
  }

  function validateCommand(command) {
    if (!command || typeof command !== 'string') {
      return { allowed: false, reason: 'Commande vide ou invalide' };
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      return { allowed: false, reason: `Commande trop longue (max ${MAX_COMMAND_LENGTH} caractères)` };
    }

    // Check each command in pipeline
    const parts = command.split(/[|;&]/).map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const tokens = part.split(/\s+/);
      const cmd = tokens[0];
      const basename = cmd.split('/').pop();

      // Allow shell built-ins and control flow
      if (['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'exit', 'return', 'export', 'set', 'unset', 'cd'].includes(basename)) continue;

      if (!ALLOWED_COMMANDS.includes(basename) && !ALLOWED_COMMANDS.includes(cmd)) {
        return { allowed: false, reason: `Commande "${basename}" non autorisée. Utilisez: ${ALLOWED_COMMANDS.slice(0, 15).join(', ')}...` };
      }
    }

    // Check dangerous patterns (case-insensitive)
    const cmdLower = command.toLowerCase();
    for (const pattern of DANGEROUS_PATTERNS) {
      if (cmdLower.includes(pattern.toLowerCase())) {
        return { allowed: false, reason: `Opération dangereuse bloquée` };
      }
    }

    // Check blocked paths
    for (const blocked of BLOCKED_PATHS) {
      if (command.includes(blocked)) {
        return { allowed: false, reason: `Chemin restreint: ${blocked}` };
      }
    }

    return { allowed: true };
  }

  async function execInContainer(projectId, command, opts = {}) {
    if (!ctx.docker) throw new Error('Docker non disponible');

    if (!checkRateLimit(projectId)) {
      throw new Error(`Limite de commandes atteinte (${MAX_COMMANDS_PER_HOUR}/heure). Réessayez plus tard.`);
    }

    const validation = validateCommand(command);
    if (!validation.allowed) throw new Error(validation.reason);

    const containerName = getContainerName(projectId);
    let container;
    try {
      container = ctx.docker.getContainer(containerName);
      const info = await container.inspect();
      if (!info.State.Running) {
        throw new Error(`Container ${containerName} n'est pas en cours d'exécution`);
      }
    } catch (e) {
      if (e.statusCode === 404) throw new Error(`Container ${containerName} non trouvé`);
      throw e;
    }

    const startTime = Date.now();
    const cmdPreview = command.length > 80 ? command.substring(0, 80) + '...' : command;
    console.log(`[Exec] p=${projectId} $ ${cmdPreview}`);

    const exec = await container.exec({
      Cmd: ['sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts.cwd || '/app'
      // No User override — run as container default (root in Alpine, needed for file access)
    });

    const stream = await exec.start({ Detach: false, Tty: false });

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let totalSize = 0;
      let timedOut = false;
      const timeoutMs = opts.timeout || MAX_EXEC_TIMEOUT;

      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.destroy(); } catch(e) {}
        console.warn(`[Exec] TIMEOUT p=${projectId} ${timeoutMs}ms $ ${cmdPreview}`);
        resolve({
          stdout: stdout.substring(0, MAX_OUTPUT_SIZE),
          stderr: stderr.substring(0, MAX_OUTPUT_SIZE),
          exitCode: -1, timedOut: true,
          error: `Timeout après ${timeoutMs / 1000}s`
        });
      }, timeoutMs);

      const stdoutStream = {
        write: (chunk) => {
          const str = chunk.toString();
          totalSize += str.length;
          if (totalSize <= MAX_OUTPUT_SIZE) stdout += str;
        }
      };
      const stderrStream = {
        write: (chunk) => {
          const str = chunk.toString();
          totalSize += str.length;
          if (totalSize <= MAX_OUTPUT_SIZE) stderr += str;
        }
      };

      container.modem.demuxStream(stream, stdoutStream, stderrStream);

      stream.on('end', async () => {
        if (timedOut) return;
        clearTimeout(timer);
        let exitCode = 0;
        try {
          const inspectResult = await exec.inspect();
          exitCode = inspectResult.ExitCode || 0;
        } catch(e) {}

        const duration = Date.now() - startTime;
        if (exitCode !== 0 || duration > 5000) {
          console.log(`[Exec] p=${projectId} exit=${exitCode} ${duration}ms ${totalSize}b`);
        }

        resolve({
          stdout: stdout.substring(0, MAX_OUTPUT_SIZE),
          stderr: stderr.substring(0, MAX_OUTPUT_SIZE),
          exitCode, timedOut: false
        });
      });

      stream.on('error', (e) => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve({
          stdout: stdout.substring(0, MAX_OUTPUT_SIZE),
          stderr: e.message,
          exitCode: -1, timedOut: false, error: e.message
        });
      });
    });
  }

  async function buildInContainer(projectId) {
    return execInContainer(projectId, 'npm run build 2>&1', { timeout: BUILD_TIMEOUT });
  }

  async function healthCheckInContainer(projectId) {
    return execInContainer(projectId, 'wget -q -O- http://localhost:5173/ 2>&1 | head -50', { timeout: VERIFY_TIMEOUT });
  }

  // ── VERIFY PROJECT: Full diagnostic (syntax + health + errors) ──
  async function verifyProject(projectId) {
    const results = [];

    // 1. Syntax check server.js
    try {
      const check = await execInContainer(projectId, 'node --check server.cjs 2>&1', { timeout: 10000 });
      if (check.exitCode === 0) {
        results.push('✓ server.js: syntaxe OK');
      } else {
        results.push(`✗ server.js ERREUR DE SYNTAXE:\n${(check.stderr || check.stdout).substring(0, 500)}`);
      }
    } catch (e) {
      results.push(`⚠ Vérification syntaxe impossible: ${e.message}`);
    }

    // 2. Express health
    try {
      const health = await execInContainer(projectId, 'wget -q -O- http://localhost:3000/health 2>&1', { timeout: 5000 });
      if (health.stdout && health.stdout.includes('"ok"')) {
        results.push('✓ Express (port 3000): OK');
      } else {
        results.push(`✗ Express ne répond pas. Erreur: ${(health.stderr || health.stdout || 'timeout').substring(0, 200)}`);
      }
    } catch (e) {
      results.push(`✗ Express: ${e.message}`);
    }

    // 3. Check TSX compilation (Vite)
    try {
      const vite = await execInContainer(projectId, 'wget -q -O /dev/null http://localhost:5173/ 2>&1; echo "exit:$?"', { timeout: 8000 });
      if (vite.stdout && vite.stdout.includes('exit:0')) {
        results.push('✓ Vite (port 5173): OK');
      } else {
        results.push(`⚠ Vite ne répond pas ou erreur de compilation`);
      }
    } catch (e) {
      results.push(`⚠ Vite: ${e.message}`);
    }

    // 4. Scan for TypeScript/import errors in recent Vite output
    try {
      const tsErrors = await execInContainer(projectId, 'cat /tmp/vite-errors.log 2>/dev/null || echo "(pas de log)"', { timeout: 3000 });
      if (tsErrors.stdout && tsErrors.stdout.trim() !== '(pas de log)' && tsErrors.stdout.trim().length > 0) {
        results.push(`⚠ Erreurs Vite:\n${tsErrors.stdout.substring(0, 400)}`);
      }
    } catch {}

    return results.join('\n\n');
  }

  return { execInContainer, buildInContainer, healthCheckInContainer, verifyProject, validateCommand };
};
