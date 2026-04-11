// ─── PRESTIGE BUILD PRO — APP CONTEXT ───
// Central dependency injection container.
// Every module receives ctx instead of accessing globals.

class AppContext {
  constructor(config) {
    // Configuration (from config.js validateEnv())
    this.config = config;

    // Database (better-sqlite3 instance, set by database.js)
    this.db = null;

    // Docker (Dockerode instance, set by docker.js)
    this.docker = null;

    // In-memory cache (MemoryCache instance, set by memory.js)
    this.cache = null;

    // ─── Shared state Maps ───
    // Job tracking: Map<jobId, {status, code, error, progress, project_id, user_id, ...}>
    this.generationJobs = new Map();

    // Active Claude Code CLI processes: Map<projectId, ChildProcess>
    this.claudeCodeProcesses = new Map();

    // SSE clients: Map<projectId, Set<{res, userId, userName, connectedAt}>>
    this.projectSSEClients = new Map();

    // Client-side console logs: Map<projectId, [{level, message, timestamp}]>
    this.clientLogs = new Map();

    // Container access tracking for auto-sleep: Map<projectId, timestamp>
    this.containerLastAccess = new Map();

    // Auto-recovery cooldown: Map<projectId, timestamp>
    this.autoRecoveryLastRestart = new Map();

    // Projects already auto-fixed in this session: Set<projectId>
    this.proxyAutoFixedProjects = new Set();

    // In-memory auto-correction tracking
    this.correctionAttempts = new Map();
    this.correctionInProgress = new Set();

    // Concurrency counter
    this.activeGenerations = 0;

    // Shutdown flag
    this.shuttingDown = false;

    // Docker availability flag
    this.dockerAvailable = false;

    // Plan execution tracking: Set<planId>
    this.executedPlans = new Set();

    // Token blacklist (for logout): Set<token>
    this.tokenBlacklist = new Set();

    // Services (populated during init)
    this.services = {};
  }

  // Audit log helper — attached after DB init
  auditLog(req, user, action, resourceType, resourceId, details) {
    if (!this.db) return;
    try {
      const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.connection?.remoteAddress || null;
      const userAgent = req?.headers?.['user-agent']?.substring(0, 200) || null;
      const detailsStr = details ? (typeof details === 'string' ? details : JSON.stringify(details).substring(0, 500)) : null;
      this.db.prepare(
        'INSERT INTO audit_log (user_id, user_email, action, resource_type, resource_id, ip, user_agent, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(user?.id || null, user?.email || null, action, resourceType || null, resourceId ? String(resourceId) : null, ip, userAgent, detailsStr);
    } catch (e) {
      console.warn('[AuditLog] failed to log:', e.message);
    }
  }
}

module.exports = { AppContext };
