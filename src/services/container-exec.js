// ─── CONTAINER CODE EXECUTION ───
// Execute commands inside Docker project containers.
// Security: whitelist of allowed commands, timeout, output size limit.

module.exports = function(ctx) {
  const ALLOWED_COMMANDS = ['node', 'npm', 'npx', 'cat', 'ls', 'pwd', 'echo', 'head', 'tail', 'wc', 'find', 'grep', 'which'];
  const MAX_EXEC_TIMEOUT = 30000; // 30s
  const MAX_OUTPUT_SIZE = 50000;  // 50KB

  function getContainerName(projectId) {
    return `pbp-project-${projectId}`;
  }

  function validateCommand(command) {
    const cmd = command.trim().split(/\s+/)[0];
    // Allow full paths to node/npm
    const basename = cmd.split('/').pop();
    if (!ALLOWED_COMMANDS.includes(basename) && !ALLOWED_COMMANDS.includes(cmd)) {
      return { allowed: false, reason: `Commande non autorisée: ${cmd}. Autorisées: ${ALLOWED_COMMANDS.join(', ')}` };
    }
    // Block dangerous patterns
    const dangerous = ['rm -rf', 'rm -r /', 'mkfs', 'dd if=', '> /dev/', 'chmod 777', 'curl | sh', 'wget | sh'];
    for (const pattern of dangerous) {
      if (command.includes(pattern)) {
        return { allowed: false, reason: `Pattern dangereux détecté: ${pattern}` };
      }
    }
    return { allowed: true };
  }

  async function execInContainer(projectId, command, opts = {}) {
    if (!ctx.docker) throw new Error('Docker non disponible');

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

    const exec = await container.exec({
      Cmd: ['sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts.cwd || '/app'
    });

    const stream = await exec.start({ Detach: false, Tty: false });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let totalSize = 0;
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        try { stream.destroy(); } catch(e) {}
        resolve({
          stdout: stdout.substring(0, MAX_OUTPUT_SIZE),
          stderr: stderr.substring(0, MAX_OUTPUT_SIZE),
          exitCode: -1,
          timedOut: true,
          error: `Timeout après ${(opts.timeout || MAX_EXEC_TIMEOUT) / 1000}s`
        });
      }, opts.timeout || MAX_EXEC_TIMEOUT);

      // Demux Docker multiplexed stream
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
        clearTimeout(timeout);
        let exitCode = 0;
        try {
          const inspectResult = await exec.inspect();
          exitCode = inspectResult.ExitCode || 0;
        } catch(e) {}
        resolve({
          stdout: stdout.substring(0, MAX_OUTPUT_SIZE),
          stderr: stderr.substring(0, MAX_OUTPUT_SIZE),
          exitCode,
          timedOut: false
        });
      });

      stream.on('error', (e) => {
        if (timedOut) return;
        clearTimeout(timeout);
        resolve({
          stdout: stdout.substring(0, MAX_OUTPUT_SIZE),
          stderr: e.message,
          exitCode: -1,
          timedOut: false,
          error: e.message
        });
      });
    });
  }

  // Run npm run build inside container and return result
  async function buildInContainer(projectId) {
    return execInContainer(projectId, 'npm run build 2>&1', { timeout: 60000 });
  }

  // Run a quick health check (HTTP GET to Vite dev server)
  async function healthCheckInContainer(projectId) {
    return execInContainer(projectId, 'wget -q -O- http://localhost:5173/ 2>&1 | head -50', { timeout: 10000 });
  }

  return { execInContainer, buildInContainer, healthCheckInContainer, validateCommand };
};
