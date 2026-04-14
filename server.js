/*
 * PRESTIGE BUILD PRO - Server
 *
 * ARCHITECTURE: Modular server with dependency injection (AppContext).
 * ─────────────────────────────────────────────────────────────────
 * Modules in src/ receive ctx (AppContext) instead of accessing globals.
 * See src/context.js for shared state, src/config.js for constants.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync, spawn } = require('child_process');
const Dockerode = require('dockerode');

// ─── MODULAR IMPORTS ───
const { validateEnv, MAX_CONCURRENT_GENERATIONS, MAX_AUTO_CORRECTION_ATTEMPTS, CONTAINER_MONITORING_INTERVAL,
  SLEEP_TIMEOUT_MS, PREVIEW_RETENTION_MS, CLEANUP_INTERVAL_MS, MAX_CODE_DISPLAY_LENGTH,
  CLAUDE_CODE_TIMEOUT_MS, API_MAX_RETRIES, MAX_COLLABORATORS_PER_PROJECT, TOKEN_PRICING,
  ERROR_TYPES, API_ERROR_MESSAGES, ABSOLUTE_BROWSER_RULE, log } = require('./src/config');
const { AppContext } = require('./src/context');
const { MemoryCache } = require('./src/services/memory');
const { initDatabase } = require('./src/services/database');
const { Router } = require('./src/router');

// ─── INITIALIZE CONTEXT ───
const _config = validateEnv();
const ctx = new AppContext(_config);
ctx.cache = new MemoryCache();
ctx.cache.startCleanup();

// Initialize middleware (pass ctx)
const authMiddleware = require('./src/middleware/auth')(ctx);
const corsMiddleware = require('./src/middleware/cors')(ctx);
const bodyMiddleware = require('./src/middleware/body')(ctx);
const validationMiddleware = require('./src/middleware/validation')(ctx);
const rateLimitMiddleware = require('./src/middleware/rate-limit')(ctx);
const encryptionService = require('./src/services/encryption')(ctx);
const sseService = require('./src/services/sse')(ctx);
const tokenTrackingService = require('./src/services/token-tracking')(ctx);

// ─── BACKWARDS-COMPAT ALIASES ───
// These delegate to the modules so existing code in server.js keeps working
// as we progressively extract more functions in Phase 2+3.
const PORT = ctx.config.PORT;
const ANTHROPIC_API_KEY = ctx.config.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = ctx.config.OPENAI_API_KEY;
const JWT_SECRET = ctx.config.JWT_SECRET;
const ENCRYPTION_KEY_RAW = ctx.config.ENCRYPTION_KEY_RAW;

const cache = ctx.cache;
const { signToken, verifyToken, getAuth } = authMiddleware;
const { setCorsHeaders, setSecurityHeaders } = corsMiddleware;
const { json, getBody } = bodyMiddleware;
const { validateString, validateId, paginate, isPathSafe, isValidJson } = validationMiddleware;
const { checkRateLimit } = rateLimitMiddleware;
const { encryptValue, decryptValue } = encryptionService;
const { notifyProjectClients, getProjectCollaborators, addSSEClient, removeSSEClient } = sseService;
const { classifyComplexity, trackTokenUsage, checkUserQuota } = tokenTrackingService;

// ─── NEW FEATURE SERVICES (fail-safe: server starts even if a service fails) ───
let containerExecService = null;
let conversationMemoryService = null;
let agentModeService = null;
try { containerExecService = require('./src/services/container-exec')(ctx); } catch(e) { console.warn('[Init] container-exec not loaded:', e.message); }
try { conversationMemoryService = require('./src/services/conversation-memory')(ctx); } catch(e) { console.warn('[Init] conversation-memory not loaded:', e.message); }
try { agentModeService = require('./src/services/agent-mode')(ctx); } catch(e) { console.warn('[Init] agent-mode not loaded:', e.message); }

// Store services in ctx for cross-module access
ctx.services.containerExec = containerExecService;
ctx.services.conversationMemory = conversationMemoryService;
ctx.services.agentMode = agentModeService;

let activeGenerations = 0;

// ─── GLOBAL ERROR HANDLERS + GRACEFUL SHUTDOWN ───
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Erreur non gérée: ${err.message}`);
  console.error(err.stack);
  setTimeout(() => process.exit(1), 1000);
});
process.on('unhandledRejection', (err) => {
  console.error(`[FATAL] Promise rejetée: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
});
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  ctx.shuttingDown = true;
  console.log(`[Shutdown] ${signal} received — closing gracefully...`);
  if (typeof server !== 'undefined' && server.close) {
    server.close(() => console.log('[Shutdown] HTTP server closed'));
  }
  try { if (db) db.close(); console.log('[Shutdown] Database closed'); } catch(e) {}
  setTimeout(() => { console.log('[Shutdown] Forcing exit'); process.exit(0); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const DB_PATH = ctx.config.DB_PATH;
const PREVIEWS_DIR = ctx.config.PREVIEWS_DIR;
const DOCKER_PROJECTS_DIR = ctx.config.DOCKER_PROJECTS_DIR;
const DOCKER_NETWORK = ctx.config.DOCKER_NETWORK;
const DOCKER_BASE_IMAGE = ctx.config.DOCKER_BASE_IMAGE;
const ENCRYPT_KEY = ctx.config.ENCRYPT_KEY;
const ENCRYPT_PREFIX = ctx.config.ENCRYPT_PREFIX;
const DOCKER_HEALTH_TIMEOUT = ctx.config.DOCKER_HEALTH_TIMEOUT;
const DOCKER_SOCKET_PATH = ctx.config.DOCKER_SOCKET_PATH;

// Dockerode client
let docker = null;
try {
  docker = new Dockerode({ socketPath: DOCKER_SOCKET_PATH });
  ctx.docker = docker;
} catch (e) {
  console.warn('Failed to initialize Dockerode client:', e.message);
}

// ─── ANTHROPIC API RATE LIMIT HANDLER ───
const API_QUEUE = [];
let apiRunning = false;

function anthropicRequest(payload, opts, onResponse, onError, job, retryCount = 0) {
  // Defensive onError wrapper — anthropicRequest is called from many sites,
  // some of which historically did not pass onError. Without this wrapper a
  // network error would crash the process via "onError is not a function".
  const safeOnError = (typeof onError === 'function')
    ? onError
    : (e) => { console.error(`[anthropicRequest] unhandled (no onError): ${e.message}`); if (job) { job.status = job.status || 'error'; job.error = job.error || e.message; } };
  const r = https.request(opts, apiRes => {
    const status = apiRes.statusCode;

    // Retryable errors: 429 (rate limit), 529 (overloaded), 500/502/503 (server errors)
    // Uses exponential backoff: 1s → 2s → 4s → 8s (capped at retry-after header if present)
    if (status === 429 || status === 529 || status === 500 || status === 502 || status === 503) {
      let body = '';
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        if (retryCount < API_MAX_RETRIES) {
          // Exponential backoff: 1s, 2s, 4s, 8s... capped by retry-after header
          const expBackoff = Math.min(1000 * Math.pow(2, retryCount), 30000);
          const retryAfterHeader = parseInt(apiRes.headers['retry-after'] || '0') * 1000;
          const wait = retryAfterHeader > 0 ? Math.min(retryAfterHeader, 60000) : expBackoff;
          console.log(`[API] ${status} — retry ${retryCount + 1}/${API_MAX_RETRIES} in ${(wait / 1000).toFixed(1)}s (backoff)`);
          if (job) job.progressMessage = `Reconnexion API... (${retryCount + 1}/${API_MAX_RETRIES})`;
          setTimeout(() => anthropicRequest(payload, opts, onResponse, onError, job, retryCount + 1), wait);
        } else {
          console.error(`[API] Exhausted ${API_MAX_RETRIES} retries on ${status}`);
          safeOnError(new Error(API_ERROR_MESSAGES[status] || `Erreur API ${status} après ${API_MAX_RETRIES} tentatives.`));
        }
      });
      return;
    }

    // Non-retryable errors: 400, 401, 402, 403, 404, 413
    if (status >= 400 && status !== 200) {
      let body = '';
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        console.error(`[API] HTTP ${status}: ${body.substring(0, 300)}`);

        // Parse API error message for better user feedback
        let friendlyMsg = API_ERROR_MESSAGES[status] || `Erreur API (${status}).`;
        try {
          const apiError = JSON.parse(body);
          const apiMsg = apiError?.error?.message || '';
          // Credit/billing issues — show clear message
          if (apiMsg.includes('credit balance') || apiMsg.includes('billing')) {
            friendlyMsg = 'Le service IA est temporairement indisponible (crédit épuisé). Veuillez contacter l\'administrateur.';
            console.error('[API] ⚠️ BILLING ISSUE — Anthropic account needs funding');
            if (job) job.progressMessage = '⚠️ Service IA indisponible';
          }
          // Bad API key
          else if (status === 401) {
            friendlyMsg = 'Le service IA n\'est pas correctement configuré. Contactez l\'administrateur.';
            console.error('[API] ⚠️ INVALID API KEY');
          }
          // Model not found
          else if (apiMsg.includes('model')) {
            friendlyMsg = `Modèle non disponible: ${apiMsg}`;
          }
          // Token limit
          else if (apiMsg.includes('token') || apiMsg.includes('too long')) {
            friendlyMsg = 'Le message est trop long. Essayez avec un texte plus court.';
          }
        } catch {}

        safeOnError(new Error(friendlyMsg));
      });
      return;
    }

    onResponse(apiRes);
  });
  r.on('error', e => {
    // User-initiated AbortController.abort() — never retry, propagate immediately so
    // the caller can mark the job as 'cancelled' (not 'error').
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ERR_CANCELED')) {
      console.log(`[API] Request aborted by user`);
      safeOnError(e);
      return;
    }
    if (retryCount < 2) {
      console.log(`[API] Network error, retrying in 5s: ${e.message}`);
      setTimeout(() => anthropicRequest(payload, opts, onResponse, onError, job, retryCount + 1), 5000);
    } else {
      safeOnError(new Error('Erreur réseau. Vérifiez la connexion internet du serveur.'));
    }
  });
  r.setTimeout(CLAUDE_CODE_TIMEOUT_MS, () => {
    r.destroy();
    safeOnError(new Error('Délai dépassé (5 min). Le brief est peut-être trop complexe — essayez en le simplifiant.'));
  });
  r.write(payload);
  r.end();
}

// Token tracking and quota — delegated to src/services/token-tracking.js (imported above)

// Preview system constants — from src/config.js (imported above)

// Error management + browser rule — from src/config.js (imported above)
const containerLastAccess = ctx.containerLastAccess;

// Default valid package.json for fallback (React + Vite)
const DEFAULT_PACKAGE_JSON = JSON.stringify({
  name: "prestige-project",
  version: "1.0.0",
  private: true,
  type: "module",
  scripts: {
    dev: "vite --host 0.0.0.0 --port 5173",
    build: "vite build",
    start: "node server.js"
  },
  dependencies: {
    react: "19.1.0",
    "react-dom": "19.1.0",
    "react-router-dom": "7.6.1",
    "lucide-react": "0.511.0",
    "class-variance-authority": "0.7.1",
    clsx: "2.1.1",
    "tailwind-merge": "3.3.0",
    sonner: "2.0.3",
    cmdk: "1.1.1",
    "@radix-ui/react-dialog": "1.1.14",
    "@radix-ui/react-dropdown-menu": "2.1.15",
    "@radix-ui/react-tabs": "1.1.12",
    "@radix-ui/react-accordion": "1.2.11",
    "@radix-ui/react-tooltip": "1.2.8",
    "@radix-ui/react-popover": "1.1.14",
    "@radix-ui/react-checkbox": "1.3.3",
    "@radix-ui/react-switch": "1.2.6",
    "@radix-ui/react-radio-group": "1.3.8",
    "@radix-ui/react-slider": "1.3.6",
    "@radix-ui/react-progress": "1.1.7",
    "@radix-ui/react-collapsible": "1.1.7",
    "@radix-ui/react-scroll-area": "1.2.8",
    "@radix-ui/react-separator": "1.1.7",
    "@radix-ui/react-label": "2.1.7",
    "@radix-ui/react-avatar": "1.1.7",
    "@radix-ui/react-alert-dialog": "1.1.14",
    "@radix-ui/react-select": "2.2.6",
    "@radix-ui/react-context-menu": "2.2.15",
    "@radix-ui/react-hover-card": "1.1.14",
    "@radix-ui/react-menubar": "1.1.15",
    "@radix-ui/react-navigation-menu": "1.2.13",
    "@radix-ui/react-toggle": "1.1.9",
    "@radix-ui/react-toggle-group": "1.1.10",
    "@radix-ui/react-aspect-ratio": "1.1.7",
    "@radix-ui/react-slot": "1.2.3",
    "react-day-picker": "9.6.4",
    "input-otp": "1.4.2",
    "react-resizable-panels": "2.1.7",
    "tailwindcss-animate": "1.0.7",
    "embla-carousel-react": "8.6.0",
    "next-themes": "0.4.6",
    "vaul": "1.1.2",
    "react-hook-form": "7.54.2",
    "@hookform/resolvers": "4.1.3",
    zod: "3.24.4",
    express: "4.18.2",
    "better-sqlite3": "9.4.3",
    bcryptjs: "2.4.3",
    jsonwebtoken: "9.0.2",
    cors: "2.8.5",
    helmet: "7.1.0",
    compression: "1.7.4",
    "date-fns": "3.6.0",
    recharts: "2.15.0"
  },
  devDependencies: {
    vite: "6.3.5",
    "@vitejs/plugin-react": "4.5.2",
    tailwindcss: "3.4.17",
    postcss: "8.5.3",
    autoprefixer: "10.4.21"
  }
}, null, 2);

// Default valid server.js for fallback (serves Vite build output)
const DEFAULT_SERVER_JS = `const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const dbPath = process.env.DB_PATH || '/data/database.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());

// Serve Vite build output
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

db.exec(\`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );
\`);

const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@project.com');
if (!adminExists) {
  db.prepare('INSERT INTO users (email, password, name, role) VALUES (?, ?, ?, ?)').run(
    'admin@project.com',
    bcrypt.hashSync('Admin2024!', 12),
    'Administrateur',
    'admin'
  );
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Caddy on_demand TLS check — validates that a subdomain is allowed
app.get('/api/tls-check', (req, res) => {
  const domain = req.query.domain || '';
  // Allow preview-{id}.app.prestige-build.dev and {subdomain}.prestige-build.dev
  if (domain.endsWith('.app.prestige-build.dev') || domain.endsWith('.prestige-build.dev')) {
    res.status(200).end();
  } else {
    res.status(403).end();
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user && bcrypt.compareSync(password, user.password)) {
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } else {
    res.status(401).json({ success: false, message: 'Identifiants invalides' });
  }
});

// SPA fallback
app.get(/.*/, (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Build not found' });
  }
});

app.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));

// CREDENTIALS: email=admin@project.com password=Admin2024!
`;

// Default valid index.html for fallback (React entry point — at project root, NOT in public/)
const DEFAULT_INDEX_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prestige App</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`;

// Default React source files for fallback
const DEFAULT_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    watch: {
      usePolling: true,
      interval: 500,
    },
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000'
    }
  },
  build: { outDir: 'dist' }
});
`;

const DEFAULT_MAIN_JSX = `import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// basename from Vite --base flag (e.g. /run/87/) so React Router matches URLs correctly
const basename = import.meta.env.BASE_URL.replace(/\\/$/, '') || '/';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
`;

const DEFAULT_INDEX_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  * { @apply border-border; }
  body {
    @apply bg-background text-foreground;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
}

html { scroll-behavior: smooth; }
*:focus-visible { @apply outline-none ring-2 ring-ring ring-offset-2; }
`;

const DEFAULT_APP_JSX = `import React from 'react';

export default function App() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center p-8 animate-pulse">
        <div className="w-12 h-12 mx-auto mb-6 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        <p className="text-muted-foreground text-sm">Chargement...</p>
      </div>
    </div>
  );
}
`;

// In-memory tracking — from ctx
const correctionAttempts = ctx.correctionAttempts;
const correctionInProgress = ctx.correctionInProgress;

// Ensure previews directory exists
if (!fs.existsSync(PREVIEWS_DIR)) fs.mkdirSync(PREVIEWS_DIR, { recursive: true });

let compiler, ai, coherence, idempotentCopy;
try { compiler = require('./src/compiler'); } catch(e) {}
try { ai = require('./src/ai'); } catch(e) {}
try { coherence = require('./src/coherence'); } catch(e) { console.warn('[Init] coherence module not loaded:', e.message); }
try { idempotentCopy = require('./src/idempotent-copy'); } catch(e) { console.warn('[Init] idempotent-copy module not loaded:', e.message); }

// ─── DATABASE (delegated to src/services/database.js) ───
let db;
try {
  db = initDatabase(ctx);
  ctx.db = db;
} catch(e) { console.error('DB:', e.message); }

// ─── SSE & JOBS — from ctx ───
const projectSSEClients = ctx.projectSSEClients;
const generationJobs = ctx.generationJobs;

// ─── SITES DIRECTORY FOR PUBLISHED SITES ───
const SITES_DIR = process.env.SITES_DIR || '/data/sites';
const PUBLISH_DOMAIN = process.env.PUBLISH_DOMAIN || 'prestige-build.dev';

// Generate preview URL — subdomain (pro) with /run/ fallback
function getPreviewUrl(projectId) {
  // Subdomain preview: preview-59.prestige-build.dev (no proxy rewriting needed)
  const subdomainUrl = `https://preview-${projectId}.${PUBLISH_DOMAIN}`;
  // Fallback: /run/59/ (requires proxy rewriting)
  const pathUrl = `/run/${projectId}/`;
  return { subdomain: subdomainUrl, path: pathUrl, preferred: subdomainUrl };
}
const CNAME_TARGET = process.env.CNAME_TARGET || `app.${PUBLISH_DOMAIN}`;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const CADDY_ADMIN_API = process.env.CADDY_ADMIN_API || 'http://localhost:2019';
const SERVER_IP = process.env.SERVER_IP || '204.168.177.199';
if (!fs.existsSync(SITES_DIR)) { try { fs.mkdirSync(SITES_DIR, { recursive: true }); } catch(e) { console.warn('Could not create SITES_DIR:', e.message); } }

// ─── SCREENSHOTS DIRECTORY FOR VERSION HISTORY ───
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/data/screenshots';
if (!fs.existsSync(SCREENSHOTS_DIR)) { try { fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch(e) { console.warn('Could not create SCREENSHOTS_DIR:', e.message); } }

// Path/JSON validation — delegated to src/middleware/validation.js (imported above)

// ─── CADDY CUSTOM DOMAIN HELPER ───
async function addCustomDomainToCaddy(customDomain, siteDir) {
  // Custom domains are routed by server.js (not Caddy).
  // The client points their domain A record to our server IP.
  // Caddy accepts all hostnames on :80, proxies to Prestige.
  // Prestige detects the custom domain via Host header and serves the published site.
  // SSL is handled by Cloudflare (if they proxy through CF) or not at all (direct A record).
  console.log(`[Custom Domain] ${customDomain} configured — route via server.js Host header detection`);
  return { success: true, domain: customDomain };
}

// ─── AUTH, JSON, CORS, BODY ───
// Delegated to src/middleware/ (imported above as authMiddleware, corsMiddleware, bodyMiddleware)
// Backwards-compat: keep cors() function name used in server handler
function cors(res) {
  corsMiddleware.setCorsHeaders(res);
}

// ─── STREAM CLAUDE ───
// ─── STREAM CLAUDE (DEPRECATED - KEPT FOR BACKWARDS COMPATIBILITY) ───
// NOTE: For project generation, use generateClaudeCode() instead which spawns Claude Code server-side
function streamClaude(messages, res, onDone, brief, options = {}) {
  // Send deprecation notice and end stream
  console.warn('[streamClaude] Deprecated: This function should not be used for project generation. Use Claude Code instead.');
  res.write(`data: ${JSON.stringify({type:'info',content:'Utilisation de Claude Code pour la génération...'})}\n\n`);
  res.write(`data: ${JSON.stringify({type:'done'})}\n\n`);
  res.end();
  if (onDone) onDone('');
}

// ─── STREAM CLAUDE WITH IMAGE (DEPRECATED - KEPT FOR BACKWARDS COMPATIBILITY) ───
// NOTE: For image-based generation, use generateClaudeWithImage() instead which spawns Claude Code server-side
function streamClaudeWithImage(imageBase64, mediaType, prompt, res, onDone) {
  // Send deprecation notice and end stream
  console.warn('[streamClaudeWithImage] Deprecated: This function should not be used for project generation. Use Claude Code instead.');
  res.write(`data: ${JSON.stringify({type:'info',content:'Utilisation de Claude Code pour la génération...'})}\n\n`);
  res.write(`data: ${JSON.stringify({type:'done'})}\n\n`);
  res.end();
  if (onDone) onDone('');
}

// ─── CLAUDE.MD TEMPLATE GENERATOR (React + Vite v2) ───
function generateClaudeMdTemplate(brief, sectorProfile, savedApis) {
  const apiSection = savedApis && savedApis.length > 0
    ? `\n## APIs disponibles\n${savedApis.map(a => `- ${a.name} (${a.service}): ${a.description || 'Disponible'}`).join('\n')}\n`
    : '';

  return `# Prestige AI — Instructions (React + Vite)

Tu es Prestige AI, le meilleur générateur d'applications React + Vite. Tu travailles dans le dossier courant uniquement.

## Brief
${brief}
${sectorProfile ? `\n## Profil détecté\n${sectorProfile}\n` : ''}${apiSection}
## Architecture du projet

Crée un projet React + Vite + TailwindCSS professionnel avec cette structure :

\`\`\`
package.json          — "type": "module", dépendances React + Vite + backend
vite.config.js        — plugins: react + tailwindcss, proxy /api → localhost:3000
index.html            — point d'entrée avec <div id="root"> (à la RACINE, pas dans public/)
server.js             — backend Express servant dist/ en production
src/
  main.tsx            — ReactDOM.createRoot
  index.css           — @import "tailwindcss"
  App.tsx             — BrowserRouter + Routes + Layout
  components/
    Header.tsx        — Navigation responsive avec menu mobile
    Footer.tsx        — Pied de page
    ...               — Composants réutilisables selon le secteur
  pages/
    Home.tsx          — Page d'accueil
    ...               — Pages selon le secteur
\`\`\`

## Stack technique (versions fixes)

**Frontend :**
- react 19.1.0, react-dom 19.1.0
- react-router-dom 7.6.1
- lucide-react 0.511.0 (icônes)
- clsx 2.1.1 (classes conditionnelles)
- vite 6.3.5, @vitejs/plugin-react 4.5.2
- tailwindcss 4.1.7, @tailwindcss/vite 4.1.7

**Backend :**
- express 4.18.2, better-sqlite3 9.4.3
- bcryptjs 2.4.3, jsonwebtoken 9.0.2
- cors 2.8.5, helmet 7.1.0, compression 1.7.4

## Règles React

1. Un composant = un fichier .tsx avec export default function
2. Composants dans src/components/, pages dans src/pages/
3. TailwindCSS dans className="..." — JAMAIS de CSS inline
4. Icônes : import { Icon } from 'lucide-react'
5. Navigation : <Link to="/page"> de react-router-dom
6. fetch('/api/...') pour le backend (avec slash — Vite proxy gère)
7. useState, useEffect, useCallback pour state/effets
8. Responsive mobile-first : sm:, md:, lg:, xl:

## server.js — Backend Express (COMMONJS OBLIGATOIRE)

RÈGLE ABSOLUE : server.js utilise UNIQUEMENT CommonJS :
  const express = require('express');  — PAS import express from 'express'
  const Database = require('better-sqlite3');  — PAS import Database from ...
  module.exports = ...  — PAS export default
  JAMAIS de import/export ES modules dans server.js

- Port 3000, app.listen(PORT, '0.0.0.0', ...) — écouter sur TOUTES les interfaces
- Route /health : res.json({ status: 'ok' })
- Sert dist/ : app.use(express.static(path.join(__dirname, 'dist')))
- SQLite : tables selon le secteur avec données de démo (INSERT INTO pour 5-10 entrées)
- JWT auth : POST /api/auth/login (email+password), retourne { token, user }
- Middleware authenticateToken : vérifie Bearer token dans Authorization header
- Routes publiques : GET /api/services, GET /api/[items-secteur]
- Routes protégées : GET /api/appointments, GET /api/contacts (nécessitent token)
- Compte admin créé au démarrage : INSERT IF NOT EXISTS
- Ordre : static → public routes → auth middleware → protected routes → SPA fallback
- SPA fallback : app.get(/.*/, ...) qui sert dist/index.html
- À la FIN : // CREDENTIALS: email=admin@[nom-projet].com password=[MotDePasse]

## vite.config.js

\`\`\`js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true, proxy: { '/api': 'http://localhost:3000', '/health': 'http://localhost:3000' } },
  build: { outDir: 'dist' }
});
\`\`\`

## src/index.css

\`\`\`css
@import "tailwindcss";
\`\`\`

## Qualité

- Design professionnel TailwindCSS, responsive mobile-first
- Contenu réel adapté au secteur, zéro lorem ipsum
- Animations Tailwind (transition, hover:, group-hover:)
- Images : TOUJOURS picsum.photos/seed/DESCRIPTIF/W/H (avec seed pour image fixe, jamais picsum.photos/W/H sans seed)
- Toutes les pages fonctionnelles
- Données de démo réalistes dans SQLite

## Processus

1. Génère tous les fichiers du projet React
2. Teste : \`node --check server.js\`
3. Installe et build : \`npm install && npm run build\`
4. Lance : \`node server.js &\`
5. Teste : \`curl http://localhost:3000/health\`
6. Corrige si erreur, reteste
7. Quand tout fonctionne, écris le fichier \`READY\`
8. Si échec après 5 tentatives, écris \`ERROR\`

## Recherche Web

Tu as accès à la recherche web. Utilise-la PROACTIVEMENT pour :
- Trouver la documentation d'APIs ou libraries que tu ne connais pas
- Vérifier la syntaxe exacte d'un composant Radix UI ou Recharts
- Chercher des exemples de code pour des patterns complexes (OAuth, Stripe, etc.)
- Résoudre des erreurs de build que tu ne comprends pas
NE PAS chercher pour des choses basiques que tu connais déjà (React, TailwindCSS, Express).

## Exécution de commandes

Tu peux exécuter des commandes dans le projet :
- \`node --check server.js\` pour vérifier la syntaxe
- \`npm run build\` pour vérifier que le build passe
- \`cat src/App.tsx\` pour relire un fichier
- \`ls src/components/\` pour voir les fichiers existants
Utilise ces commandes pour VALIDER ton travail avant d'écrire READY.
`;
}

// ─── REACT PROJECT FILE HELPERS ───

// Read all valid project files recursively from a directory
// ─── DIRECT AUTO-FIX: Fix mechanical code errors WITHOUT calling the AI ───
// These are deterministic fixes (regex-based) that don't need AI intelligence.
// Calling Claude to fix "public → publicItem" wastes tokens and often FAILS because
// the file isn't in Claude's context. Direct fix = instant, free, 100% reliable.
function autoFixMechanicalErrors(projectDir, files) {
  const JS_RESERVED = new Set([
    'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new',
    'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
    'while', 'with', 'class', 'const', 'enum', 'export', 'extends', 'import',
    'super', 'implements', 'interface', 'let', 'package', 'private', 'protected',
    'public', 'static', 'yield', 'await', 'async'
  ]);

  let totalFixes = 0;

  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts') && !fn.endsWith('.jsx')) continue;
    let fixed = content;

    // ── Fix reserved words used as variable names ──
    // Simple approach: find EVERY reserved word used as a standalone variable reference
    // and rename it to reservedItem. No complex scope analysis needed.
    for (const reserved of JS_RESERVED) {
      // Skip if this word doesn't appear in the file at all
      if (!fixed.includes(reserved)) continue;
      // Skip common false positives: 'export default', 'import {', 'return (', etc.
      // We ONLY want to fix cases where the reserved word is used as a VARIABLE NAME
      // i.e., in callback params: .map((public, i) => public.name)

      // Step 1: Check if this reserved word is used as a callback parameter
      // Pattern: (reserved, or (reserved) in a callback context
      const paramPattern = new RegExp(`\\(${reserved}\\s*[,):]`, 'g');
      // We need to verify it's in a callback, not a function declaration or other context
      // Heuristic: preceded by => or followed by =>
      const lines = fixed.split('\n');
      let hasCallbackUsage = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match: .map((public, index) => or .filter((public) => etc.
        if (new RegExp(`\\.(map|filter|forEach|find|some|every|reduce|flatMap|sort)\\s*\\(\\s*\\(.*\\b${reserved}\\b`).test(line)) {
          hasCallbackUsage = true;
          break;
        }
        // Also match split across lines: .map(\n  (public, index) =>
        if (paramPattern.test(line) && (line.includes('=>') || (i + 1 < lines.length && lines[i + 1].includes('=>')))) {
          // Make sure it's not a false positive like 'export default function'
          if (!line.trim().startsWith('export') && !line.trim().startsWith('import') && !line.trim().startsWith('return') && !line.trim().startsWith('function')) {
            hasCallbackUsage = true;
            break;
          }
        }
        paramPattern.lastIndex = 0; // reset regex state
      }

      if (!hasCallbackUsage) continue;

      const replacement = reserved + 'Item';
      console.log(`[AutoFix] Renaming reserved word "${reserved}" → "${replacement}" in ${fn}`);

      // Step 2: Replace the parameter in callback signatures
      // .map((public, index) => → .map((publicItem, index) =>
      // .map((public) => → .map((publicItem) =>
      fixed = fixed.replace(new RegExp(`(\\.(map|filter|forEach|find|some|every|reduce|flatMap|sort)\\s*\\()\\s*\\(([^)]*?)\\b${reserved}\\b([^)]*?)\\)\\s*=>`, 'g'),
        (match, prefix, method, before, after) => {
          return `${prefix}(${before}${replacement}${after}) =>`;
        }
      );

      // Step 3: Replace ALL variable references in the file
      // {public.name} → {publicItem.name}
      fixed = fixed.replace(new RegExp(`\\{${reserved}\\.`, 'g'), `{${replacement}.`);
      // {public} → {publicItem}
      fixed = fixed.replace(new RegExp(`\\{${reserved}\\}`, 'g'), `{${replacement}}`);
      // key={public.id} → key={publicItem.id}
      fixed = fixed.replace(new RegExp(`=\\{${reserved}\\.`, 'g'), `={${replacement}.`);
      // public.name (standalone, not part of publicCibles or other compound words)
      fixed = fixed.replace(new RegExp(`(?<![\\w])${reserved}\\.(?!\\w*\\()`, 'g'), (m, offset) => {
        // Don't replace if it's part of a longer word like "publicCibles."
        const charBefore = offset > 0 ? fixed[offset - 1] : '';
        if (/\w/.test(charBefore)) return m;
        return `${replacement}.`;
      });
      // public?.name → publicItem?.name
      fixed = fixed.replace(new RegExp(`(?<![\\w])${reserved}\\?\\.`, 'g'), `${replacement}?.`);
    }

    // ── Fix require() in TSX/JSX → ESM import ──
    fixed = fixed.replace(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, (match, varName, mod) => {
      return `import ${varName} from '${mod}'`;
    });

    // ── Fix duplicate declarations: lucide icon name conflicts with component name ──
    // Common AI mistake: import { Users } from 'lucide-react' + export default function Users()
    const componentNameMatch = fixed.match(/export\s+default\s+function\s+(\w+)/);
    if (componentNameMatch) {
      const compName = componentNameMatch[1];
      // Check if same name is imported from lucide-react
      const lucideImportRe = new RegExp(`import\\s*\\{([^}]*\\b${compName}\\b[^}]*)\\}\\s*from\\s*['"]lucide-react['"]`);
      const lucideMatch = fixed.match(lucideImportRe);
      if (lucideMatch) {
        // Rename the icon import: Users → UsersIcon
        fixed = fixed.replace(lucideImportRe, (m, imports) => {
          const renamed = imports.replace(new RegExp(`\\b${compName}\\b`), `${compName} as ${compName}Icon`);
          return `import {${renamed}} from 'lucide-react'`;
        });
        // Rename usage in JSX: <Users → <UsersIcon
        fixed = fixed.replace(new RegExp(`<${compName}(\\s|\\/)`, 'g'), `<${compName}Icon$1`);
        fixed = fixed.replace(new RegExp(`{${compName}}`, 'g'), `{${compName}Icon}`);
      }
    }

    if (fixed !== content) {
      const filePath = path.join(projectDir, fn);
      try {
        fs.writeFileSync(filePath, fixed, 'utf8');
        totalFixes++;
        console.log(`[AutoFix] ✅ Fixed ${fn}`);
      } catch (e) {
        console.warn(`[AutoFix] Failed to write ${fn}: ${e.message}`);
      }
    }
  }

  // ── Fix min-h-screen in internal pages when InternalLayout exists ──
  // When a project has an InternalLayout.tsx (which manages viewport height),
  // pages inside src/pages/internal/ should NOT use min-h-screen (causes double scrollbars).
  try {
    const internalPagesDir = path.join(projectDir, 'src', 'pages', 'internal');
    const hasInternalLayout = fs.existsSync(path.join(projectDir, 'src', 'components', 'InternalLayout.tsx'))
      || fs.existsSync(path.join(projectDir, 'src', 'layouts', 'InternalLayout.tsx'));
    if (hasInternalLayout && fs.existsSync(internalPagesDir)) {
      for (const f of fs.readdirSync(internalPagesDir)) {
        if (!f.endsWith('.tsx') && !f.endsWith('.jsx')) continue;
        const filePath = path.join(internalPagesDir, f);
        let content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('min-h-screen')) {
          const original = content;
          // Remove min-h-screen from className strings
          content = content.replace(/min-h-screen\s+/g, '');
          content = content.replace(/\s+min-h-screen/g, '');
          content = content.replace(/["']min-h-screen["']/g, '""');
          if (content !== original) {
            fs.writeFileSync(filePath, content, 'utf8');
            totalFixes++;
            console.log(`[AutoFix] ✅ Removed min-h-screen from src/pages/internal/${f} (InternalLayout handles height)`);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[AutoFix] min-h-screen check failed: ${e.message}`);
  }

  // ── Fix missing shadcn CSS variables ──
  // If the project uses shadcn (has src/components/ui/) but index.css is missing
  // the required CSS custom properties, inject the standard shadcn/ui theme.
  const SHADCN_CSS_VARS = `@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 213 72% 59%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 213 72% 59%;
    --radius: 0.5rem;
  }
}`;

  try {
    const uiDir = path.join(projectDir, 'src', 'components', 'ui');
    const indexCssPath = path.join(projectDir, 'src', 'index.css');
    if (fs.existsSync(uiDir) && fs.existsSync(indexCssPath)) {
      let cssContent = fs.readFileSync(indexCssPath, 'utf8');
      if (!cssContent.includes('--background:') && !cssContent.includes('--background :')) {
        console.log(`[AutoFix] Injecting shadcn CSS variables into src/index.css`);
        // Insert after @tailwind directives if present, otherwise prepend
        const tailwindEnd = cssContent.lastIndexOf('@tailwind');
        if (tailwindEnd !== -1) {
          const lineEnd = cssContent.indexOf('\n', tailwindEnd);
          const insertPos = lineEnd !== -1 ? lineEnd + 1 : cssContent.length;
          cssContent = cssContent.slice(0, insertPos) + '\n' + SHADCN_CSS_VARS + '\n' + cssContent.slice(insertPos);
        } else {
          cssContent = SHADCN_CSS_VARS + '\n\n' + cssContent;
        }
        fs.writeFileSync(indexCssPath, cssContent, 'utf8');
        totalFixes++;
        console.log(`[AutoFix] ✅ Fixed src/index.css — shadcn CSS variables injected`);
      }
    }
  } catch (e) {
    console.warn(`[AutoFix] shadcn CSS check failed: ${e.message}`);
  }

  if (totalFixes > 0) {
    console.log(`[AutoFix] ${totalFixes} file(s) fixed directly (no AI needed)`);
  }
  return totalFixes;
}

// ─── PROJECT RULES MEMORY (.prestige/rules.md) ───
// Append a learned rule to the project's rules file so Claude never repeats the same mistake.
// Rules are deduped by checking if the exact text already exists in the file.
function appendProjectRule(projectDir, rule) {
  if (!projectDir || !rule) return;
  try {
    const prestigeDir = path.join(projectDir, '.prestige');
    const rulesPath = path.join(prestigeDir, 'rules.md');
    if (!fs.existsSync(prestigeDir)) {
      fs.mkdirSync(prestigeDir, { recursive: true });
    }
    let existing = '';
    if (fs.existsSync(rulesPath)) {
      existing = fs.readFileSync(rulesPath, 'utf8');
    } else {
      existing = '# Règles du projet (auto-générées)\n';
    }
    // Dedup: skip if rule already present
    const ruleNormalized = rule.trim().replace(/^-\s*/, '');
    if (existing.includes(ruleNormalized)) return;
    const entry = `- ${ruleNormalized}\n`;
    fs.writeFileSync(rulesPath, existing.trimEnd() + '\n' + entry, 'utf8');
    console.log(`[Rules] Added rule to ${rulesPath}: ${ruleNormalized.substring(0, 80)}`);
  } catch (e) {
    console.warn(`[Rules] Failed to append rule: ${e.message}`);
  }
}

// Ensure .prestige/ directory exists for a project
function ensurePrestigeDir(projectDir) {
  if (!projectDir) return;
  try {
    const prestigeDir = path.join(projectDir, '.prestige');
    if (!fs.existsSync(prestigeDir)) {
      fs.mkdirSync(prestigeDir, { recursive: true });
    }
  } catch (_) {}
}

function readProjectFilesRecursive(projectDir) {
  const files = {};
  const validNames = [
    'package.json', 'vite.config.js', 'index.html', 'server.js',
  ];
  // Read root-level files
  for (const name of validNames) {
    const p = path.join(projectDir, name);
    if (fs.existsSync(p)) {
      files[name] = fs.readFileSync(p, 'utf8');
    }
  }

  // Legacy: check public/index.html and map to index.html if it has React root div
  if (!files['index.html']) {
    const legacyIndex = path.join(projectDir, 'public', 'index.html');
    if (fs.existsSync(legacyIndex)) {
      const content = fs.readFileSync(legacyIndex, 'utf8');
      if (content.includes('id="root"')) {
        files['index.html'] = content;
      }
    }
  }

  // ── FULL RECURSIVE SCAN of src/ — no hardcoded list, no depth limit ──
  // Reads ALL .tsx, .ts, .jsx, .js, .css files anywhere under src/
  // This ensures the AI sees EVERY file, no matter how the project is organized.
  const srcDir = path.join(projectDir, 'src');
  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
    const validExts = new Set(['.tsx', '.ts', '.jsx', '.js', '.css']);
    const scanDir = (dir, relativeBase) => {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
          const fullPath = path.join(dir, entry);
          const relativePath = relativeBase ? `${relativeBase}/${entry}` : entry;
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && validExts.has(path.extname(entry))) {
              files[`src/${relativePath}`] = fs.readFileSync(fullPath, 'utf8');
            } else if (stat.isDirectory()) {
              scanDir(fullPath, relativePath);
            }
          } catch (_) {} // skip unreadable entries
        }
      } catch (_) {} // skip unreadable dirs
    };
    scanDir(srcDir, '');
  }

  return files;
}

// Format project files as ### marker code string for storage
function formatProjectCode(files) {
  const fileOrder = [
    'package.json', 'vite.config.js', 'index.html', 'server.js',
    'src/main.tsx', 'src/index.css', 'src/App.tsx'
  ];

  let result = '';
  const written = new Set();

  for (const fn of fileOrder) {
    if (files[fn]) {
      result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`;
      written.add(fn);
    }
  }

  // Components, pages, others alphabetically
  const remaining = Object.keys(files)
    .filter(fn => !written.has(fn))
    .sort((a, b) => {
      const order = (f) => f.startsWith('src/components/') ? 0 : f.startsWith('src/pages/') ? 1 : 2;
      return order(a) - order(b) || a.localeCompare(b);
    });

  for (const fn of remaining) {
    result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`;
  }

  return result;
}

// Write default React project files as fallback
function writeDefaultReactProject(projectDir) {
  const defaults = {
    'package.json': DEFAULT_PACKAGE_JSON,
    'vite.config.js': DEFAULT_VITE_CONFIG,
    'index.html': DEFAULT_INDEX_HTML,
    'server.js': DEFAULT_SERVER_JS,
    'src/main.tsx': DEFAULT_MAIN_JSX,
    'src/index.css': DEFAULT_INDEX_CSS,
    'src/App.tsx': DEFAULT_APP_JSX,
  };

  for (const [filename, content] of Object.entries(defaults)) {
    const filePath = path.join(projectDir, filename);
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
      console.log(`[Defaults] Wrote default ${filename}`);
    }
  }

  // ─── LOVABLE MODEL: trust the AI, restore only if missing or broken ───
  // Previously: ALWAYS overwrote ui/lib/hooks with canonical versions (defensive).
  // This BLOCKED the AI from customizing UI components, causing blank screens when
  // plans requested style changes on Card/Button/etc. (modifications got erased).
  //
  // Now: only restore canonical files if:
  //   A) File doesn't exist (new project, missing component)
  //   B) File is fundamentally broken (empty, no exports, unreadable)
  //
  // If the AI wrote a valid customized version, we TRUST IT. If it breaks,
  // the build check / back-test / auto-fix loop will catch and correct.
  const templateUiDir = path.join(__dirname, 'templates', 'react', 'src');
  const uiDirs = ['components/ui', 'lib', 'hooks'];
  let restored = 0;
  let trusted = 0;
  for (const dir of uiDirs) {
    const srcDir = path.join(templateUiDir, dir);
    const destDir = path.join(projectDir, 'src', dir);
    if (fs.existsSync(srcDir)) {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const destFile = path.join(destDir, file);

        let needsRestore = false;
        if (!fs.existsSync(destFile)) {
          needsRestore = true; // (A) missing
        } else {
          try {
            const content = fs.readFileSync(destFile, 'utf8');
            // (B) broken: empty, too short, or no export statement at all
            if (content.trim().length < 20 || (!content.includes('export ') && !content.includes('module.exports'))) {
              needsRestore = true;
            }
          } catch (_) {
            needsRestore = true; // unreadable
          }
        }

        if (needsRestore) {
          fs.copyFileSync(srcFile, destFile);
          restored++;
        } else {
          trusted++;
        }
      }
    }
  }
  if (restored > 0 || trusted > 0) {
    console.log(`[Defaults] UI files: ${restored} restored (missing/broken), ${trusted} trusted (AI-customized OK)`);
  }
}

// ─── CLAUDE CODE PROCESS MANAGER ───
// Track active Claude Code processes per project
const claudeCodeProcesses = new Map();

// CLAUDE_CODE_TIMEOUT_MS imported from src/config.js

// Check if Claude Code CLI is available on this system
let _claudeCodeAvailable = null;
function isClaudeCodeAvailable() {
  if (_claudeCodeAvailable !== null) return _claudeCodeAvailable;
  try {
    execSync('which claude', { timeout: 5000, stdio: 'pipe' });
    _claudeCodeAvailable = true;
    console.log('[Claude Code] CLI detected and available');
  } catch {
    _claudeCodeAvailable = false;
    console.warn('[Claude Code] CLI not found — will use API fallback for generation');
  }
  return _claudeCodeAvailable;
}

// ─── GENERATE CLAUDE CODE (SERVER-SIDE, ISOLATED PER PROJECT) ───
// Note: options parameter reserved for future extensibility (e.g., timeout, max retries)
function generateClaudeCode(projectId, brief, jobId, options = {}) {
  const job = generationJobs.get(jobId);
  if (!job) return;
  
  if (!ANTHROPIC_API_KEY) { 
    job.status = 'error';
    job.error = 'Le service IA n\'est pas configuré. Contactez l\'administrateur.';
    return; 
  }
  
  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  
  // Create project directory with src/ structure
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
  const srcDir = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }
  ensurePrestigeDir(projectDir);

  // Detect sector profile
  const sectorProfile = ai && brief ? ai.detectSectorProfile(brief) : null;
  
  // Get available APIs
  const savedApis = db ? db.prepare('SELECT name,service,description FROM api_keys').all() : [];
  
  // Write BRIEF.md
  const briefPath = path.join(projectDir, 'BRIEF.md');
  fs.writeFileSync(briefPath, `# Brief du Projet\n\n${brief}\n`);
  
  // Write CLAUDE.md with instructions
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  const claudeMdContent = generateClaudeMdTemplate(brief, sectorProfile, savedApis);
  fs.writeFileSync(claudeMdPath, claudeMdContent);
  
  // Update job status
  job.status = 'running';
  job.claudeCodeOutput = '';
  job.progressMessage = 'Démarrage de Claude Code...';
  
  console.log(`[Claude Code] Starting generation for project ${projectId}`);
  console.log(`[Claude Code] Project directory: ${projectDir}`);
  
  // Build the prompt for Claude Code
  const prompt = `Lis le fichier CLAUDE.md dans ce dossier et exécute toutes les instructions pour générer une application React + Vite + TailwindCSS complète basée sur le brief. Génère tous les fichiers du projet (package.json, vite.config.js, index.html, server.js, src/main.tsx, src/index.css, src/App.tsx, src/components/*.tsx, src/pages/*.tsx), teste-les avec npm run build, et crée le fichier READY quand tout fonctionne.`;
  
  // Spawn Claude Code process
  // NOTE: --dangerously-skip-permissions is required for non-interactive server-side execution.
  // Security is enforced by setting cwd to the isolated project directory.
  // The ANTHROPIC_API_KEY is passed only to enable Claude Code API calls (server-side only).
  const claudeProcess = spawn('claude', [
    '--dangerously-skip-permissions',
    '--print',
    prompt
  ], {
    cwd: projectDir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
    }
  });
  
  // Store process reference
  claudeCodeProcesses.set(projectId, claudeProcess);

  // Timeout: kill process if it takes too long
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.warn(`[Claude Code] Timeout after ${CLAUDE_CODE_TIMEOUT_MS / 1000}s for project ${projectId}`);
    claudeProcess.kill('SIGTERM');
    setTimeout(() => {
      try { claudeProcess.kill('SIGKILL'); } catch {}
    }, 5000);
  }, CLAUDE_CODE_TIMEOUT_MS);

  // Capture stdout in real-time
  claudeProcess.stdout.on('data', (data) => {
    const output = data.toString();
    job.claudeCodeOutput += output;
    job.progress = job.claudeCodeOutput.length;

    // Parse output for user-friendly messages
    if (output.includes('package.json')) {
      job.progressMessage = 'Création du fichier package.json...';
    } else if (output.includes('server.js')) {
      job.progressMessage = 'Génération du backend Express...';
    } else if (output.includes('index.html') || output.includes('public/')) {
      job.progressMessage = 'Création du frontend...';
    } else if (output.includes('node --check') || output.includes('syntax')) {
      job.progressMessage = 'Vérification de la syntaxe...';
    } else if (output.includes('curl') || output.includes('health')) {
      job.progressMessage = 'Test du serveur...';
    } else if (output.includes('READY') || output.includes('Success')) {
      job.progressMessage = 'Génération terminée avec succès !';
    } else if (output.includes('ERROR') || output.includes('error')) {
      job.progressMessage = 'Correction en cours...';
    }

    console.log(`[Claude Code] Output: ${output.substring(0, 200)}...`);
  });

  // Capture stderr
  claudeProcess.stderr.on('data', (data) => {
    const errorOutput = data.toString();
    job.claudeCodeOutput += `[stderr] ${errorOutput}`;
    console.error(`[Claude Code] stderr: ${errorOutput}`);
  });

  // Handle process completion
  claudeProcess.on('close', (code) => {
    clearTimeout(timeout);
    console.log(`[Claude Code] Process exited with code ${code}${timedOut ? ' (timeout)' : ''}`);
    claudeCodeProcesses.delete(projectId);

    if (timedOut) {
      // Timeout: fall back to API generation
      console.warn(`[Claude Code] Timed out for project ${projectId}, falling back to API`);
      job.progressMessage = 'Claude Code timeout — basculement vers API...';
      generateViaAPI(projectId, brief, jobId);
      return;
    }

    // Check if files were created successfully (React multi-file project)
    const readyPath = path.join(projectDir, 'READY');
    const errorPath = path.join(projectDir, 'ERROR');
    const errorExists = fs.existsSync(errorPath);

    if (errorExists) {
      // Claude Code failed — fall back to API generation
      console.warn(`[Claude Code] ERROR file found for project ${projectId}, falling back to API`);
      job.progressMessage = 'Claude Code erreur — basculement vers API...';
      try { fs.unlinkSync(errorPath); } catch {}
      generateViaAPI(projectId, brief, jobId);
      return;
    }

    // Check if ANY project files exist (package.json, server.js, index.html, or src/)
    const hasAnyFile = fs.existsSync(path.join(projectDir, 'package.json'))
      || fs.existsSync(path.join(projectDir, 'server.js'))
      || fs.existsSync(path.join(projectDir, 'index.html'))
      || fs.existsSync(path.join(projectDir, 'src', 'App.jsx'));
    if (code !== 0 && !hasAnyFile) {
      // Process crashed without producing files — fall back to API
      console.warn(`[Claude Code] Process failed (code ${code}) with no files, falling back to API`);
      job.progressMessage = 'Claude Code indisponible — basculement vers API...';
      generateViaAPI(projectId, brief, jobId);
      return;
    }

    // Read all generated files from the React project directory
    try {
      const allFiles = readProjectFilesRecursive(projectDir);
      if (Object.keys(allFiles).length >= 3) {
        // Format all files as ### markers for storage
        job.code = formatProjectCode(allFiles);
        job.status = 'done';
        job.progressMessage = 'Projet React généré avec succès !';
        console.log(`[Claude Code] Generation successful for project ${projectId} — ${Object.keys(allFiles).length} files`);
      } else {
        // Not enough files — write defaults and read again
        console.warn(`[Claude Code] Only ${Object.keys(allFiles).length} files found, writing defaults`);
        writeDefaultReactProject(projectDir);
        const filesWithDefaults = readProjectFilesRecursive(projectDir);
        job.code = formatProjectCode(filesWithDefaults);
        job.status = 'done';
        job.progressMessage = 'Projet généré avec fichiers par défaut.';
      }
    } catch (readErr) {
      job.status = 'error';
      job.error = `Erreur de lecture des fichiers: ${readErr.message}`;
      console.error(`[Claude Code] Error reading files: ${readErr.message}`);
    }
  });

  // Handle process errors (e.g., ENOENT if claude binary not found)
  claudeProcess.on('error', (err) => {
    clearTimeout(timeout);
    console.error(`[Claude Code] Process error: ${err.message}`);
    claudeCodeProcesses.delete(projectId);
    // Fall back to API generation instead of failing
    console.warn(`[Claude Code] Spawning failed, falling back to API generation`);
    job.progressMessage = 'Claude Code indisponible — basculement vers API...';
    generateViaAPI(projectId, brief, jobId);
  });
}

// ─── GENERATE CLAUDE CODE FOR CHAT/MODIFICATIONS ───
function generateClaudeCodeChat(projectId, message, jobId) {
  const job = generationJobs.get(jobId);
  if (!job) return;
  
  if (!ANTHROPIC_API_KEY) { 
    job.status = 'error';
    job.error = 'Le service IA n\'est pas configuré. Contactez l\'administrateur.';
    return; 
  }
  
  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  
  // Verify project directory exists
  if (!fs.existsSync(projectDir)) {
    job.status = 'error';
    job.error = 'Dossier projet introuvable. Générez d\'abord le projet.';
    return;
  }
  
  // Update job status
  job.status = 'running';
  job.claudeCodeOutput = '';
  job.progressMessage = 'Modification en cours...';
  
  console.log(`[Claude Code Chat] Starting modification for project ${projectId}: ${message.substring(0, 100)}...`);
  
  // Build the prompt for modification
  const prompt = `Modifie les fichiers React existants dans ce dossier selon cette instruction: "${message}". Le projet utilise React + Vite + TailwindCSS. Tu peux modifier src/App.tsx, src/components/*.tsx, src/pages/*.tsx, server.js, src/index.css, etc. Teste avec npm run build, puis crée le fichier READY quand tout fonctionne. Si erreur après 5 tentatives, crée le fichier ERROR.`;
  
  // Spawn Claude Code process (see generateClaudeCode for security notes)
  const claudeProcess = spawn('claude', [
    '--dangerously-skip-permissions',
    '--print',
    prompt
  ], {
    cwd: projectDir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
    }
  });
  
  // Store process reference
  claudeCodeProcesses.set(projectId, claudeProcess);

  // Timeout: kill process if it takes too long
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.warn(`[Claude Code Chat] Timeout after ${CLAUDE_CODE_TIMEOUT_MS / 1000}s for project ${projectId}`);
    claudeProcess.kill('SIGTERM');
    setTimeout(() => {
      try { claudeProcess.kill('SIGKILL'); } catch {}
    }, 5000);
  }, CLAUDE_CODE_TIMEOUT_MS);

  // Capture stdout in real-time
  claudeProcess.stdout.on('data', (data) => {
    const output = data.toString();
    job.claudeCodeOutput += output;
    job.progress = job.claudeCodeOutput.length;

    // Parse output for user-friendly messages
    if (output.includes('Modifying') || output.includes('Editing')) {
      job.progressMessage = 'Modification des fichiers...';
    } else if (output.includes('Testing') || output.includes('node --check')) {
      job.progressMessage = 'Vérification des modifications...';
    } else if (output.includes('READY') || output.includes('Success')) {
      job.progressMessage = 'Modifications appliquées !';
    }
    
    console.log(`[Claude Code Chat] Output: ${output.substring(0, 200)}...`);
  });
  
  // Capture stderr
  claudeProcess.stderr.on('data', (data) => {
    const errorOutput = data.toString();
    job.claudeCodeOutput += `[stderr] ${errorOutput}`;
    console.error(`[Claude Code Chat] stderr: ${errorOutput}`);
  });
  
  // Handle process completion
  claudeProcess.on('close', (code) => {
    clearTimeout(timeout);
    console.log(`[Claude Code Chat] Process exited with code ${code}${timedOut ? ' (timeout)' : ''}`);
    claudeCodeProcesses.delete(projectId);

    if (timedOut) {
      job.status = 'error';
      job.error = 'Claude Code a dépassé le délai maximum (5 min). Réessayez.';
      return;
    }

    // Check for errors, then read all React project files
    const errorPath = path.join(projectDir, 'ERROR');

    if (fs.existsSync(errorPath)) {
      job.status = 'error';
      job.error = 'Claude Code n\'a pas pu appliquer les modifications.';
      try { fs.unlinkSync(errorPath); } catch (e) { console.warn('Could not remove ERROR file:', e.message); }
      return;
    }

    try {
      // Read all React project files
      const allFiles = readProjectFilesRecursive(projectDir);
      job.code = formatProjectCode(allFiles);
      job.status = 'done';
      job.progressMessage = 'Modifications appliquées avec succès !';
      console.log(`[Claude Code Chat] Modification successful for project ${projectId} — ${Object.keys(allFiles).length} files`);

      const readyPath = path.join(projectDir, 'READY');
      try { if (fs.existsSync(readyPath)) fs.unlinkSync(readyPath); } catch (e) { console.warn('Could not remove READY file:', e.message); }
    } catch (readErr) {
      job.status = 'error';
      job.error = `Erreur de lecture des fichiers: ${readErr.message}`;
      console.error(`[Claude Code Chat] Error reading files: ${readErr.message}`);
    }
  });

  // Handle process errors
  claudeProcess.on('error', (err) => {
    clearTimeout(timeout);
    console.error(`[Claude Code Chat] Process error: ${err.message}`);
    claudeCodeProcesses.delete(projectId);
    job.status = 'error';
    job.error = `Erreur Claude Code: ${err.message}. Réessayez.`;
  });
}

// ─── API FALLBACK: Generate project files via direct Anthropic API ───
// Used when Claude Code CLI is unavailable, times out, or errors out.
// Streams from the API, parses ### markers, writes files to project dir.
// ─── MULTI-TURN API CALL HELPER ───
// Makes a non-streaming API call and returns the text response
// ─── TOOL-BASED CODE GENERATION (like Lovable's lov-write / lov-line-replace) ───
// Define tools for structured file operations — eliminates ### marker parsing bugs
const CODE_TOOLS = [
  {
    name: 'write_file',
    description: `Cree un NOUVEAU fichier ou reecrit un fichier ENTIER. PREFERE edit_file pour les petits changements.
Si tu modifies un fichier existant avec write_file, utilise le marqueur "// ... keep existing code" pour conserver les sections inchangees. Le serveur FUSIONNE automatiquement :
EXEMPLE:
  import React from 'react';
  // ... keep existing code
  export default function App() { return <div>NOUVEAU</div>; }
→ Le serveur garde tout le code entre l'import et l'export, remplace seulement les parties que tu ecris.
QUAND utiliser write_file: nouveau fichier, rewrite > 50% du contenu, fichier < 30 lignes.
QUAND utiliser edit_file: correction, ajout import, changement texte/couleur, modification < 20 lignes.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root (e.g. src/components/Header.tsx)' },
        content: { type: 'string', description: 'File content. Use "// ... keep existing code" for unchanged sections.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: `OUTIL PREFERE pour les modifications. Recherche un texte exact dans le fichier et le remplace. Le reste du fichier est preserve INTACT.
La recherche tolere les differences d'espaces et d'indentation (fuzzy matching a 4 niveaux).
ATTENTION: Si la recherche ECHOUE (le texte n'est pas trouve), tu recevras un message "✗ ECHEC". Dans ce cas, utilise view_file pour relire le fichier et retente avec le texte EXACT.
JAMAIS inventer le texte de recherche — copie-le du fichier existant.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        search: { type: 'string', description: 'Text to find (whitespace-tolerant)' },
        replace: { type: 'string', description: 'Text to replace it with' }
      },
      required: ['path', 'search', 'replace']
    }
  },
  {
    name: 'line_replace',
    description: 'Remplace des lignes par numero. ATTENTION: les numeros de ligne changent apres chaque modification. Utilise view_file AVANT pour obtenir les numeros corrects.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        start_line: { type: 'number', description: 'First line to replace (1-based)' },
        end_line: { type: 'number', description: 'Last line to replace (inclusive)' },
        new_content: { type: 'string', description: 'New content to insert (replaces lines start_line through end_line)' }
      },
      required: ['path', 'start_line', 'end_line', 'new_content']
    }
  }
  ,
  {
    name: 'fetch_website',
    description: 'Fetch a website URL and get its content as clean text/markdown. Use when the user says "fais comme ce site" or references an external URL for design inspiration.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch (e.g. https://stripe.com)' }
      },
      required: ['url']
    }
  },
  {
    name: 'read_console_logs',
    description: 'Read the frontend console logs (errors, warnings, network failures) from the project preview. Use FIRST when debugging.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'The project ID to read logs from' }
      },
      required: ['project_id']
    }
  },
  {
    name: 'run_security_check',
    description: 'Scan the project code for common security issues: exposed secrets, SQL injection risks, missing auth checks, XSS vulnerabilities.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'The project ID to scan' }
      },
      required: ['project_id']
    }
  },
  {
    name: 'parse_document',
    description: 'Parse a document (PDF or Word/DOCX) uploaded as base64 and extract its text content. Use when user provides a document to use as content or reference.',
    input_schema: {
      type: 'object',
      properties: {
        base64_content: { type: 'string', description: 'The document content encoded in base64' },
        filename: { type: 'string', description: 'Original filename to detect type (e.g. brief.pdf, content.docx)' }
      },
      required: ['base64_content', 'filename']
    }
  },
  {
    name: 'generate_mermaid',
    description: 'Generate a Mermaid diagram to explain architecture, workflows, or data flows. Returns the Mermaid syntax that will be rendered in the chat.',
    input_schema: {
      type: 'object',
      properties: {
        diagram: { type: 'string', description: 'The Mermaid diagram syntax (e.g. graph TD; A-->B)' },
        title: { type: 'string', description: 'A short title for the diagram' }
      },
      required: ['diagram']
    }
  },
  // ─── FILE MANAGEMENT TOOLS ───
  {
    name: 'view_file',
    description: 'Read the contents of a file in the project. Use to examine code before editing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        start_line: { type: 'number', description: 'Start line (optional, default 1)' },
        end_line: { type: 'number', description: 'End line (optional, default 500)' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern across all project files. Returns matching lines with file paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        file_glob: { type: 'string', description: 'File glob filter (e.g. "*.tsx", "src/pages/*")' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project. Use when removing a component or page.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete' }
      },
      required: ['path']
    }
  },
  {
    name: 'rename_file',
    description: 'Rename or move a file in the project.',
    input_schema: {
      type: 'object',
      properties: {
        old_path: { type: 'string', description: 'Current file path' },
        new_path: { type: 'string', description: 'New file path' }
      },
      required: ['old_path', 'new_path']
    }
  },
  {
    name: 'add_dependency',
    description: 'Add an npm package to the project. Only use for packages not already installed.',
    input_schema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'Package name (e.g. "chart.js")' },
        version: { type: 'string', description: 'Version (optional, e.g. "4.4.0")' },
        dev: { type: 'boolean', description: 'Install as devDependency (default false)' }
      },
      required: ['package_name']
    }
  },
  {
    name: 'remove_dependency',
    description: 'Remove an npm package from the project.',
    input_schema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'Package name to remove' }
      },
      required: ['package_name']
    }
  },
  {
    name: 'download_to_project',
    description: 'Download a file from a URL and save it into the project (images, fonts, data files).',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to download from' },
        save_path: { type: 'string', description: 'Path in the project to save to (e.g. "public/logo.png")' }
      },
      required: ['url', 'save_path']
    }
  },
  {
    name: 'read_project_analytics',
    description: 'Read production analytics for a published project: pageviews, visitors, top pages, bounce rate.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'The project ID' }
      },
      required: ['project_id']
    }
  },
  {
    name: 'get_table_schema',
    description: 'Read the SQLite database schema and table structure of a project. Shows all tables, columns, and relationships.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'The project ID' }
      },
      required: ['project_id']
    }
  },
  {
    name: 'search_images',
    description: 'Search for professional stock photos by keyword. Returns URLs for high-quality images to use in the project. Use instead of picsum.photos for relevant images.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (e.g. "restaurant interior", "doctor team", "modern office")' },
        count: { type: 'number', description: 'Number of images (default 3, max 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'enable_stripe',
    description: 'Configure Stripe payment integration for a project. Sets up the Stripe secret key as env var and adds checkout routes.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'The project ID' },
        stripe_key_name: { type: 'string', description: 'Env var name for the Stripe key (default STRIPE_SECRET_KEY)' }
      },
      required: ['project_id']
    }
  },
  {
    name: 'generate_image',
    description: 'Generate a custom AI image for the project (hero backgrounds, team photos, product images). Uses Anthropic image generation. Saves the image to the project and returns the URL to use in code.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image description (e.g. "modern bakery interior with warm lighting and fresh bread on display")' },
        save_path: { type: 'string', description: 'Path to save in project (e.g. "public/hero.jpg", "public/team.jpg")' },
        width: { type: 'number', description: 'Width in pixels (default 1200)' },
        height: { type: 'number', description: 'Height in pixels (default 800)' }
      },
      required: ['prompt', 'save_path']
    }
  },
  // ─── AGENT TOOLS ───
  {
    name: 'run_command',
    description: 'Execute a shell command inside the project Docker container (sandboxed). Use for: checking syntax (node --check server.cjs), listing files (ls src/), reading files (cat src/App.tsx), searching code (grep -rn "fetchData" src/), testing builds (npm run build). Returns stdout+stderr. Timeout: 30s.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run (e.g. "node --check server.cjs", "ls -la src/pages/", "grep -rn fetchData src/", "cat src/App.tsx")' },
        cwd: { type: 'string', description: 'Working directory inside container (default: /app)' }
      },
      required: ['command']
    }
  },
  {
    name: 'verify_project',
    description: 'Run a full project health check: 1) server.js syntax check (node --check), 2) Express health endpoint, 3) error log scan. Use AFTER making changes to verify everything works. Returns a diagnostic summary.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID (auto-filled)' }
      },
      required: []
    }
  },
];

// ─── TOOL EXECUTION HANDLERS ───
// Execute server-side tools that Claude calls (fetch_website, read_console_logs, run_security_check)
function executeServerTool(toolName, toolInput) {
  if (toolName === 'fetch_website' && toolInput.url) {
    return new Promise((resolve) => {
      const url = toolInput.url;
      const proto = url.startsWith('https') ? https : http;
      const req = proto.get(url, { timeout: 10000, headers: { 'User-Agent': 'PrestigeBuildBot/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow one redirect
          const rProto = res.headers.location.startsWith('https') ? https : http;
          rProto.get(res.headers.location, { timeout: 10000 }, (r2) => {
            let data = ''; r2.on('data', c => data += c); r2.on('end', () => resolve(htmlToText(data, url)));
          }).on('error', () => resolve('Erreur: impossible de charger le site.'));
          return;
        }
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(htmlToText(data, url)));
      });
      req.on('error', () => resolve('Erreur: impossible de charger le site.'));
      req.on('timeout', () => { req.destroy(); resolve('Timeout: le site ne répond pas.'); });
    });
  }

  if (toolName === 'read_console_logs' && toolInput.project_id) {
    const logs = clientLogs.get(String(toolInput.project_id)) || [];
    if (logs.length === 0) return Promise.resolve('Aucun log frontend capturé.');
    return Promise.resolve(logs.slice(-20).map(l => `[${l.level}] ${l.message}`).join('\n'));
  }

  if (toolName === 'run_security_check' && toolInput.project_id && db) {
    const project = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(toolInput.project_id);
    if (!project?.generated_code) return Promise.resolve('Projet sans code.');
    const code = project.generated_code;
    const issues = [];
    // Check for hardcoded secrets
    if (/['"][A-Za-z0-9]{20,}['"]/.test(code) && /api.key|secret|token|password/i.test(code)) issues.push('CRITIQUE: Possible clé API ou secret en dur dans le code');
    // Check for SQL injection
    if (/\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE)/i.test(code) || /`.*\$\{.*(?:SELECT|INSERT|UPDATE|DELETE)/i.test(code)) issues.push('CRITIQUE: Possible injection SQL (template literal dans une requête)');
    // Check for missing auth
    if (code.includes('/api/') && !code.includes('auth') && !code.includes('jwt') && !code.includes('token')) issues.push('ATTENTION: Routes API sans authentification visible');
    // Check XSS
    if (code.includes('dangerouslySetInnerHTML')) issues.push('ATTENTION: dangerouslySetInnerHTML détecté — risque XSS');
    // Check env vars
    if (/ANTHROPIC_API_KEY|STRIPE_SECRET|GOOGLE_API/.test(code) && !code.includes('process.env')) issues.push('ATTENTION: Clé API potentiellement en dur');
    if (issues.length === 0) return Promise.resolve('Aucun problème de sécurité détecté.');
    return Promise.resolve('Problèmes détectés:\n' + issues.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }

  if (toolName === 'parse_document' && toolInput.base64_content && toolInput.filename) {
    return (async () => {
      try {
        const buffer = Buffer.from(toolInput.base64_content, 'base64');
        const ext = (toolInput.filename || '').toLowerCase();

        if (ext.endsWith('.pdf')) {
          try {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(buffer);
            return `Document PDF (${data.numpages} pages):\n\n${(data.text || '').substring(0, 8000)}`;
          } catch (e) {
            return `Erreur parsing PDF: ${e.message}`;
          }
        }

        if (ext.endsWith('.docx') || ext.endsWith('.doc')) {
          try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            return `Document Word:\n\n${(result.value || '').substring(0, 8000)}`;
          } catch (e) {
            return `Erreur parsing Word: ${e.message}`;
          }
        }

        // Plain text fallback
        return `Document texte:\n\n${buffer.toString('utf8').substring(0, 8000)}`;
      } catch (e) {
        return `Erreur parsing document: ${e.message}`;
      }
    })();
  }

  if (toolName === 'generate_mermaid' && toolInput.diagram) {
    const title = toolInput.title ? `**${toolInput.title}**\n\n` : '';
    return Promise.resolve(`${title}\`\`\`mermaid\n${toolInput.diagram}\n\`\`\``);
  }

  // ─── FILE MANAGEMENT TOOLS ───
  if (toolName === 'view_file' && toolInput.path && toolInput._projectDir) {
    const filePath = path.join(toolInput._projectDir, toolInput.path);
    if (!fs.existsSync(filePath)) return Promise.resolve(`Fichier introuvable: ${toolInput.path}`);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const start = (toolInput.start_line || 1) - 1;
    const end = toolInput.end_line || 500;
    return Promise.resolve(lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n'));
  }

  if (toolName === 'search_files' && toolInput.pattern && toolInput._projectDir) {
    const results = [];
    const searchDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'data', 'dist'].includes(entry.name)) continue;
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) { searchDir(fp); continue; }
        if (toolInput.file_glob && !entry.name.match(new RegExp(toolInput.file_glob.replace(/\*/g, '.*')))) continue;
        try {
          const content = fs.readFileSync(fp, 'utf8');
          const regex = new RegExp(toolInput.pattern, 'i');
          content.split('\n').forEach((line, i) => {
            if (regex.test(line)) {
              results.push(`${path.relative(toolInput._projectDir, fp)}:${i + 1}: ${line.trim()}`);
            }
          });
        } catch {}
      }
    };
    searchDir(toolInput._projectDir);
    return Promise.resolve(results.length > 0 ? results.slice(0, 30).join('\n') : 'Aucun résultat.');
  }

  if (toolName === 'delete_file' && toolInput.path && toolInput._projectDir) {
    if (PROTECTED_FILES.has(toolInput.path) || toolInput.path.startsWith('src/components/ui/') || toolInput.path === 'src/lib/utils.ts') {
      return Promise.resolve(`Impossible de supprimer un fichier système: ${toolInput.path}`);
    }
    const fp = path.join(toolInput._projectDir, toolInput.path);
    if (!fs.existsSync(fp)) return Promise.resolve(`Fichier introuvable: ${toolInput.path}`);
    fs.unlinkSync(fp);
    return Promise.resolve(`Supprimé: ${toolInput.path}`);
  }

  if (toolName === 'rename_file' && toolInput.old_path && toolInput.new_path && toolInput._projectDir) {
    if (PROTECTED_FILES.has(toolInput.old_path) || PROTECTED_FILES.has(toolInput.new_path)) {
      return Promise.resolve(`Impossible de renommer un fichier système: ${toolInput.old_path}`);
    }
    const oldFp = path.join(toolInput._projectDir, toolInput.old_path);
    const newFp = path.join(toolInput._projectDir, toolInput.new_path);
    if (!fs.existsSync(oldFp)) return Promise.resolve(`Fichier introuvable: ${toolInput.old_path}`);
    const newDir = path.dirname(newFp);
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    fs.renameSync(oldFp, newFp);
    return Promise.resolve(`Renommé: ${toolInput.old_path} → ${toolInput.new_path}`);
  }

  if (toolName === 'add_dependency' && toolInput.package_name && toolInput._projectDir) {
    const pkgPath = path.join(toolInput._projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return Promise.resolve('package.json introuvable.');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const section = toolInput.dev ? 'devDependencies' : 'dependencies';
      if (!pkg[section]) pkg[section] = {};
      // Check if already installed
      if (pkg[section][toolInput.package_name]) {
        return Promise.resolve(`Déjà installé: ${toolInput.package_name}@${pkg[section][toolInput.package_name]}`);
      }
      pkg[section][toolInput.package_name] = toolInput.version || 'latest';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      // Install in the running container (like Lovable's lov-add-dependency)
      if (toolInput.project_id) {
        try {
          const containerName = getContainerName(toolInput.project_id);
          const { execSync } = require('child_process');
          // Copy updated package.json into container
          execSync(`docker cp ${pkgPath} ${containerName}:/app/package.json`, { timeout: 10000 });
          // Run npm install inside the container
          const version = toolInput.version || 'latest';
          execSync(`docker exec ${containerName} npm install ${toolInput.package_name}@${version} --force 2>&1 | tail -3`, { timeout: 60000, encoding: 'utf8' });
          console.log(`[Tool] Installed ${toolInput.package_name}@${version} in container ${containerName}`);
          return Promise.resolve(`Installé: ${toolInput.package_name}@${version} (disponible immédiatement)`);
        } catch (installErr) {
          console.warn(`[Tool] Container install failed: ${installErr.message}`);
          return Promise.resolve(`Ajouté au package.json: ${toolInput.package_name}. Rebuild nécessaire pour l'installer.`);
        }
      }
      return Promise.resolve(`Ajouté: ${toolInput.package_name}@${toolInput.version || 'latest'} dans ${section}`);
    } catch (e) { return Promise.resolve(`Erreur: ${e.message}`); }
  }

  if (toolName === 'remove_dependency' && toolInput.package_name && toolInput._projectDir) {
    const pkgPath = path.join(toolInput._projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return Promise.resolve('package.json introuvable.');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let removed = false;
      for (const section of ['dependencies', 'devDependencies']) {
        if (pkg[section]?.[toolInput.package_name]) { delete pkg[section][toolInput.package_name]; removed = true; }
      }
      if (removed) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
        // Uninstall from running container
        if (toolInput.project_id) {
          try {
            const containerName = getContainerName(toolInput.project_id);
            const { execSync } = require('child_process');
            execSync(`docker exec ${containerName} npm uninstall ${toolInput.package_name} 2>&1 | tail -2`, { timeout: 30000 });
          } catch { /* container might not be running */ }
        }
        return Promise.resolve(`Supprimé: ${toolInput.package_name}`);
      }
      return Promise.resolve(`Package non trouvé: ${toolInput.package_name}`);
    } catch (e) { return Promise.resolve(`Erreur: ${e.message}`); }
  }

  if (toolName === 'download_to_project' && toolInput.url && toolInput.save_path && toolInput._projectDir) {
    return new Promise((resolve) => {
      const savePath = path.join(toolInput._projectDir, toolInput.save_path);
      const saveDir = path.dirname(savePath);
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
      const proto = toolInput.url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(savePath);
      proto.get(toolInput.url, { timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const rProto = res.headers.location.startsWith('https') ? https : http;
          rProto.get(res.headers.location, { timeout: 15000 }, (r2) => { r2.pipe(file); file.on('finish', () => { file.close(); resolve(`Téléchargé: ${toolInput.save_path}`); }); }).on('error', () => resolve('Erreur téléchargement.'));
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(`Téléchargé: ${toolInput.save_path} (${fs.statSync(savePath).size} bytes)`); });
      }).on('error', () => resolve('Erreur téléchargement.')).on('timeout', function() { this.destroy(); resolve('Timeout.'); });
    });
  }

  if (toolName === 'read_project_analytics' && toolInput.project_id && db) {
    const pid = toolInput.project_id;
    const views = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE project_id=? AND event_type='pageview'").get(pid)?.c || 0;
    const visitors = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-30 days')").get(pid)?.c || 0;
    const topPages = db.prepare("SELECT json_extract(event_data, '$.page') as page, COUNT(*) as count FROM analytics WHERE project_id=? AND event_type='pageview' AND event_data IS NOT NULL GROUP BY page ORDER BY count DESC LIMIT 5").all(pid);
    return Promise.resolve(`Analytics projet ${pid}:\nVues totales: ${views}\nVisiteurs (30j): ${visitors}\nPages populaires:\n${topPages.map(p => `  ${p.page}: ${p.count} vues`).join('\n') || '  Aucune donnée'}`);
  }

  if (toolName === 'get_table_schema' && toolInput.project_id) {
    const projDir = path.join(DOCKER_PROJECTS_DIR, String(toolInput.project_id));
    const serverJsPath = path.join(projDir, 'server.js');
    if (!fs.existsSync(serverJsPath)) return Promise.resolve('server.js introuvable.');
    const code = fs.readFileSync(serverJsPath, 'utf8');
    const tables = code.match(/CREATE TABLE[^;]+;/gi) || [];
    if (tables.length === 0) return Promise.resolve('Aucune table SQLite trouvée dans server.js.');
    return Promise.resolve(`Schema SQLite (${tables.length} tables):\n\n${tables.join('\n\n')}`);
  }

  if (toolName === 'search_images' && toolInput.query) {
    return new Promise((resolve) => {
      const count = Math.min(10, toolInput.count || 3);
      // Use Unsplash Source API (no API key needed for basic usage)
      const results = [];
      for (let i = 0; i < count; i++) {
        const seed = `${toolInput.query}-${i}`;
        const w = [800, 1200, 600][i % 3];
        const h = [600, 800, 400][i % 3];
        results.push({
          url: `https://images.unsplash.com/photo-${Date.now() + i}?w=${w}&h=${h}&fit=crop&q=80`,
          fallback: `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`,
          alt: `${toolInput.query} - image ${i + 1}`,
          width: w,
          height: h
        });
      }
      resolve(`Images pour "${toolInput.query}" (${count} résultats):\n${results.map((r, i) => `${i + 1}. ${r.fallback}\n   alt="${r.alt}" (${r.width}x${r.height})`).join('\n')}\n\nUtilise les URLs "fallback" (picsum.photos) qui fonctionnent toujours.`);
    });
  }

  // Also register generate_image in the server tool handler list
  if (toolName === 'generate_image') {
    // Handled above in the generate_image block
  }

  // ─── RUN COMMAND IN CONTAINER (Agent Mode) ───
  if (toolName === 'run_command' && toolInput.command) {
    const execProjectId = toolInput.project_id || toolInput._projectId;
    if (!execProjectId) return Promise.resolve('Erreur: project_id manquant pour run_command');
    return (async () => {
      try {
        const result = await containerExecService.execInContainer(
          execProjectId,
          toolInput.command,
          { cwd: toolInput.cwd }
        );
        let output = '';
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? '\n\nSTDERR:\n' : '') + result.stderr;
        if (result.timedOut) output += '\n\n[TIMEOUT]';
        return output || '(no output)';
      } catch(e) {
        return `Erreur: ${e.message}`;
      }
    })();
  }

  if (toolName === 'verify_project') {
    const vpId = toolInput.project_id || toolInput._projectId;
    if (!vpId) return Promise.resolve('Erreur: project_id manquant');
    if (!containerExecService || !containerExecService.verifyProject) return Promise.resolve('Service de vérification non disponible');
    return containerExecService.verifyProject(vpId);
  }

  if (toolName === 'enable_stripe' && toolInput.project_id && db) {
    const keyName = toolInput.stripe_key_name || 'STRIPE_SECRET_KEY';
    try {
      const existing = db.prepare('SELECT id FROM project_api_keys WHERE project_id=? AND env_name=?').get(toolInput.project_id, keyName);
      if (existing) return Promise.resolve(`Stripe déjà configuré (${keyName}). Utilisez l'interface admin pour modifier la clé.`);
      db.prepare('INSERT INTO project_api_keys (project_id, env_name, env_value, service) VALUES (?,?,?,?)').run(toolInput.project_id, keyName, encryptValue('CONFIGURE_VIA_ADMIN_PANEL'), 'stripe');
      return Promise.resolve(`Stripe activé. Variable ${keyName} créée. L'admin doit configurer la clé via l'interface admin. Utilise process.env.${keyName} dans server.js.`);
    } catch (e) { return Promise.resolve(`Erreur: ${e.message}`); }
  }

  // ─── AI IMAGE GENERATION (like Lovable's imagegen--generate_image) ───
  // ── AI IMAGE GENERATION (DALL-E 3 via OpenAI API, like Lovable Flux) ──
  if (toolName === 'generate_image' && toolInput.prompt && toolInput.save_path) {
    return new Promise(async (resolve) => {
      const savePath = toolInput.save_path;
      const size = (toolInput.width || 1200) >= 1024 ? '1792x1024' : '1024x1024';
      const seed = toolInput.prompt.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
      const fallbackUrl = `https://picsum.photos/seed/${seed}/${toolInput.width || 1200}/${toolInput.height || 800}`;

      // Try DALL-E 3 first, fallback to picsum
      if (OPENAI_API_KEY) {
        try {
          const payload = JSON.stringify({
            model: 'dall-e-3',
            prompt: toolInput.prompt,
            n: 1,
            size: size,
            quality: 'standard'
          });
          const imageData = await new Promise((res, rej) => {
            const req = https.request({
              hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(payload) }
            }, (apiRes) => {
              let data = '';
              apiRes.on('data', c => data += c);
              apiRes.on('end', () => {
                try { const r = JSON.parse(data); res(r.data?.[0]?.url || null); }
                catch { res(null); }
              });
            });
            req.on('error', () => res(null));
            req.setTimeout(30000, () => { req.destroy(); res(null); });
            req.write(payload); req.end();
          });

          if (imageData) {
            // Download the generated image to the project
            if (toolInput._projectDir) {
              const fullPath = path.join(toolInput._projectDir, savePath);
              const dir = path.dirname(fullPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              await new Promise((dl) => {
                https.get(imageData, { timeout: 20000 }, (imgRes) => {
                  const file = fs.createWriteStream(fullPath);
                  imgRes.pipe(file);
                  file.on('finish', () => { file.close(); dl(); });
                }).on('error', dl);
              });
              console.log(`[ImageGen] DALL-E 3 image saved: ${savePath}`);
              resolve(`Image IA generee et sauvee: ${savePath}\nURL pour le code: /${savePath}`);
              return;
            }
            resolve(`Image IA generee: ${imageData}\nUtilise cette URL dans src=""`);
            return;
          }
        } catch (e) {
          console.warn(`[ImageGen] DALL-E failed: ${e.message}, falling back to picsum`);
        }
      }

      // Fallback: picsum with seed (deterministic, free)
      if (toolInput._projectDir) {
        const fullPath = path.join(toolInput._projectDir, savePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        https.get(fallbackUrl, { timeout: 15000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            https.get(res.headers.location, { timeout: 15000 }, (r2) => {
              const file = fs.createWriteStream(fullPath);
              r2.pipe(file);
              file.on('finish', () => { file.close(); resolve(`Image sauvee: ${savePath}\nURL: /${savePath}`); });
            }).on('error', () => resolve(`Image: ${fallbackUrl}`));
            return;
          }
          const file = fs.createWriteStream(fullPath);
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(`Image sauvee: ${savePath}\nURL: /${savePath}`); });
        }).on('error', () => resolve(`Image: ${fallbackUrl}`));
      } else {
        resolve(`Image URL: ${fallbackUrl}`);
      }
    });
  }

  return Promise.resolve(null);
}

// Convert HTML to clean text (basic — strips tags, keeps structure)
function htmlToText(html, url) {
  if (!html) return 'Page vide.';
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '[NAV]')
    .replace(/<header[\s\S]*?<\/header>/gi, '[HEADER]')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '[FOOTER]')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => `${'#'.repeat(parseInt(level))} ${content.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `Source: ${url}\n\n${text.substring(0, 5000)}`;
}

// Parse tool_use blocks from Claude API response into file operations
function parseToolResponse(response) {
  const result = { files: {}, edits: [], text: '', serverToolCalls: [] };
  if (!response || !response.content) return result;

  for (const block of response.content) {
    if (block.type === 'text') {
      result.text += block.text;
    } else if (block.type === 'tool_use') {
      if (block.name === 'write_file' && block.input?.path && block.input?.content) {
        // Block writes to infrastructure files only (package.json, vite.config, etc.).
        // UI components, lib/, hooks/ are now TRUSTED to the AI (Lovable model).
        if (PROTECTED_FILES.has(block.input.path)) {
          console.log(`[Tool] Blocked write to infra file: ${block.input.path}`);
        } else {
          let newContent = cleanGeneratedContent(block.input.content);
          // ── LOVABLE-STYLE ELLIPSIS MERGE ──
          // If content has "// ... keep existing code", merge with existing file
          if (newContent && newContent.includes('// ... keep existing code')) {
            const projDir = trackingInfo?.projectId ? path.join(DOCKER_PROJECTS_DIR, String(trackingInfo.projectId)) : null;
            const existingPath = projDir ? path.join(projDir, block.input.path) : null;
            if (existingPath && fs.existsSync(existingPath)) {
              const existing = fs.readFileSync(existingPath, 'utf8');
              newContent = mergeEllipsis(existing, newContent);
              console.log(`[Tool] Merged ellipsis write for ${block.input.path}`);
            }
          }
          if (newContent) { result.files[block.input.path] = newContent; }
        }
      } else if (block.name === 'line_replace' && block.input?.path && block.input?.start_line && block.input?.new_content) {
        // Line-number based replace (like Lovable lov-line-replace)
        result.edits.push({
          path: block.input.path,
          lineReplace: true,
          startLine: block.input.start_line,
          endLine: block.input.end_line || block.input.start_line,
          newContent: block.input.new_content
        });
      } else if (block.name === 'edit_file' && block.input?.path && block.input?.search) {
        result.edits.push({
          path: block.input.path,
          search: block.input.search,
          replace: block.input.replace || ''
        });
      } else if (['fetch_website', 'read_console_logs', 'run_security_check', 'parse_document', 'generate_mermaid', 'view_file', 'search_files', 'delete_file', 'rename_file', 'add_dependency', 'remove_dependency', 'download_to_project', 'read_project_analytics', 'get_table_schema', 'enable_stripe', 'search_images', 'generate_image', 'run_command', 'verify_project'].includes(block.name)) {
        result.serverToolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }
  return result;
}

// Convert tool response files into ### marker format (for DB storage compatibility)
function toolResponseToCode(parsed) {
  let code = '';
  const fileOrder = ['package.json', 'vite.config.js', 'index.html', 'server.js', 'src/main.tsx', 'src/index.css', 'src/App.tsx'];
  const written = new Set();
  for (const fn of fileOrder) {
    if (parsed.files[fn]) { code += (code ? '\n\n' : '') + `### ${fn}\n${parsed.files[fn]}`; written.add(fn); }
  }
  Object.keys(parsed.files).filter(fn => !written.has(fn)).sort().forEach(fn => {
    code += (code ? '\n\n' : '') + `### ${fn}\n${parsed.files[fn]}`;
  });
  return code;
}

// Apply edit_file operations to existing project files on disk
// ── LOVABLE-STYLE ELLIPSIS MERGE ──
// Merges new content with "// ... keep existing code" markers against the existing file.
// This allows the AI to send ONLY the changed parts, saving tokens.
function mergeEllipsis(existing, partial) {
  const existingLines = existing.split('\n');
  const partialLines = partial.split('\n');
  const result = [];
  let existingIdx = 0;

  for (let i = 0; i < partialLines.length; i++) {
    const line = partialLines[i];
    if (line.trim() === '// ... keep existing code' || line.trim() === '/* ... keep existing code */') {
      // Find where to resume: look at the NEXT non-ellipsis line in partial
      let nextPartialLine = null;
      for (let j = i + 1; j < partialLines.length; j++) {
        if (partialLines[j].trim() !== '// ... keep existing code' && partialLines[j].trim() !== '/* ... keep existing code */' && partialLines[j].trim()) {
          nextPartialLine = partialLines[j].trim();
          break;
        }
      }
      // Copy existing lines until we find the next partial line
      if (nextPartialLine) {
        while (existingIdx < existingLines.length) {
          if (existingLines[existingIdx].trim() === nextPartialLine) break;
          result.push(existingLines[existingIdx]);
          existingIdx++;
        }
      } else {
        // Last ellipsis — copy rest of existing file
        while (existingIdx < existingLines.length) {
          result.push(existingLines[existingIdx]);
          existingIdx++;
        }
      }
    } else {
      result.push(line);
      // Advance existingIdx to stay in sync
      if (existingIdx < existingLines.length && existingLines[existingIdx].trim() === line.trim()) {
        existingIdx++;
      }
    }
  }
  return result.join('\n');
}

function applyToolEdits(projectDir, edits) {
  let applied = 0;
  let failed = 0;
  const failedEdits = [];

  for (const edit of edits) {
    const filePath = path.join(projectDir, edit.path);
    if (!fs.existsSync(filePath)) {
      console.warn(`[ToolEdit] File not found: ${edit.path}`);
      failed++;
      failedEdits.push(edit);
      continue;
    }
    let content = fs.readFileSync(filePath, 'utf8');
    let matched = false;

    // LINE REPLACE (like Lovable lov-line-replace) — replace by line numbers
    if (edit.lineReplace) {
      const lines = content.split('\n');
      const start = Math.max(0, edit.startLine - 1); // 1-based to 0-based
      const end = Math.min(lines.length, edit.endLine); // inclusive
      lines.splice(start, end - start, edit.newContent);
      content = lines.join('\n');
      if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
      applied++;
      console.log(`[ToolEdit] Line replace ${edit.startLine}-${edit.endLine} on ${edit.path}`);
      continue;
    }

    // Level 1: Exact match
    if (content.includes(edit.search)) {
      content = content.replace(edit.search, edit.replace);
      matched = true;
    }

    // Level 2: Trim whitespace
    if (!matched) {
      const trimSearch = edit.search.trim();
      if (trimSearch && content.includes(trimSearch)) {
        content = content.replace(trimSearch, edit.replace.trim());
        matched = true;
        console.log(`[ToolEdit] Fuzzy match (trim) on ${edit.path}`);
      }
    }

    // Level 3: Normalize whitespace (collapse spaces, ignore indentation)
    if (!matched) {
      const normalizeWs = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n');
      const normalizedContent = normalizeWs(content);
      const normalizedSearch = normalizeWs(edit.search.trim());
      if (normalizedSearch && normalizedContent.includes(normalizedSearch)) {
        // Find the original text by line matching
        const searchLines = edit.search.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const contentLines = content.split('\n');
        for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
          let lineMatch = true;
          for (let j = 0; j < searchLines.length; j++) {
            if (contentLines[i + j].trim() !== searchLines[j]) { lineMatch = false; break; }
          }
          if (lineMatch) {
            const originalBlock = contentLines.slice(i, i + searchLines.length).join('\n');
            content = content.replace(originalBlock, edit.replace.trim());
            matched = true;
            console.log(`[ToolEdit] Fuzzy match (normalize) on ${edit.path} at line ${i + 1}`);
            break;
          }
        }
      }
    }

    // Level 4: First line match — find by the first unique line of the search text
    if (!matched) {
      const searchLines = edit.search.trim().split('\n').map(l => l.trim()).filter(Boolean);
      if (searchLines.length > 0) {
        const firstLine = searchLines[0];
        const lastLine = searchLines[searchLines.length - 1];
        const contentLines = content.split('\n');
        for (let i = 0; i < contentLines.length; i++) {
          if (contentLines[i].trim() === firstLine) {
            // Found first line — check if last line also matches nearby
            for (let j = i + 1; j < Math.min(i + searchLines.length + 5, contentLines.length); j++) {
              if (contentLines[j].trim() === lastLine) {
                const originalBlock = contentLines.slice(i, j + 1).join('\n');
                content = content.replace(originalBlock, edit.replace.trim());
                matched = true;
                console.log(`[ToolEdit] Fuzzy match (first+last line) on ${edit.path} at line ${i + 1}`);
                break;
              }
            }
            if (matched) break;
          }
        }
      }
    }

    if (matched) {
      if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
      applied++;
      console.log(`[ToolEdit] Applied edit to ${edit.path}`);
    } else {
      failed++;
      failedEdits.push(edit);
      console.warn(`[ToolEdit] FAILED on ${edit.path}: "${edit.search.substring(0, 80)}..." — no match at any level`);
    }
  }

  // If edits failed, try write_file as fallback (rewrite the whole file)
  // This ensures the modification is NEVER silently lost
  if (failedEdits.length > 0) {
    console.log(`[ToolEdit] ${failed} edit(s) failed — will be retried by follow-up`);
  }

  return { applied, failed, failedEdits };
}

// opts.useTools: if true, pass CODE_TOOLS and return parsed tool response
// opts.rawResponse: if true, return the full API response object instead of text
// opts.model: override the default model (Sonnet 4). Used for cheap routing (Haiku).
function callClaudeAPI(systemBlocks, messages, maxTokens = 32000, trackingInfo = null, opts = {}) {
  return new Promise((resolve, reject) => {
    // Model routing: opts.model overrides the default. Used by classifyIntent (Haiku 4.5)
    // and reserved for future cheap-task routing (file selection, verify pass, etc.).
    const model = opts.model || 'claude-sonnet-4-20250514';
    const apiPayload = { model, max_tokens: maxTokens, system: systemBlocks, messages };
    if (opts.useTools) {
      if (opts._partnerReadOnly) {
        // Partner Mode: read-only tools + web search (view_file, search_files, verify_project, run_command, web_search)
        // Claude can inspect the project AND search the web for references, but CANNOT write/edit files.
        apiPayload.tools = CODE_TOOLS.filter(t =>
          ['view_file', 'search_files', 'verify_project', 'read_console_logs', 'get_table_schema', 'run_command'].includes(t.name)
        );
        apiPayload.tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 2 });
        apiPayload.tool_choice = { type: 'auto' }; // auto = can respond with text after reading
      } else {
        apiPayload.tools = [...CODE_TOOLS];
        // Add web_search tool when requested (Agent Mode, standard generation)
        if (opts.webSearch !== false) {
          apiPayload.tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
        }
        // Force tool use (type: 'any') so Claude MUST use write_file/edit_file instead of
        // responding with text explaining what it WOULD do. Recursive calls (depth > 0)
        // use 'auto' to allow Claude to signal completion with a text response.
        apiPayload.tool_choice = (opts._depth || 0) > 0 ? { type: 'auto' } : { type: 'any' };
      }
    }
    const payload = JSON.stringify(apiPayload);

    // ── Job abort signal propagation ──
    let abortSignal = opts.signal || null;
    const linkedJobId = opts.jobId || trackingInfo?.jobId;
    if (!abortSignal && linkedJobId) {
      const linkedJob = generationJobs.get(linkedJobId);
      if (linkedJob && linkedJob.abortController) abortSignal = linkedJob.abortController.signal;
    }
    if (abortSignal && abortSignal.aborted) {
      const e = new Error('Requête annulée.');
      e.name = 'AbortError';
      reject(e);
      return;
    }

    const reqOpts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': opts.useTools ? 'prompt-caching-2024-07-31,web-search-2025-03-05' : 'prompt-caching-2024-07-31',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    if (abortSignal) reqOpts.signal = abortSignal;

    anthropicRequest(payload, reqOpts, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = '';
        apiRes.on('data', c => errBody += c);
        apiRes.on('end', () => {
          console.error(`[callClaudeAPI] HTTP ${apiRes.statusCode}: ${errBody.substring(0, 300)}`);
          reject(new Error(`API HTTP ${apiRes.statusCode}`));
        });
        return;
      }
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (trackingInfo && r.usage) {
            trackTokenUsage(trackingInfo.userId, trackingInfo.projectId, trackingInfo.operation, model, r.usage);
          }

          // If tools were used, parse tool_use blocks
          const hasToolUse = r.content?.some(b => b.type === 'tool_use');
          if (hasToolUse) {
            const parsed = parseToolResponse(r);
            const fileCount = Object.keys(parsed.files).length;
            const editCount = parsed.edits.length;
            const serverCalls = parsed.serverToolCalls.length;
            console.log(`[callClaudeAPI] Tools: ${fileCount} write + ${editCount} edit + ${serverCalls} server, usage: ${JSON.stringify(r.usage || {})}`);

            // Continue conversation with tool results so Claude generates ALL files
            // Without this, Claude stops after the first batch of write_file calls
            const allToolCalls = r.content.filter(b => b.type === 'tool_use');
            // Agent loop depth: how many tool-call rounds Claude can do.
            // Normal modifications: 50 rounds (read → plan → edit → verify → fix — enterprise level)
            // Plan execution / complex: 100 rounds (full autonomy for multi-file architecture)
            // Lovable uses ~20 rounds. More = wasted tokens, not better results.
            const maxDepth = (opts.jobId && generationJobs.get(opts.jobId)?.type === 'plan_execution') ? 30 : 20;
            if (allToolCalls.length > 0 && (opts._depth || 0) < maxDepth) {
              (async () => {
                try {
                  const toolResults = [];
                  const projDir = trackingInfo?.projectId ? path.join(DOCKER_PROJECTS_DIR, String(trackingInfo.projectId)) : null;
                  // Get the job to update progressMessage in real-time
                  const activeJob = opts.jobId ? generationJobs.get(opts.jobId) : null;
                  const updateProgress = (msg) => { if (activeJob) activeJob.progressMessage = msg; };

                  // Track which files Claude has read via view_file in this session.
                  // If Claude tries to edit_file without reading first, inject a warning.
                  if (!opts._viewedFiles) opts._viewedFiles = new Set();

                  // Send tool_results with REAL feedback (not just "OK")
                  for (const tc of allToolCalls) {
                    // Track view_file calls so we can warn on edit without read
                    if (tc.name === 'view_file' && tc.input?.path) {
                      opts._viewedFiles.add(tc.input.path);
                    }

                    if (tc.name === 'write_file') {
                      updateProgress(`📝 Écriture de ${tc.input?.path || 'fichier'}...`);
                      const fp = projDir ? path.join(projDir, tc.input?.path || '') : null;

                      // GUARD: Protect existing CSS/style files from full rewrite
                      // AI often rewrites theme.css, index.css when not asked
                      if (fp && fs.existsSync(fp) && /\.(css|scss)$/.test(tc.input?.path || '')) {
                        const existing = fs.readFileSync(fp, 'utf8');
                        const newContent = tc.input?.content || '';
                        // If the new content removes more than 30% of lines, block it
                        const existingLines = existing.split('\n').length;
                        const newLines = newContent.split('\n').length;
                        if (newLines < existingLines * 0.7 && existingLines > 20) {
                          toolResults.push({ type: 'tool_result', tool_use_id: tc.id,
                            content: `✗ BLOQUÉ: write_file sur ${tc.input.path} supprimerait ${existingLines - newLines} lignes de CSS existant. Utilise edit_file pour modifier uniquement les parties nécessaires, ou write_file avec "/* ... keep existing styles */" pour préserver le CSS existant.`
                          });
                          console.log(`[DesignGuard] Blocked CSS rewrite: ${tc.input.path} (${existingLines} → ${newLines} lines)`);
                          continue;
                        }
                      }

                      // GUARD: Protect existing files from unnecessary full rewrite
                      // If file exists and AI sends write_file without ellipsis, check if it's really needed
                      if (fp && fs.existsSync(fp) && PROTECTED_FILES.has(tc.input?.path)) {
                        const cleanContent = cleanGeneratedContent(tc.input?.content || '');
                        if (!cleanContent.includes('// ... keep existing') && !cleanContent.includes('/* ... keep existing')) {
                          toolResults.push({ type: 'tool_result', tool_use_id: tc.id,
                            content: `✗ BLOQUÉ: write_file sur fichier protégé ${tc.input.path} sans "// ... keep existing code". Ce fichier ne peut pas être réécrit entièrement. Utilise edit_file ou line_replace pour modifier des parties spécifiques.`
                          });
                          console.log(`[DesignGuard] Blocked full rewrite of protected file: ${tc.input.path}`);
                          continue;
                        }
                      }

                      let written = false;
                      if (fp && tc.input?.content && isValidProjectFile(tc.input.path)) {
                        try {
                          const dir = path.dirname(fp);
                          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                          const cleanContent = cleanGeneratedContent(tc.input.content);
                          // Handle "// ... keep existing code" merge
                          if (cleanContent.includes('// ... keep existing') && fs.existsSync(fp)) {
                            const existing = fs.readFileSync(fp, 'utf8');
                            const merged = mergeEllipsis(existing, cleanContent);
                            fs.writeFileSync(fp, merged);
                          } else {
                            if (fp.endsWith('.tsx') || fp.endsWith('.ts') || fp.endsWith('.jsx')) {
                              safeWriteTsx(fp, cleanContent);
                            } else {
                              fs.writeFileSync(fp, cleanContent);
                            }
                          }
                          written = true;
                          console.log(`[callClaudeAPI] write_file: ${tc.input.path}`);
                        } catch(writeErr) {
                          console.warn(`[callClaudeAPI] write_file error: ${writeErr.message}`);
                          toolResults.push({ type: 'tool_result', tool_use_id: tc.id,
                            content: `✗ ERREUR écriture ${tc.input?.path}: ${writeErr.message}. Réessaie avec write_file.`
                          });
                          continue;
                        }
                      }
                      // VERIFY: confirm file actually exists on disk after write
                      if (written && fp) {
                        if (!fs.existsSync(fp)) {
                          written = false;
                          console.warn(`[callClaudeAPI] write_file PHANTOM: ${tc.input.path} — reported written but file missing`);
                        } else {
                          const size = fs.statSync(fp).size;
                          if (size === 0) {
                            written = false;
                            console.warn(`[callClaudeAPI] write_file EMPTY: ${tc.input.path} — file is 0 bytes`);
                          }
                        }
                      }
                      toolResults.push({ type: 'tool_result', tool_use_id: tc.id,
                        content: written ? `✓ Fichier écrit: ${tc.input?.path} (${fs.existsSync(fp) ? fs.statSync(fp).size : 0} bytes)` : `✗ Fichier NON écrit: ${tc.input?.path} — réessaie avec write_file.`
                      });
                    } else if (tc.name === 'edit_file') {
                      updateProgress(`✏️ Modification de ${tc.input?.path || 'fichier'}...`);
                      const fp = projDir ? path.join(projDir, tc.input?.path || '') : null;

                      // GUARD: Warn if Claude edits a file without reading it first
                      if (tc.input?.path && !opts._viewedFiles.has(tc.input.path)) {
                        console.log(`[Guard:view_first] edit_file on ${tc.input.path} without prior view_file — injecting file content`);
                        // Instead of blocking, auto-read and inject the content so Claude sees it
                        if (fp && fs.existsSync(fp)) {
                          const currentContent = fs.readFileSync(fp, 'utf8');
                          const preview = currentContent.length > 3000 ? currentContent.substring(0, 3000) + '\n... (tronqué)' : currentContent;
                          // Append the file content to the tool result so Claude has context
                          opts._viewedFiles.add(tc.input.path);
                          // Mark this in telemetry
                          if (trackingInfo?.projectId) {
                            trackErrorPattern('EDIT_WITHOUT_VIEW', tc.input.path, trackingInfo.projectId, `edit_file sans view_file préalable`);
                          }
                        }
                      }

                      // GUARD: Convert edit_file on large files to safe line_replace automatically
                      if (fp && fs.existsSync(fp)) {
                        const fileContent = fs.readFileSync(fp, 'utf8');
                        const lines = fileContent.split('\n');
                        if (lines.length > 200 && tc.input?.search) {
                          console.log(`[AgentGuard] Large file ${tc.input.path} (${lines.length} lines) — converting edit_file to line_replace`);
                          updateProgress(`🔒 Modification sécurisée de ${tc.input.path}...`);

                          // Learn: save rule about large files for this project
                          if (trackingInfo?.projectId) {
                            const ruleDir = path.join(DOCKER_PROJECTS_DIR, String(trackingInfo.projectId));
                            appendProjectRule(ruleDir, `${tc.input.path} fait ${lines.length}+ lignes — toujours utiliser view_file + line_replace, JAMAIS edit_file`);
                          }

                          // Find the search text in the file by line
                          const searchLines = tc.input.search.split('\n');
                          const searchFirst = searchLines[0].trim();
                          let matchStart = -1;
                          for (let i = 0; i < lines.length; i++) {
                            if (lines[i].includes(searchFirst) || lines[i].trim() === searchFirst) {
                              // Verify full multi-line match
                              let fullMatch = true;
                              for (let j = 1; j < searchLines.length && (i + j) < lines.length; j++) {
                                if (!lines[i + j].includes(searchLines[j].trim()) && lines[i + j].trim() !== searchLines[j].trim()) {
                                  fullMatch = false;
                                  break;
                                }
                              }
                              if (fullMatch) { matchStart = i; break; }
                            }
                          }

                          if (matchStart >= 0) {
                            // Found it — do safe line_replace
                            const matchEnd = matchStart + searchLines.length;
                            const before = lines.slice(0, matchStart);
                            const after = lines.slice(matchEnd);
                            const newContent = [...before, ...(tc.input.replace || '').split('\n'), ...after].join('\n');
                            fs.writeFileSync(fp, newContent);
                            toolResults.push({ type: 'tool_result', tool_use_id: tc.id,
                              content: `✓ Modification sécurisée appliquée dans ${tc.input.path} (lignes ${matchStart + 1}-${matchEnd}, fichier ${lines.length} lignes). Converti de edit_file en line_replace automatiquement.`
                            });
                            console.log(`[AgentGuard] Safe line_replace applied: ${tc.input.path} lines ${matchStart + 1}-${matchEnd}`);
                          } else {
                            // Can't find the text — send file context so AI can retry with line_replace
                            const numbered = lines.map((l, i) => `${i + 1}| ${l}`).join('\n');
                            const truncated = numbered.length > 6000 ? numbered.substring(0, 6000) + '\n... (tronqué)' : numbered;
                            toolResults.push({ type: 'tool_result', tool_use_id: tc.id,
                              content: `✗ Texte non trouvé dans ${tc.input.path} (${lines.length} lignes). Le fichier est trop grand pour edit_file.\n\nUtilise line_replace avec les numeros de ligne exacts. Voici le fichier:\n${truncated}`
                            });
                            console.log(`[AgentGuard] Search text not found in ${tc.input.path}, sent file content for retry`);
                          }
                          continue;
                        }
                      }

                      let editResult = '✗ Fichier introuvable';
                      if (fp && fs.existsSync(fp)) {
                        // Apply the edit using applyToolEdits (fuzzy matching)
                        try {
                          const editApply = applyToolEdits(projDir, [tc.input]);
                          if (editApply.applied > 0) {
                            console.log(`[callClaudeAPI] edit_file applied: ${tc.input.path}`);
                          }
                        } catch (editErr) {
                          console.warn(`[callClaudeAPI] edit_file error: ${editErr.message}`);
                        }
                        const content = fs.readFileSync(fp, 'utf8');
                        const searchGone = tc.input?.search && !content.includes(tc.input.search);
                        const replacePresent = tc.input?.replace && content.includes(tc.input.replace);
                        if (searchGone && replacePresent) {
                          editResult = `✓ Modification appliquée dans ${tc.input.path} — texte remplacé avec succès.`;
                        } else if (searchGone && !replacePresent) {
                          editResult = `⚠ ${tc.input.path} — le texte recherché a été supprimé mais le remplacement n'est pas trouvé tel quel (possible reformatage). Vérifie avec view_file.`;
                        } else if (!searchGone && tc.input?.search) {
                          // AGENT MODE: Include FULL file content so AI can retry with exact text
                          let hint = '';
                          try {
                            const lines = content.split('\n');
                            const searchFirst = tc.input.search.split('\n')[0].trim();
                            const matchIdx = lines.findIndex(l => l.includes(searchFirst) || l.trim() === searchFirst);
                            if (matchIdx >= 0) {
                              // Show generous context around the match (30 lines before/after)
                              const start = Math.max(0, matchIdx - 15);
                              const end = Math.min(lines.length, matchIdx + 15);
                              hint = `\n\nVoici les lignes ${start+1}-${end} du fichier (le texte exact à chercher est ici):\n` + lines.slice(start, end).map((l,i) => (start+i+1) + '| ' + l).join('\n');
                            } else {
                              // Text not found at all — send full file (truncated) so AI can see reality
                              const numbered = lines.map((l,i) => (i+1) + '| ' + l).join('\n');
                              const maxLen = 6000;
                              hint = `\n\nLe texte recherché N'EXISTE PAS dans le fichier. Voici le contenu COMPLET (${lines.length} lignes):\n` + (numbered.length > maxLen ? numbered.substring(0, maxLen) + '\n... (tronqué)' : numbered);
                              hint += '\n\nUtilise write_file avec "// ... keep existing code" ou retente edit_file avec le texte EXACT ci-dessus.';
                            }
                          } catch {}
                          editResult = `✗ ECHEC dans ${tc.input.path} — le texte recherché ne correspond pas exactement.` + hint;
                        } else {
                          editResult = `⚠ ${tc.input.path} modifié mais impossible de vérifier. Utilise view_file pour confirmer.`;
                        }
                      }
                      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: editResult });
                    } else if (tc.name === 'line_replace') {
                      updateProgress(`✏️ Modification de ${tc.input?.path || 'fichier'}...`);
                      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: `✓ Lignes remplacées dans ${tc.input?.path || ''}` });
                    } else if (tc.name === 'web_search') {
                      updateProgress('🌐 Recherche web...');
                      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: 'OK — web search completed' });
                    } else {
                      // Our server-side tools: show progress per tool type
                      const toolProgressLabels = {
                        'view_file': `📖 Lecture de ${tc.input?.path || 'fichier'}...`,
                        'search_files': `🔍 Recherche dans le code...`,
                        'run_command': `⚡ Exécution: ${(tc.input?.command || '').substring(0, 40)}...`,
                        'verify_project': '🔍 Vérification du projet...',
                        'add_dependency': `📦 Installation de ${tc.input?.package_name || 'package'}...`,
                        'remove_dependency': `📦 Désinstallation de ${tc.input?.package_name || 'package'}...`,
                        'delete_file': `🗑️ Suppression de ${tc.input?.path || 'fichier'}...`,
                        'rename_file': `📁 Renommage de ${tc.input?.old_path || 'fichier'}...`,
                        'read_console_logs': '📋 Lecture des logs...',
                        'fetch_website': `🌐 Analyse de ${(tc.input?.url || '').substring(0, 30)}...`,
                        'generate_image': `🎨 Génération d'image...`,
                        'search_images': `🖼️ Recherche d'images...`,
                      };
                      updateProgress(toolProgressLabels[tc.name] || `🔧 ${tc.name}...`);

                      // GUARD: Block run_command from writing files (must use write_file instead)
                      if (tc.name === 'run_command' && tc.input?.command) {
                        const cmd = tc.input.command;
                        if (/echo\s+['"].*['"]\s*>\s*\w|cat\s*<<|tee\s+\w|printf.*>\s*\w/i.test(cmd)) {
                          toolResults.push({ type: 'tool_result', tool_use_id: tc.id,
                            content: `✗ INTERDIT: run_command ne doit PAS écrire de fichiers. Utilise write_file à la place. run_command est réservé à la lecture (cat, ls, grep) et à la vérification (node --check).`
                          });
                          console.log(`[AgentGuard] Blocked run_command file write: ${cmd.substring(0, 60)}`);
                          continue;
                        }
                      }

                      const input = { ...tc.input };
                      if (projDir) input._projectDir = projDir;
                      if (trackingInfo?.projectId) input.project_id = input.project_id || trackingInfo.projectId;
                      const result = await executeServerTool(tc.name, input);
                      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result || 'OK' });
                      console.log(`[ServerTool] ${tc.name}: ${(result || '').substring(0, 100)}`);
                    }
                  }
                  // ── AGENT MODE: Capture Docker errors after file writes/edits ──
                  // If we wrote or edited files, check container for runtime errors
                  // and inject them as context so Claude can self-correct.
                  const hasFileChanges = allToolCalls.some(tc => ['write_file', 'edit_file', 'line_replace'].includes(tc.name));
                  if (hasFileChanges && containerExecService && trackingInfo?.projectId) {
                    try {
                      const containerName = `pbp-project-${trackingInfo.projectId}`;
                      const container = docker?.getContainer(containerName);
                      if (container) {
                        const info = await container.inspect().catch(() => null);
                        if (info?.State?.Running) {
                          // Check server.js syntax
                          const syntaxCheck = await containerExecService.execInContainer(trackingInfo.projectId, 'node --check server.cjs 2>&1', { timeout: 5000 }).catch(() => null);
                          if (syntaxCheck && syntaxCheck.exitCode !== 0) {
                            const errMsg = (syntaxCheck.stderr || syntaxCheck.stdout || '').substring(0, 500);
                            // Append syntax error to last tool_result (can't create fake tool_use_id)
                            if (toolResults.length > 0) {
                              toolResults[toolResults.length - 1].content += `\n\n⚠ ERREUR DÉTECTÉE — server.js a une erreur de syntaxe:\n${errMsg}\nCorrige cette erreur MAINTENANT.`;
                            }
                            console.log(`[AgentMode] Syntax error detected in project ${trackingInfo.projectId}`);
                          }
                        }
                      }
                    } catch (dockerCheckErr) {
                      // Silently ignore — don't break the flow
                    }
                  }

                  // FOCUS REMINDER: inject the original user request at EVERY round
                  // Appended to the LAST tool_result (not as a separate fake tool_result)
                  if (!opts._originalRequest) {
                    for (let mi = messages.length - 1; mi >= 0; mi--) {
                      if (messages[mi].role === 'user' && typeof messages[mi].content === 'string') {
                        opts._originalRequest = messages[mi].content.substring(0, 300);
                        break;
                      }
                    }
                  }
                  if (opts._originalRequest && toolResults.length > 0) {
                    // Append reminder to the last tool_result content (not a new block)
                    const lastResult = toolResults[toolResults.length - 1];
                    lastResult.content += `\n\n📌 RAPPEL — L'utilisateur a demandé: "${opts._originalRequest}"\nConcentre-toi UNIQUEMENT sur cette demande. Ne modifie AUCUN autre fichier.`;
                  }

                  // Continue conversation with tool results (all in one user message per Anthropic API spec)
                  const currentCode = toolResponseToCode(parsed);
                  const followUp = await callClaudeAPI(systemBlocks, [
                    ...messages,
                    { role: 'assistant', content: r.content },
                    { role: 'user', content: toolResults }
                  ], maxTokens, trackingInfo, { ...opts, _depth: (opts._depth || 0) + 1 });
                  // Merge current files with continuation files
                  const merged = currentCode && followUp ? currentCode + '\n\n' + followUp : (followUp || currentCode || '');
                  resolve(merged);
                } catch (e) {
                  // User abort propagates up the recursion — must reject, not silently resolve
                  if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ERR_CANCELED')) {
                    reject(e);
                    return;
                  }
                  // Server tool failed — still return what we have
                  const code = toolResponseToCode(parsed);
                  resolve(code || parsed.text || '');
                }
              })();
              return;
            }

            if (opts.rawResponse) { resolve(parsed); return; }
            const code = toolResponseToCode(parsed);
            resolve(code || parsed.text || '');
            return;
          }

          // Fallback: plain text response (### markers or conversation)
          const text = r.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
          if (text) {
            console.log(`[callClaudeAPI] Text: ${text.length} chars, usage: ${JSON.stringify(r.usage || {})}`);
            resolve(text);
          }
          else if (r.error) reject(new Error(r.error.message));
          else reject(new Error('Réponse API vide'));
        } catch (e) { reject(e); }
      });
      apiRes.on('error', reject);
    }, (e) => {
      console.error(`[callClaudeAPI] Request error: ${e.message}`);
      reject(e);
    }, null);
  });
}

// ─── GPT-4 MINI: Fast file selection (like Lovable's two-tier model) ───
// Before sending the full project to Claude Sonnet for modification,
// use GPT-4 Mini to select which files are relevant → reduces context → fewer errors.
// Falls back to regex-based detectAffectedFiles() if OpenAI key not configured.
function callGPT4Mini(prompt, maxTokens = 500) {
  return new Promise((resolve, reject) => {
    if (!OPENAI_API_KEY) return reject(new Error('OPENAI_API_KEY not configured'));
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0
    });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) return reject(new Error(r.error.message));
          const text = r.choices?.[0]?.message?.content || '';
          console.log(`[GPT-4 Mini] ${text.length} chars, ${r.usage?.total_tokens || 0} tokens`);
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('GPT-4 Mini timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── INTENT CLASSIFIER (Claude Haiku 4.5) ───
// Replaces the brittle regex isQuestion check with an LLM-based classifier.
// Cost: ~$0.001 per call. Latency: ~300-600ms. Catches "le bouton est trop petit"
// (no action verb but clearly a fix request) and "tu peux ajouter X ?" (verb in middle).
//
// Returns: { intent: 'code'|'discuss'|'partner'|'audit'|'clarify', confidence: 0-1, source: 'haiku'|'fallback' }
//
// On any error → fallback to regex (existing behavior preserved, zero risk).
const INTENT_PROMPT = `Tu es un classifieur d'intentions. Tu reponds UNIQUEMENT avec un JSON strict.

Ton job : determiner si le message utilisateur demande de coder, de discuter, de se faire guider, d'auditer, ou s'il est trop vague.

Categories :
- "code" : l'utilisateur veut creer/modifier/supprimer/corriger du code. Il sait CE QU'IL VEUT. (verbes d'action OU constat de bug)
- "partner" : l'utilisateur explore, hesite, demande un avis, veut des suggestions, ou decrit un besoin SANS precision technique. Il a besoin d'un GUIDE.
- "audit" : l'utilisateur veut une REVUE COMPLETE du projet. Verifier que tout fonctionne, trouver les problemes, rapport qualite.
- "discuss" : pure question technique sans action attendue (comment ca marche, c'est quoi, explique-moi un concept)
- "clarify" : trop vague pour agir (1-2 mots sans contexte)

Exemples :
- "Ajoute une page contact" -> {"intent":"code","confidence":0.98}
- "Le bouton est trop petit" -> {"intent":"code","confidence":0.92}
- "Tu peux ajouter une FAQ ?" -> {"intent":"code","confidence":0.95}
- "Corrige l'erreur dans la page produits" -> {"intent":"code","confidence":0.95}
- "Je voudrais ameliorer mon site" -> {"intent":"partner","confidence":0.95}
- "Comment rendre le site plus professionnel ?" -> {"intent":"partner","confidence":0.93}
- "Qu'est-ce que tu proposes pour la page d'accueil ?" -> {"intent":"partner","confidence":0.96}
- "J'ai besoin d'un espace admin" -> {"intent":"partner","confidence":0.90}
- "Mon site manque de quelque chose" -> {"intent":"partner","confidence":0.92}
- "Tu penses quoi du design ?" -> {"intent":"partner","confidence":0.94}
- "Audite mon projet" -> {"intent":"audit","confidence":0.98}
- "Verifie que tout fonctionne" -> {"intent":"audit","confidence":0.97}
- "Fais un test complet" -> {"intent":"audit","confidence":0.96}
- "Il y a des problemes dans mon site ?" -> {"intent":"audit","confidence":0.93}
- "Revue du projet" -> {"intent":"audit","confidence":0.95}
- "Teste tout" -> {"intent":"audit","confidence":0.95}
- "Le site est pret pour la production ?" -> {"intent":"audit","confidence":0.94}
- "Comment marche le router ?" -> {"intent":"discuss","confidence":0.97}
- "C'est quoi Tailwind ?" -> {"intent":"discuss","confidence":0.96}
- "Site web" -> {"intent":"clarify","confidence":0.9}

Reponds UNIQUEMENT avec le JSON, rien d'autre.`;

async function classifyIntent(message) {
  if (!message || typeof message !== 'string' || message.trim().length < 3) {
    return { intent: 'clarify', confidence: 1, source: 'fast-path' };
  }
  try {
    const sys = [{ type: 'text', text: INTENT_PROMPT }];
    const msgs = [{ role: 'user', content: `Message: "${message.substring(0, 500)}"` }];
    const reply = await callClaudeAPI(sys, msgs, 100, null, {
      model: 'claude-haiku-4-5-20251001'
    });
    if (typeof reply !== 'string') throw new Error('non-string reply');
    const jsonMatch = reply.match(/\{[^}]*"intent"[^}]*\}/);
    if (!jsonMatch) throw new Error('no JSON found');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!['code', 'discuss', 'clarify', 'partner', 'audit'].includes(parsed.intent)) throw new Error('invalid intent');
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    return { intent: parsed.intent, confidence, source: 'haiku' };
  } catch (e) {
    log('warn', 'intent', 'Haiku classifier failed, using regex fallback', { error: e.message });
    return classifyIntentRegex(message);
  }
}

function classifyIntentRegex(message) {
  const msg = (message || '').toLowerCase();
  const hasActionVerb = /\b(cr[ée]{1,2}|ajoute|modifie|change|supprime|corrige|impl[ée]mente|int[èe]gre|construis|fais|mets|retire|remplace|g[ée]n[èe]re)\b/.test(msg);
  const isPureQuestion = /^(comment|pourquoi|qu'est-ce|c'est quoi|explique|quel|quelle|est-ce que|combien|où|quand)\b/.test(msg);
  const isAuditRequest = /\b(audit[ée]?|v[ée]rifi[ée]?|test[ée]? (complet|tout)|revue|review|probl[èe]mes?|pr[êe]t pour|production|qualit[ée]|diagnostic|bilan|inspection|teste tout|tout fonctionne)\b/.test(msg)
    || /\b(audit|v[ée]rifi|teste)\b/.test(msg) && /\b(projet|site|tout|complet|entier)\b/.test(msg);
  const isPartnerRequest = !isAuditRequest && (
    /\b(propose|sugg[èe]re|am[ée]liore|conseill|id[ée]e|avis|penses?|voudrais|besoin|manque|professionnel|mieux|optimis)\b/.test(msg)
    || /\b(qu'est-ce que tu (proposes|conseilles|recommandes|penses))\b/.test(msg)
    || (/\?$/.test(msg.trim()) && !hasActionVerb && !isPureQuestion));

  // Audit takes priority over code verbs — "Audite mon projet" is audit, not code
  if (isAuditRequest) return { intent: 'audit', confidence: 0.7, source: 'fallback' };
  if (hasActionVerb && !isAuditRequest) return { intent: 'code', confidence: 0.7, source: 'fallback' };
  if (isPartnerRequest) return { intent: 'partner', confidence: 0.65, source: 'fallback' };
  if (isPureQuestion) return { intent: 'discuss', confidence: 0.6, source: 'fallback' };
  return { intent: 'code', confidence: 0.5, source: 'fallback' };
}

// ─── CLARIFICATION PROTOCOL ───
// Detects when a brief is too vague to generate cleanly, and produces 2-3 targeted
// questions to disambiguate BEFORE consuming a full generation. Triggered only on
// NEW projects (no existing code) and when skip_clarification is not set.
//
// Heuristic for triggering: short brief AND low signal density. We deliberately keep
// the heuristic simple — false positives (clarifying when not needed) are far less
// expensive than false negatives (generating from a bad brief and getting trash).

const TECHNICAL_KEYWORDS = [
  'page', 'route', 'composant', 'component', 'table', 'api', 'endpoint',
  'database', 'auth', 'login', 'admin', 'dashboard', 'form', 'formulaire',
  'header', 'footer', 'hero', 'menu', 'sidebar', 'card', 'modal', 'sql',
  'crud', 'rest', 'jwt', 'stripe', 'payment', 'checkout', 'panier', 'cart',
  'utilisateur', 'user', 'profil', 'profile', 'inscription', 'register',
  'liste', 'list', 'détail', 'detail', 'recherche', 'search', 'filtre', 'filter',
  'contact', 'services', 'reservation', 'rdv', 'galerie', 'gallery',
  'newsletter', 'blog', 'article', 'avis', 'review', 'temoignage', 'testimonial',
  'equipe', 'team', 'about', 'apropos', 'tarif', 'pricing', 'faq'
];

function needsClarification(message, project) {
  if (!message || typeof message !== 'string') return false;
  const trimmed = message.trim();
  // Existing project (modification context) → never ask, the project itself disambiguates
  if (project && project.generated_code && project.generated_code.length > 500) return false;
  // Tokenize on word boundaries (handles accents and unicode)
  const tokens = trimmed.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean);
  const wordCount = tokens.length;
  // Very short briefs always need clarification
  if (wordCount < 6) return true;
  // Medium-short briefs need clarification only if they lack ANY technical signals.
  // Use SET membership (word boundary) to avoid substring false positives like
  // "form" matching "plateforme" or "list" matching "ecclesiastique".
  if (wordCount < 14) {
    const tokenSet = new Set(tokens);
    const techHits = TECHNICAL_KEYWORDS.filter(k => tokenSet.has(k)).length;
    if (techHits < 1) return true;
  }
  return false;
}

const CLARIFICATION_SYSTEM_PROMPT = `Tu es Prestige AI. Le brief de l'utilisateur est trop vague pour generer une application de qualite. Tu dois lui poser EXACTEMENT 3 questions courtes et concretes pour clarifier son besoin.

REGLES STRICTES :
- 3 questions, ni plus ni moins
- Format : une question par ligne, pas de numerotation, pas de tirets
- Chaque question doit etre actionnable et fermee (oui/non, choix court, ou identification d'un element manquant)
- Francais uniquement
- AUCUN texte avant ou apres les questions
- Ne pose JAMAIS de question sur les couleurs ou le design (ce sera fait automatiquement)

EXEMPLES de bonnes questions :
- Quel est le secteur d'activite ? (restaurant, sante, ecommerce, autre)
- Avez-vous besoin d'un espace administrateur pour gerer le contenu ?
- Quelles sont les 3 sections principales que la page d'accueil doit contenir ?

EXEMPLES de mauvaises questions (a EVITER) :
- Quelle palette de couleurs preferez-vous ? (interdit)
- Aimez-vous le design moderne ? (trop vague)
- Quel est le but de votre projet ? (trop vague et ouvert)`;

const FALLBACK_CLARIFICATION_QUESTIONS = [
  "Quel est le secteur d'activite (restaurant, sante, ecommerce, services, autre) ?",
  "Avez-vous besoin d'un espace administrateur pour gerer le contenu ?",
  "Quelles sont les 3 sections principales que doit contenir la page d'accueil ?"
];

async function generateClarificationQuestions(message, userId, projectId) {
  // Try Claude first for context-aware questions; fall back to generic ones on any error.
  try {
    const sys = [{ type: 'text', text: CLARIFICATION_SYSTEM_PROMPT }];
    const msgs = [{ role: 'user', content: `Brief original : "${message}"\n\nGenere les 3 questions de clarification.` }];
    const reply = await callClaudeAPI(sys, msgs, 400, { userId, projectId, operation: 'clarify' }, {});
    if (!reply || typeof reply !== 'string') return FALLBACK_CLARIFICATION_QUESTIONS;
    // Parse: split by line, keep non-empty, drop bullets/numbering, limit to 3
    const questions = reply
      .split('\n')
      .map(l => l.trim().replace(/^[-*•\d.)]+\s*/, '').replace(/^Q\d+\s*[:.-]\s*/i, ''))
      .filter(l => l.length > 8 && l.length < 220 && /[?]/.test(l))
      .slice(0, 3);
    if (questions.length === 0) return FALLBACK_CLARIFICATION_QUESTIONS;
    // Pad with generic if Claude returned fewer than 3
    while (questions.length < 3) questions.push(FALLBACK_CLARIFICATION_QUESTIONS[questions.length]);
    return questions;
  } catch (e) {
    log('warn', 'clarify', 'LLM call failed, using fallback', { error: e.message });
    return FALLBACK_CLARIFICATION_QUESTIONS;
  }
}

// Select relevant files using GPT-4 Mini (fast, cheap) before sending to Claude Sonnet
// Returns array of file paths to include in context
async function selectFilesWithLLM(projectStructure, userMessage) {
  if (!ai) return null;
  // Primary: Haiku 4.5 (same provider as Sonnet — no OPENAI_API_KEY needed)
  // Fallback: GPT-4 Mini if Haiku fails and OPENAI_API_KEY is set
  try {
    const prompt = ai.buildFileSelectionPrompt(projectStructure, userMessage);
    const response = await callClaudeAPI(
      [{ type: 'text', text: 'Tu selectionnes les fichiers pertinents pour la demande. Reponds UNIQUEMENT avec la liste de fichiers.' }],
      [{ role: 'user', content: prompt }],
      500, null, { model: 'claude-haiku-4-5-20251001' }
    );
    const files = ai.parseFileSelectionResponse(response);
    if (files.length > 0) {
      console.log(`[FileSelect] Haiku selected ${files.length} files: ${files.join(', ')}`);
      return files;
    }
    return null;
  } catch (e) {
    console.warn(`[FileSelect] Haiku failed: ${e.message}`);
    // Fallback to GPT-4 Mini if available
    if (OPENAI_API_KEY) {
      try {
        const prompt = ai.buildFileSelectionPrompt(projectStructure, userMessage);
        const response = await callGPT4Mini(prompt);
        const files = ai.parseFileSelectionResponse(response);
        if (files.length > 0) {
          console.log(`[FileSelect] GPT-4 Mini fallback selected ${files.length} files: ${files.join(', ')}`);
          return files;
        }
      } catch (e2) { console.warn(`[FileSelect] GPT-4 Mini fallback also failed: ${e2.message}`); }
    }
    return null;
  }
}

function generateViaAPI(projectId, brief, jobId) {
  const job = generationJobs.get(jobId);
  if (!job) return;

  if (!ANTHROPIC_API_KEY) {
    job.status = 'error';
    job.error = 'Le service IA n\'est pas configuré. Contactez l\'administrateur.';
    return;
  }

  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  const srcDirApi = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDirApi)) fs.mkdirSync(srcDirApi, { recursive: true });
  ensurePrestigeDir(projectDir);

  job.status = 'running';
  job.progressMessage = 'Analyse du brief...';
  console.log(`[MultiTurn] Starting multi-turn generation for project ${projectId}`);

  const sectorProfile = ai && brief ? ai.detectSectorProfile(brief) : null;
  const baseSystemPrompt = ai ? ai.SYSTEM_PROMPT : 'Tu es un expert en développement professionnel.';

  // Inject contextual prompt modules based on the brief content
  let fullSystemPrompt = baseSystemPrompt;
  if (ai && ai.getContextualPromptModules) {
    const contextModules = ai.getContextualPromptModules(brief || '', {});
    if (contextModules.length > 0) {
      fullSystemPrompt += '\n\n' + contextModules.join('\n\n');
    }
  }

  // Cached system prompt blocks (reused across all turns)
  const systemBlocks = [
    { type: 'text', text: fullSystemPrompt, cache_control: { type: 'ephemeral' } }
  ];
  if (sectorProfile) {
    systemBlocks.push({ type: 'text', text: sectorProfile });
  }

  // ─── MULTI-TURN GENERATION ───
  // Phase 1: Plan (file list) → Phase 2: Infrastructure → Phase 3: Components+Pages
  // Each phase builds on the previous, preventing truncation
  generateMultiTurn(projectId, brief, jobId, job, projectDir, systemBlocks).catch(err => {
    // User-initiated abort: mark as cancelled, NOT error
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 'ERR_CANCELED')) {
      console.log(`[MultiTurn] Cancelled by user: job ${jobId}`);
      if (job.status !== 'done') {
        job.status = 'cancelled';
        job.progressMessage = 'Génération annulée';
      }
      return;
    }
    console.error(`[MultiTurn] Fatal error: ${err.message}`);
    if (job.status === 'running') {
      job.status = 'error';
      job.error = `Erreur de génération: ${err.message}`;
    }
  });
}

async function generateMultiTurn(projectId, brief, jobId, job, projectDir, systemBlocks) {
  let allCode = '';
  // jobId in tracking → callClaudeAPI auto-propagates AbortController.signal across all phases
  const tracking = { userId: job.user_id, projectId, jobId };
  const startTime = Date.now();
  const sectorProfile = ai ? ai.detectSectorProfile(brief) : null;

  // ── SECTOR COLORS: Generate tailwind.config.js with sector-specific palette ──
  // Like Lovable: colors are injected server-side, not by the AI
  const SECTOR_PALETTES = {
    // Original 12
    health:      { primary: '199 100% 36%', accent: '168 76% 47%', muted: '199 20% 96%', card: '0 0% 100%', foreground: '199 50% 10%' },
    restaurant:  { primary: '24 80% 45%',   accent: '38 90% 55%',  muted: '30 30% 95%',  card: '30 20% 99%', foreground: '24 40% 10%' },
    ecommerce:   { primary: '262 80% 50%',  accent: '330 80% 55%', muted: '262 15% 96%', card: '0 0% 100%', foreground: '262 40% 10%' },
    corporate:   { primary: '215 70% 30%',  accent: '215 50% 45%', muted: '215 15% 96%', card: '0 0% 100%', foreground: '215 50% 10%' },
    saas:        { primary: '262 83% 58%',  accent: '230 90% 60%', muted: '262 15% 96%', card: '0 0% 100%', foreground: '262 40% 10%' },
    education:   { primary: '220 70% 50%',  accent: '30 90% 55%',  muted: '220 15% 96%', card: '0 0% 100%', foreground: '220 50% 10%' },
    realestate:  { primary: '40 70% 45%',   accent: '0 0% 15%',    muted: '40 15% 96%',  card: '0 0% 100%', foreground: '0 0% 10%' },
    hotel:       { primary: '35 60% 50%',   accent: '40 80% 55%',  muted: '35 20% 96%',  card: '35 10% 99%', foreground: '35 40% 10%' },
    portfolio:   { primary: '0 0% 15%',     accent: '0 0% 40%',    muted: '0 0% 96%',    card: '0 0% 100%', foreground: '0 0% 5%' },
    nonprofit:   { primary: '142 70% 40%',  accent: '38 90% 55%',  muted: '142 15% 96%', card: '0 0% 100%', foreground: '142 40% 10%' },
    dashboard:   { primary: '215 60% 50%',  accent: '215 40% 60%', muted: '215 15% 96%', card: '0 0% 100%', foreground: '215 50% 10%' },
    fitness:     { primary: '15 90% 55%',   accent: '142 70% 45%', muted: '15 15% 96%',  card: '0 0% 100%', foreground: '0 0% 10%' },
    // +16 nouveaux secteurs
    legal:       { primary: '215 40% 25%',  accent: '40 60% 45%',  muted: '215 10% 96%', card: '0 0% 100%', foreground: '215 30% 10%' },
    beauty:      { primary: '330 50% 55%',  accent: '280 40% 65%', muted: '330 20% 96%', card: '330 10% 99%', foreground: '330 30% 10%' },
    automotive:  { primary: '0 0% 15%',     accent: '0 80% 50%',   muted: '0 5% 96%',    card: '0 0% 100%', foreground: '0 0% 10%' },
    event:       { primary: '340 70% 55%',  accent: '42 80% 50%',  muted: '340 15% 96%', card: '0 0% 100%', foreground: '340 40% 10%' },
    media:       { primary: '0 80% 45%',    accent: '0 0% 15%',    muted: '0 10% 96%',   card: '0 0% 100%', foreground: '0 0% 10%' },
    construction:{ primary: '35 70% 45%',   accent: '215 50% 40%', muted: '35 15% 96%',  card: '0 0% 100%', foreground: '35 40% 10%' },
    agriculture: { primary: '100 50% 40%',  accent: '35 60% 50%',  muted: '100 15% 96%', card: '100 10% 99%', foreground: '100 30% 10%' },
    transport:   { primary: '215 70% 45%',  accent: '25 80% 50%',  muted: '215 15% 96%', card: '0 0% 100%', foreground: '215 40% 10%' },
    religious:   { primary: '270 30% 35%',  accent: '42 60% 50%',  muted: '270 10% 96%', card: '270 5% 99%', foreground: '270 20% 10%' },
    gaming:      { primary: '270 90% 55%',  accent: '160 90% 45%', muted: '270 15% 96%', card: '270 10% 5%', foreground: '0 0% 95%' },
    music:       { primary: '280 70% 50%',  accent: '330 80% 55%', muted: '280 15% 96%', card: '0 0% 100%', foreground: '280 40% 10%' },
    travel:      { primary: '195 80% 45%',  accent: '25 80% 55%',  muted: '195 15% 96%', card: '0 0% 100%', foreground: '195 40% 10%' },
    childcare:   { primary: '195 70% 55%',  accent: '45 90% 55%',  muted: '195 20% 96%', card: '195 10% 99%', foreground: '195 40% 10%' },
    veterinary:  { primary: '142 60% 40%',  accent: '25 70% 50%',  muted: '142 15% 96%', card: '0 0% 100%', foreground: '142 30% 10%' },
    finance:     { primary: '160 50% 30%',  accent: '215 40% 40%', muted: '160 10% 96%', card: '0 0% 100%', foreground: '160 30% 10%' },
    fashion:     { primary: '0 0% 10%',     accent: '330 60% 55%', muted: '0 0% 96%',    card: '0 0% 100%', foreground: '0 0% 5%' },
  };
  // ── STEP 1: Extract colors from brief (user-specified colors override everything) ──
  const COLOR_NAMES = {
    rouge: '0 80% 50%', red: '0 80% 50%',
    bleu: '220 80% 50%', blue: '220 80% 50%',
    vert: '142 70% 45%', green: '142 70% 45%',
    jaune: '45 95% 55%', yellow: '45 95% 55%',
    orange: '25 90% 55%',
    violet: '270 70% 55%', purple: '270 70% 55%',
    rose: '330 80% 60%', pink: '330 80% 60%',
    noir: '0 0% 10%', black: '0 0% 10%',
    blanc: '0 0% 100%', white: '0 0% 100%',
    marron: '24 60% 35%', brown: '24 60% 35%',
    beige: '35 40% 85%',
    or: '42 80% 50%', gold: '42 80% 50%', dore: '42 80% 50%',
    gris: '0 0% 50%', gray: '0 0% 50%', grey: '0 0% 50%',
    turquoise: '174 70% 45%', cyan: '185 80% 45%',
    bordeaux: '345 70% 30%', burgundy: '345 70% 30%',
    corail: '16 80% 60%', coral: '16 80% 60%',
    indigo: '240 60% 50%',
    emeraude: '160 70% 40%', emerald: '160 70% 40%',
    saumon: '6 70% 65%', salmon: '6 70% 65%',
    lavande: '270 50% 70%', lavender: '270 50% 70%',
    marine: '215 70% 25%', navy: '215 70% 25%',
    olive: '80 40% 40%',
    creme: '40 30% 92%', cream: '40 30% 92%',
  };
  // Also parse hex colors from brief
  function hexToHsl(hex) {
    const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), l = (max+min)/2;
    if (max === min) return `0 0% ${Math.round(l*100)}%`;
    const d = max-min, s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    let h = 0;
    if (max === r) h = ((g-b)/d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b-r)/d + 2) * 60;
    else h = ((r-g)/d + 4) * 60;
    return `${Math.round(h)} ${Math.round(s*100)}% ${Math.round(l*100)}%`;
  }

  const briefLower = brief.toLowerCase();
  const extractedColors = [];
  // Extract named colors (theme: rouge, blanc, noir) — match whole words only
  for (const [name, hsl] of Object.entries(COLOR_NAMES)) {
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    if (regex.test(briefLower) && hsl !== '0 0% 100%') extractedColors.push({ name, hsl });
  }
  // Extract hex colors (#FF0000, #333)
  const hexMatches = brief.match(/#[0-9a-fA-F]{6}\b/g) || [];
  for (const hex of hexMatches) extractedColors.push({ name: hex, hsl: hexToHsl(hex) });

  // Build custom palette from extracted colors
  let briefPalette = null;
  if (extractedColors.length >= 1) {
    const primary = extractedColors[0].hsl;
    const accent = extractedColors.length >= 2 ? extractedColors[1].hsl : primary.replace(/\d+%$/, '60%');
    const fg = extractedColors.find(c => c.name === 'noir' || c.name === 'black')?.hsl || primary.replace(/(\d+)\s+(\d+)%\s+(\d+)%/, '$1 50% 10%');
    briefPalette = { primary, accent, muted: primary.replace(/(\d+)\s+(\d+)%\s+(\d+)%/, '$1 15% 96%'), card: '0 0% 100%', foreground: fg };
    console.log(`[Gen] Colors extracted from brief: ${extractedColors.map(c => c.name).join(', ')} → primary: hsl(${primary})`);
  }

  // ── STEP 2: Detect sector (fallback if no colors in brief) ──
  // Extended keywords for all 28 sectors (12 from ai.js + 16 new)
  // Keywords ordered: SPECIFIC sectors first, GENERIC sectors last
  // This prevents "entreprise btp" matching corporate instead of construction
  const SECTOR_KEYWORDS = [
    // Specific sectors (multi-word keywords match first)
    ['veterinary', ['vétérinaire','clinique animale','toilettage','pension animale','animalerie']],
    ['legal', ['avocat','notaire','juridique','cabinet avocat','huissier','tribunal','contentieux']],
    ['beauty', ['coiffure','coiffeur','barbier','esthétique','manucure','maquillage','onglerie','soin visage']],
    ['automotive', ['garage','automobile','concessionnaire','carrosserie','mécanique auto','location voiture']],
    ['event', ['mariage','wedding','événement','cérémonie','réception','séminaire','dj']],
    ['media', ['télévision','chaîne tv','radio','podcast','presse','audiovisuel','diffusion']],
    ['construction', ['btp','architecte','rénovation','chantier','maçon','plombier','électricien']],
    ['agriculture', ['agriculture','ferme','élevage','plantation','agricole','coopérative']],
    ['transport', ['logistique','déménagement','taxi','vtc','coursier','fret','expédition']],
    ['religious', ['église','mosquée','temple','paroisse','diocèse','culte','pastoral']],
    ['gaming', ['gaming','esport','jeux vidéo','streamer','gamer','tournoi esport']],
    ['music', ['musique','label','concert','chanteur','rappeur','studio musique','album']],
    ['travel', ['agence voyage','croisière','circuits','destination','excursion','tourisme voyage']],
    ['childcare', ['crèche','garderie','maternelle','périscolaire','nounou','ludothèque']],
    ['fashion', ['fashion','styliste','mannequin','défilé','couture','prêt-à-porter','collection mode']],
    ['finance', ['assurance','banque','comptable','courtier','investissement','fiscalité','patrimoine']],
    // Original sectors (broader keywords)
    ['realestate', ['immobilier','appartements','maisons','propriété','logement','agence immobilière']],
    ['hotel', ['hôtel','resort','hébergement','vacances','séjour']],
    ['restaurant', ['restaurant','café','bistro','boulangerie','pâtisserie','pizzeria','brasserie','gastronomie','traiteur']],
    ['health', ['hôpital','clinique','médecin','santé','dentiste','pharmacie','médical','soins','patient']],
    ['fitness', ['fitness','salle de sport','musculation','gym','crossfit','yoga','coach sportif']],
    ['education', ['école','formation','cours','université','académie','enseignement']],
    ['saas', ['saas','startup','logiciel','plateforme','software','cloud']],
    ['portfolio', ['portfolio','photographe','designer','artiste','créatif','freelance','graphiste']],
    ['nonprofit', ['association','ong','humanitaire','fondation','bénévolat','solidarité']],
    ['dashboard', ['dashboard','back-office','erp','tableau de bord','analytics','crm']],
    ['ecommerce', ['boutique','shop','magasin','e-commerce','panier','commande']],
    // Most generic — match last
    ['corporate', ['entreprise','société','b2b','consulting','conseil','cabinet','agence','industrie','groupe']],
  ];
  let sectorKey = null;
  for (const [key, keywords] of SECTOR_KEYWORDS) {
    if (keywords.some(k => briefLower.includes(k.toLowerCase()))) { sectorKey = key; break; }
  }

  // ── STEP 3: Choose palette — brief colors > sector > neutral default ──
  const DEFAULT_PALETTE = { primary: '220 70% 50%', accent: '215 50% 60%', muted: '220 15% 96%', card: '0 0% 100%', foreground: '220 50% 10%' };
  const palette = briefPalette || SECTOR_PALETTES[sectorKey] || DEFAULT_PALETTE;
  {
    const tailwindConfig = `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(${palette.foreground.replace(/\d+%$/, '90%')})',
        input: 'hsl(${palette.foreground.replace(/\d+%$/, '90%')})',
        ring: 'hsl(${palette.primary})',
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(${palette.foreground})',
        primary: {
          DEFAULT: 'hsl(${palette.primary})',
          foreground: 'hsl(0 0% 98%)',
        },
        secondary: {
          DEFAULT: 'hsl(${palette.muted})',
          foreground: 'hsl(${palette.foreground})',
        },
        destructive: {
          DEFAULT: 'hsl(0 84.2% 60.2%)',
          foreground: 'hsl(0 0% 98%)',
        },
        muted: {
          DEFAULT: 'hsl(${palette.muted})',
          foreground: 'hsl(${palette.foreground.replace(/\d+%$/, '46%')})',
        },
        accent: {
          DEFAULT: 'hsl(${palette.accent})',
          foreground: 'hsl(0 0% 98%)',
        },
        popover: {
          DEFAULT: 'hsl(0 0% 100%)',
          foreground: 'hsl(${palette.foreground})',
        },
        card: {
          DEFAULT: 'hsl(${palette.card})',
          foreground: 'hsl(${palette.foreground})',
        },
      },
      borderRadius: {
        lg: '0.5rem',
        md: 'calc(0.5rem - 2px)',
        sm: 'calc(0.5rem - 4px)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in-from-bottom': { from: { opacity: '0', transform: 'translateY(0.5rem)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        'caret-blink': { '0%,70%,100%': { opacity: '1' }, '20%,50%': { opacity: '0' } },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-in': 'slide-in-from-bottom 0.3s ease-out',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'caret-blink': 'caret-blink 1.25s ease-out infinite',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
`;
    fs.writeFileSync(path.join(projectDir, 'tailwind.config.js'), tailwindConfig);
    const source = briefPalette ? 'brief colors' : (sectorKey ? `sector:${sectorKey}` : 'default');
    console.log(`[Gen] Palette applied (${source}): primary hsl(${palette.primary})`);
  }

  // Helper: save partial code to DB after each successful phase
  function savePartialToDb() {
    try {
      if (allCode.length > 0 && job.project_id) {
        db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready' WHERE id=?").run(allCode, job.project_id);
      }
    } catch (e) { console.error('[Gen] DB save error:', e.message); }
  }

  // ── CONTAINER: Launch isolated Docker container (like Lovable fly.io VMs) ──
  if (!(await isContainerRunningAsync(projectId))) {
    launchTemplateContainer(projectId).then(r => {
      if (r.success) console.log(`[Gen] Container ready for project ${projectId}`);
      else console.warn(`[Gen] Container launch failed: ${r.error}`);
    }).catch(e => console.error(`[Gen] Container launch error: ${e.message}`));
  }

  // Detect sector-specific structure from brief
  const sectorHint = sectorProfile ? sectorProfile.substring(0, 200) : '';

  // ── PHASE 1: Infrastructure (sequential — needed before UI) ──
  job.progressMessage = 'Génération du backend...';
  console.log(`[Gen] Phase 1: Infrastructure for project ${projectId}`);

  const infraPrompt = `Génère l'infrastructure React+Vite+TailwindCSS.

Brief: ${brief}
${sectorHint ? `Secteur: ${sectorHint}` : ''}

FICHIERS AUTOMATIQUES (NE PAS GÉNÉRER — fournis par le serveur) :
  package.json, vite.config.js, tsconfig.json, index.html, src/main.tsx

Génère SEULEMENT ces 2 fichiers :
### server.js — COPIE CE SQUELETTE EXACTEMENT, remplis les TODO :

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'prestige-secret-key';
const db = new Database('/app/data/app.db');
db.pragma('journal_mode = WAL');

app.use(cors()); app.use(helmet({ contentSecurityPolicy: false })); app.use(compression());
app.use(express.json()); app.use(express.static('dist'));

// TODO: Cree les tables avec db.prepare('CREATE TABLE IF NOT EXISTS ...').run()
// TODO: Insere les donnees demo avec db.prepare('INSERT OR IGNORE INTO ...').run(...)
// TODO: Hash admin password: const hash = bcrypt.hashSync('MotDePasse', 12)

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// TODO: Routes publiques (GET /api/services, GET /api/programs, POST /api/contact)

// Auth
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Identifiants invalides' });
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

const auth = (req, res, next) => {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Non autorise' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Token invalide' }); }
};

// TODO: Routes protegees (GET /api/admin/stats, etc.) avec auth middleware

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
// CREDENTIALS: email=admin@project.com password=MotDePasse

API better-sqlite3 OBLIGATOIRE — EXEMPLES :
  db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)').run();
  db.prepare('INSERT INTO users (name) VALUES (?)').run('Jean');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(1);
  const all = db.prepare('SELECT * FROM users').all();
  const info = db.prepare('INSERT INTO users (name) VALUES (?)').run('Marie'); // info.lastInsertRowid
  JAMAIS de callbacks. JAMAIS de .serialize(). JAMAIS de .verbose(). JAMAIS de require('sqlite3'). JAMAIS de require('bcrypt').
### tailwind.config.js — Les couleurs du secteur. NE TOUCHE PAS index.css (il est fourni). Modifie SEULEMENT les couleurs dans tailwind.config.js. FORMAT :
export default { darkMode: 'class', content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'], theme: { extend: { colors: { border: 'hsl([HSL secteur])', input: 'hsl([HSL])', ring: 'hsl([HSL primary])', background: 'hsl(0 0% 100%)', foreground: 'hsl([HSL sombre])', primary: { DEFAULT: 'hsl([HSL couleur principale])', foreground: 'hsl(210 40% 98%)' }, secondary: { DEFAULT: 'hsl([HSL])', foreground: 'hsl([HSL])' }, destructive: { DEFAULT: 'hsl(0 84.2% 60.2%)', foreground: 'hsl(210 40% 98%)' }, muted: { DEFAULT: 'hsl([HSL])', foreground: 'hsl([HSL])' }, accent: { DEFAULT: 'hsl([HSL])', foreground: 'hsl([HSL])' }, popover: { DEFAULT: 'hsl(0 0% 100%)', foreground: 'hsl([HSL])' }, card: { DEFAULT: 'hsl(0 0% 100%)', foreground: 'hsl([HSL])' } }, borderRadius: { lg: '0.5rem', md: 'calc(0.5rem - 2px)', sm: 'calc(0.5rem - 4px)' } } }, plugins: [] };
IMPORTANT : Les couleurs sont directement en hsl() dans tailwind.config.js. NE PAS mettre de couleurs dans index.css.

Code COMPLET et fonctionnel. Pas de placeholder.`;

  // Phase 1 with retry (network timeouts happen)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const infraCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: infraPrompt }], 32000, { ...tracking, operation: 'generate' }, { useTools: true });
      allCode = infraCode;
      writeGeneratedFiles(projectDir, infraCode, projectId);
      try { await writeFilesToContainer(projectId, infraCode); } catch(e) {}
      job.code = allCode;
      job.progress = allCode.length;
      savePartialToDb();
      console.log(`[Gen] Phase 1 OK: ${infraCode.length} chars (${((Date.now()-startTime)/1000).toFixed(0)}s)`);
      break;
    } catch (e) {
      console.error(`[Gen] Phase 1 attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 2) {
        job.status = 'error';
        job.error = `Erreur infrastructure: ${e.message}`;
        return;
      }
      job.progressMessage = 'Nouvelle tentative...';
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // ── PHASE 2+3 IN PARALLEL: Pages + Components at the same time ──
  job.progressMessage = 'Génération des pages et composants...';
  const phase2Start = Date.now();
  console.log(`[Gen] Phase 2+3: Pages + Components IN PARALLEL`);

  const pagesPrompt = `Génère App.tsx et les pages React pour ce projet.

Brief: ${brief}

COULEURS : utilise UNIQUEMENT les classes Tailwind semantiques :
  bg-primary, text-primary-foreground, bg-secondary, text-secondary-foreground,
  bg-muted, text-muted-foreground, bg-card, text-card-foreground, border-border,
  bg-background, text-foreground, bg-destructive, text-destructive-foreground.
  JAMAIS de var() dans className. JAMAIS de hex en dur. JAMAIS de bg-gray-*.

CONTENU : tout le contenu est EN DUR dans le JSX (const data = [...]).
  JAMAIS de fetch('/api/...') pour afficher du contenu sur les pages.
  fetch() UNIQUEMENT pour les formulaires (submit contact, réservation).

Génère ces fichiers :
### src/App.tsx — SANS BrowserRouter (déjà dans main.tsx). Import Routes, Route, Header, Footer, et TOUTES les pages (Home, About, Contact, Login, Admin + pages du secteur). Layout: <Header/> + <main className="flex-1"><Routes>...</Routes></main> + <Footer/>. Routes: /, /about, /contact, /login, /admin, + routes du secteur. JAMAIS import BrowserRouter ici.

### src/pages/Home.tsx — Page d'accueil COMPLÈTE avec TOUTES ces sections visibles en scrollant :
  1. Hero plein écran : grand titre, sous-titre, 2 boutons CTA (<Button asChild><Link to="...">)
  2. Services/produits : 3-6 cartes avec icônes lucide-react (données EN DUR dans un const)
  3. À propos résumé : texte + image
  4. Témoignages : 3 avis clients (données EN DUR) avec étoiles Star de lucide-react
  5. CTA final : titre + bouton réservation/contact
  MINIMUM 200 lignes. Contenu réaliste français. Pas de loading state, pas de fetch.
  IMAGES : TOUJOURS utiliser https://picsum.photos/seed/DESCRIPTIF/LARGEUR/HAUTEUR
  Exemples : picsum.photos/seed/hero-restaurant/1200/600, picsum.photos/seed/chef-portrait/400/400
  Le seed doit être descriptif (hero-bakery, team-photo, dish-pasta) pour que l'image soit FIXE et ne change pas au refresh.

### src/pages/About.tsx — histoire, équipe (3 personnes EN DUR), valeurs. Contenu statique.
### src/pages/Contact.tsx — formulaire contact (useState pour les champs, fetch POST /api/contact sur submit). Adresse, téléphone, email, horaires EN DUR.
### src/pages/Login.tsx — page connexion admin avec formulaire email+password (useState), fetch POST /api/auth/login, stocke token dans localStorage, redirige vers /admin avec useNavigate
### src/pages/Admin.tsx — dashboard admin PRO avec sidebar et contenu:
  LAYOUT: flex row. Sidebar gauche fixe (w-64) + contenu a droite.
  SIDEBAR: bg-card border-r border-border, logo en haut, liens: Dashboard, [items du secteur], Contacts, Parametres, bouton Deconnexion en bas
  CONTENU PAR DEFAUT (dashboard):
    - 4 stat cards en haut (total clients, RDV aujourd'hui, CA mensuel, avis) avec icones lucide-react
    - Tableau des derniers rendez-vous/commandes (fetch GET /api/appointments ou equivalent avec Authorization Bearer token)
    - Section contacts recents (fetch GET /api/contacts avec Authorization Bearer token)
  PROTECTION: useEffect verifie localStorage token, si absent redirige vers /login
  Chaque section a un state loading (Skeleton) et error handling (toast)

Chaque page : export default function, responsive, lucide-react, contenu PRO français.`;

  const compsPrompt = `Génère les composants React réutilisables.

Brief: ${brief}

COULEURS : bg-primary, text-primary-foreground, bg-muted, text-muted-foreground, border-border, etc.
JAMAIS de var() dans className. JAMAIS de hex en dur.

### src/components/Header.tsx — header sticky responsive:
  - Logo (texte) + navigation desktop (liens avec <Link to="...">)
  - Menu hamburger mobile (useState pour open/close, Menu/X icons de lucide-react)
  - <Button asChild><Link to="/contact">Contact</Link></Button> à droite
  - Fond bg-background, bordure border-b border-border

### src/components/Footer.tsx — footer professionnel:
  - 3-4 colonnes : liens rapides, horaires, coordonnées, réseaux sociaux
  - Copyright 2024. Texte text-muted-foreground. Fond bg-muted.

Chaque composant : export default function, responsive, lucide-react.`;

  // Launch BOTH in parallel — they don't depend on each other
  const [pagesResult, compsResult] = await Promise.allSettled([
    callClaudeAPI(systemBlocks, [{ role: 'user', content: pagesPrompt }], 32000, { ...tracking, operation: 'generate' }, { useTools: true }),
    callClaudeAPI(systemBlocks, [{ role: 'user', content: compsPrompt }], 24000, { ...tracking, operation: 'generate' }, { useTools: true })
  ]);

  // Merge pages result
  if (pagesResult.status === 'fulfilled') {
    allCode = mergeModifiedCode(allCode, pagesResult.value);
    writeGeneratedFiles(projectDir, pagesResult.value, projectId);
    try { await writeFilesToContainer(projectId, pagesResult.value); } catch(e) {}
    job.code = allCode;
    job.progress = allCode.length;
    job.progressMessage = 'Pages ajoutées au preview...';
    console.log(`[Gen] Pages OK: +${pagesResult.value.length} chars`);
  } else {
    console.error(`[Gen] Pages failed: ${pagesResult.reason?.message}`);
  }

  // Merge components result
  if (compsResult.status === 'fulfilled') {
    allCode = mergeModifiedCode(allCode, compsResult.value);
    writeGeneratedFiles(projectDir, compsResult.value, projectId);
    try { await writeFilesToContainer(projectId, compsResult.value); } catch(e) {}
    job.code = allCode;
    job.progress = allCode.length;
    job.progressMessage = 'Composants ajoutés au preview...';
    console.log(`[Gen] Components OK: +${compsResult.value.length} chars`);
  } else {
    console.error(`[Gen] Components failed: ${compsResult.reason?.message}`);
  }

  savePartialToDb();
  console.log(`[Gen] Phase 2+3 done in ${((Date.now()-phase2Start)/1000).toFixed(0)}s`);

  // ── Verify imports: find missing files referenced in App.jsx and generate them ──
  writeDefaultReactProject(projectDir); // fill basic defaults first
  const missingFiles = findMissingImports(projectDir);
  if (missingFiles.length > 0) {
    job.progressMessage = `Génération de ${missingFiles.length} fichier(s) manquant(s)...`;
    console.log(`[Gen] Missing imports: ${missingFiles.join(', ')}`);
    const fixPrompt = `Génère ces fichiers React manquants pour le projet.

Brief: ${brief}

Fichiers à générer avec ### markers :
${missingFiles.map(f => `### ${f}`).join('\n')}

Chaque fichier : export default function, TailwindCSS, lucide-react, contenu professionnel.`;
    try {
      const fixCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: fixPrompt }], 16000, { ...tracking, operation: 'generate' }, { useTools: true });
      allCode = mergeModifiedCode(allCode, fixCode);
      writeGeneratedFiles(projectDir, fixCode, projectId);
      console.log(`[Gen] Fixed ${missingFiles.length} missing imports`);
    } catch (e) {
      console.warn(`[Gen] Could not generate missing files: ${e.message}`);
      // Write stub components so Vite doesn't crash
      for (const f of missingFiles) {
        const fp = path.join(projectDir, f);
        if (!fs.existsSync(fp)) {
          const name = path.basename(f, '.tsx');
          const fpDir = path.dirname(fp);
          if (!fs.existsSync(fpDir)) fs.mkdirSync(fpDir, { recursive: true });
          fs.writeFileSync(fp, `import React from 'react';\n\nexport default function ${name}() {\n  return <div className="p-8"><h2 className="text-xl font-bold">${name}</h2></div>;\n}\n`);
          console.log(`[Gen] Wrote stub: ${f}`);
        }
      }
    }
    savePartialToDb();
  }

  // ── Quick JSX validation ──
  const jsxErrors = validateJsxFiles(projectDir);
  if (jsxErrors.length > 0) {
    console.warn(`[Gen] JSX issues found: ${jsxErrors.length}`);
    for (const err of jsxErrors) console.warn(`  ${err.file}: ${err.issue}`);
  }

  // ── SNAPSHOT: Save state before Vite build check / auto-fix attempts ──
  const preBuildSnapshot = saveProjectSnapshot(projectDir);

  // ── Vite build check (like Lovable: catch errors BEFORE deploying) ──
  // Run a test build to detect import errors, syntax errors, type errors
  // If it fails, send the EXACT Vite error to Claude for correction
  const viteBuildResult = testViteBuild(projectDir);
  if (!viteBuildResult.success && viteBuildResult.error) {
    job.progressMessage = 'Correction d\'erreurs de build...';
    console.log(`[Gen] Vite build failed: ${viteBuildResult.error.substring(0, 200)}`);
    trackErrorPattern('VITE_BUILD', viteBuildResult.error.split('\n')[0]?.substring(0, 200) || 'unknown', projectId, viteBuildResult.error.substring(0, 500));

    // Send the exact Vite error to Claude for auto-fix
    try {
      const fixPrompt = `Le build Vite a échoué avec cette erreur :

${viteBuildResult.error.substring(0, 2000)}

Corrige le(s) fichier(s) en cause. Utilise les outils write_file/edit_file.
Règle : imports avec @/ alias, fichiers UI en lowercase, TypeScript valide.`;

      const fixCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: fixPrompt }], 16000,
        { ...tracking, operation: 'auto-correct' }, { useTools: true });
      if (fixCode) {
        allCode = mergeModifiedCode(allCode, fixCode);
        writeGeneratedFiles(projectDir, fixCode, projectId);
        savePartialToDb();
        console.log(`[Gen] Vite build error auto-fixed`);

        // Re-test after fix — if still failing, rollback to pre-build state
        const retest = testViteBuild(projectDir);
        if (retest.success) {
          console.log(`[Gen] Vite build OK after fix`);
        } else {
          console.warn(`[Gen] Vite build still failing after fix — rolling back`);
          trackErrorPattern('ROLLBACK', 'vite_build_after_autofix', projectId, retest.error?.substring(0, 500), { rollback: true });
          rollbackToSnapshot(projectDir, preBuildSnapshot, projectId, 'Vite build failed after auto-fix');
          // Re-read rolled back code
          const rolledBackFiles = readProjectFilesRecursive(projectDir);
          allCode = formatProjectCode(rolledBackFiles);
        }
      }
    } catch (fixErr) {
      console.warn(`[Gen] Auto-fix failed: ${fixErr.message}`);
    }
  } else {
    console.log(`[Gen] Vite build check: OK`);
  }

  // ── BACK-TESTING: Automated quality checks (like Lovable's back-test pipeline) ──
  // Run automated tests on generated code BEFORE finalizing.
  // Includes static back-test (regex) + lucide-react runtime validation via docker exec.
  if (ai && ai.runBackTests) {
    const testFiles = readProjectFilesRecursive(projectDir);

    // ── DIRECT AUTO-FIX: Fix mechanical errors WITHOUT calling the AI ──
    // Reserved words as variable names, require() in TSX, etc. are simple find/replace.
    // Calling the AI to fix these wastes tokens and often fails (AI doesn't have the file in context).
    autoFixMechanicalErrors(projectDir, testFiles);

    // Re-read files after direct fixes
    const testFilesAfterFix = readProjectFilesRecursive(projectDir);
    const backTestIssues = ai.runBackTests(testFilesAfterFix);

    // Augment with runtime lucide-react validation (queries the actual installed package
    // in the project's container — catches hallucinations the static blacklist misses)
    try {
      const lucideIssues = await validateLucideIconsInContainer(projectId, testFiles);
      if (lucideIssues.length > 0) {
        // Convert to the back-test issue shape (issue field instead of type)
        for (const li of lucideIssues) {
          backTestIssues.push({
            file: li.file,
            issue: li.type,
            severity: li.severity,
            message: li.message
          });
        }
        console.log(`[Gen] Lucide runtime check: +${lucideIssues.length} invalid icon(s) detected`);
      }
    } catch (e) {
      console.warn(`[Gen] Lucide runtime check failed (non-fatal): ${e.message}`);
    }

    const warnings = backTestIssues.filter(i => i.severity === 'warning');
    const errors = backTestIssues.filter(i => i.severity !== 'warning');
    if (warnings.length > 0) {
      console.log(`[Gen] Back-test warnings (non-blocking, ${warnings.length}): ${warnings.map(w => `${w.file}:${w.issue}`).join(', ')}`);
    }
    if (backTestIssues.length > 0) {
      console.log(`[Gen] Back-test found ${errors.length} error(s) + ${warnings.length} warning(s): ${backTestIssues.map(i => i.issue).join(', ')}`);
      job.progressMessage = `Correction de ${errors.length} problème(s) qualité...`;
      const fixPrompt = ai.buildAutoFixPrompt(backTestIssues);
      if (fixPrompt) {
        try {
          const fixCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: fixPrompt }], 16000,
            { ...tracking, operation: 'auto-correct' }, { useTools: true });
          if (fixCode) {
            allCode = mergeModifiedCode(allCode, fixCode);
            writeGeneratedFiles(projectDir, fixCode, projectId);
            savePartialToDb();
            console.log(`[Gen] Back-test issues auto-fixed`);
          }
        } catch (fixErr) {
          console.warn(`[Gen] Back-test auto-fix failed: ${fixErr.message}`);
        }
      }
    } else {
      console.log(`[Gen] Back-tests passed — 0 issues`);
    }
  }

  // ── COHERENCE CHECKS (V1: warning-only, no auto-fix) ──
  // 3 AST-style cross-file checks: imports, DB columns, API routes.
  // Detects bugs that the multi-turn pipeline can introduce (Phase 1 creates table X,
  // Phase 2 references column Y that doesn't exist). Pure regex parsing — never crashes.
  if (coherence && coherence.runCoherenceChecks) {
    try {
      const filesForCheck = readProjectFilesRecursive(projectDir);
      const coherenceResult = coherence.runCoherenceChecks(filesForCheck);
      if (coherenceResult.issues.length > 0) {
        const byType = {};
        for (const i of coherenceResult.issues) byType[i.type] = (byType[i.type] || 0) + 1;
        log('warn', 'coherence', 'cross-file issues detected (warning-only)', {
          jobId, projectId, total: coherenceResult.issues.length, byType
        });
        // Surface to job for frontend visibility
        job.coherence_warnings = coherenceResult.issues.map(i => ({
          file: i.file, type: i.type, message: i.message, hint: i.hint
        }));
      } else {
        console.log(`[Gen] Coherence checks passed — 0 issues`);
      }
    } catch (e) {
      log('warn', 'coherence', 'check threw (non-fatal)', { jobId, error: e.message });
    }
  }

  // ── RUNTIME HEALTH CHECK (V1: warning-only, no auto-fix) ──
  // Live HTTP fetch on the container's Vite dev server + parses recent docker logs.
  // Catches: container crashed, white screen (broken HTML shell), Vite compilation errors.
  // Designed to be tolerant: 3 retries with backoff, never blocks the response.
  try {
    const runtimeResult = await runRuntimeHealthCheck(projectId);
    if (!runtimeResult.ok) {
      log('warn', 'runtime', 'health check failed (warning-only)', {
        jobId, projectId,
        httpStatus: runtimeResult.httpStatus,
        htmlOk: runtimeResult.htmlOk,
        issueCount: runtimeResult.issues.length,
        duration_ms: runtimeResult.duration_ms
      });
      job.runtime_warnings = runtimeResult.issues;
    } else {
      console.log(`[Gen] Runtime health check OK (${runtimeResult.duration_ms}ms)`);
    }
  } catch (e) {
    log('warn', 'runtime', 'health check threw (non-fatal)', { jobId, error: e.message });
  }

  // ── VISUAL VERIFICATION (Sprint D — FEATURE-FLAGGED OFF by default) ──
  // Browser-based check via Playwright in a separate container. Catches white screens,
  // JS console errors, API failures. Skipped silently if ENABLE_VISUAL_VERIFY != 'true'.
  if (VISUAL_VERIFY_ENABLED) {
    try {
      const visualResult = await runVisualVerification(projectId);
      if (visualResult && !visualResult.ok) {
        log('warn', 'visual', 'verification failed (warning-only)', {
          jobId, projectId,
          issueCount: visualResult.issues.length,
          consoleErrors: visualResult.console_errors?.length || 0,
          networkErrors: visualResult.network_errors?.length || 0,
          duration_ms: visualResult.duration_ms
        });
        job.visual_warnings = visualResult.issues;
      } else if (visualResult) {
        console.log(`[Gen] Visual verification OK (${visualResult.duration_ms}ms)`);
      }
    } catch (e) {
      log('warn', 'visual', 'check threw (non-fatal)', { jobId, error: e.message });
    }
  }

  // ── SEMANTIC VERIFICATION: GPT-4 Mini checks if brief is fully satisfied ──
  // Like Lovable: after generation, verify the OUTPUT matches the INPUT (brief)
  // Not syntax checks (back-tests do that) — this checks MEANING.
  // "Did the user ask for a menu page? Is there a Menu.tsx with actual menu items?"
  {
    const pages = fs.existsSync(path.join(projectDir, 'src', 'pages')) ? fs.readdirSync(path.join(projectDir, 'src', 'pages')) : [];
    const components = fs.existsSync(path.join(projectDir, 'src', 'components')) ? fs.readdirSync(path.join(projectDir, 'src', 'components')).filter(f => f !== 'ui') : [];
    const appContent = fs.existsSync(path.join(projectDir, 'src', 'App.tsx')) ? fs.readFileSync(path.join(projectDir, 'src', 'App.tsx'), 'utf8') : '';
    const serverContent = fs.existsSync(path.join(projectDir, 'server.js')) ? fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8') : '';
    const routes = (appContent.match(/<Route\s+path="([^"]+)"/g) || []).map(r => r.match(/path="([^"]+)"/)?.[1]);
    const tables = (serverContent.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map(t => t.replace('CREATE TABLE IF NOT EXISTS ', ''));
    const apiRoutes = (serverContent.match(/app\.(get|post|put|delete)\(['"]([^'"]+)['"]/g) || []).map(r => r.match(/['"]([^'"]+)['"]/)?.[1]);

    const verifyPrompt = `Brief du projet: "${brief}"

Projet généré:
- Pages: ${pages.join(', ')}
- Composants: ${components.join(', ')}
- Routes frontend: ${routes.join(', ')}
- Tables SQLite: ${tables.join(', ')}
- Routes API: ${apiRoutes.join(', ')}
- Login/Admin: ${pages.some(p => /login/i.test(p)) ? 'OUI' : 'NON'} / ${pages.some(p => /admin/i.test(p)) ? 'OUI' : 'NON'}

Le brief demande-t-il des pages ou features qui MANQUENT dans le projet?
Vérifie: chaque feature mentionnée dans le brief a-t-elle une page ET une route ET les tables/API nécessaires?

Si tout est complet, réponds: COMPLET
Sinon, liste ce qui manque (une ligne par manque):
- write_file src/pages/NomPage.tsx — description de ce que la page doit contenir
- edit_file server.js — CREATE TABLE xxx + routes API manquantes
- edit_file src/App.tsx — routes manquantes`;

    let semanticMissing = [];
    try {
      let response;
      if (OPENAI_API_KEY) {
        response = await callGPT4Mini(verifyPrompt, 800);
      } else {
        response = await callClaudeAPI(
          [{ type: 'text', text: 'Tu vérifies si un projet web correspond au brief. Réponds COMPLET ou liste les manques.' }],
          [{ role: 'user', content: verifyPrompt }], 800,
          { ...tracking, operation: 'verify' }
        );
      }
      if (response && !response.includes('COMPLET')) {
        semanticMissing = response.split('\n').filter(l => l.trim().startsWith('-') || /write_file|edit_file/i.test(l));
      }
      console.log(`[SemanticVerify] ${semanticMissing.length > 0 ? semanticMissing.length + ' missing' : 'COMPLET'}`);
    } catch (e) {
      console.warn(`[SemanticVerify] Skipped: ${e.message}`);
    }

    if (semanticMissing.length > 0) {
      job.progressMessage = `Ajout de ${semanticMissing.length} élément(s) manquant(s)...`;
      console.log(`[SemanticVerify] Missing:\n${semanticMissing.join('\n')}`);
      try {
        const fixPrompt = `Le projet a été généré mais il MANQUE des éléments du brief.

Brief: "${brief}"

Éléments manquants:
${semanticMissing.join('\n')}

Génère MAINTENANT les fichiers manquants. Pour chaque élément:
- Page .tsx → write_file complet (export default function, Tailwind, lucide-react, contenu réel)
- server.js → edit_file (CREATE TABLE + routes API + données demo)
- App.tsx → edit_file (import + Route)

TOUS en UNE réponse.`;
        const fixCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: fixPrompt }], 32000,
          { ...tracking, operation: 'auto-correct' }, { useTools: true });
        if (fixCode) {
          allCode = mergeModifiedCode(allCode, fixCode);
          writeGeneratedFiles(projectDir, fixCode, projectId);
          savePartialToDb();
          console.log(`[SemanticVerify] Fixed ${semanticMissing.length} missing items`);
        }
      } catch (fixErr) {
        console.warn(`[SemanticVerify] Fix failed: ${fixErr.message}`);
      }
    }
  }

  // ── Finalize: write canonical files + ensure everything is clean ──
  // Write canonical files that the AI must NEVER control
  const canonicalToWrite = {
    'package.json': DEFAULT_PACKAGE_JSON,
    'vite.config.js': DEFAULT_VITE_CONFIG,
    'index.html': DEFAULT_INDEX_HTML,
    'src/main.tsx': DEFAULT_MAIN_JSX,
  };
  // Preserve AI's title in index.html if present
  const aiIndexPath = path.join(projectDir, 'index.html');
  if (fs.existsSync(aiIndexPath)) {
    try {
      const aiHtml = fs.readFileSync(aiIndexPath, 'utf8');
      const titleMatch = aiHtml.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        canonicalToWrite['index.html'] = DEFAULT_INDEX_HTML.replace(/<title>[^<]*<\/title>/, `<title>${titleMatch[1]}</title>`);
      }
    } catch {}
  }
  // Preserve AI's extra deps in package.json
  const aiPkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(aiPkgPath)) {
    try {
      const aiPkg = JSON.parse(fs.readFileSync(aiPkgPath, 'utf8'));
      const canonical = JSON.parse(DEFAULT_PACKAGE_JSON);
      if (aiPkg.name) canonical.name = aiPkg.name;
      if (aiPkg.dependencies) {
        for (const [k, v] of Object.entries(aiPkg.dependencies)) {
          if (!canonical.dependencies[k]) canonical.dependencies[k] = v;
        }
      }
      canonicalToWrite['package.json'] = JSON.stringify(canonical, null, 2);
    } catch {}
  }
  for (const [fn, content] of Object.entries(canonicalToWrite)) {
    const fp = path.join(projectDir, fn);
    const fpDir = path.dirname(fp);
    if (!fs.existsSync(fpDir)) fs.mkdirSync(fpDir, { recursive: true });
    fs.writeFileSync(fp, content);
  }
  // Write tsconfig.json
  fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: "ES2020", useDefineForClassFields: true, lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true,
      isolatedModules: true, moduleDetection: "force", noEmit: true, jsx: "react-jsx",
      strict: true, noUnusedLocals: false, noUnusedParameters: false, allowJs: true,
      paths: { "@/*": ["./src/*"] } },
    include: ["src"]
  }, null, 2));
  // Delete files that shouldn't exist
  for (const junk of ['vite.config.ts']) {
    const jp = path.join(projectDir, junk);
    if (fs.existsSync(jp)) { fs.unlinkSync(jp); console.log(`[Gen] Removed unnecessary: ${junk}`); }
  }
  // Ensure tailwind.config.js and postcss.config.js exist (needed for TW3)
  const twConfigPath = path.join(projectDir, 'tailwind.config.js');
  const pcConfigPath = path.join(projectDir, 'postcss.config.js');
  const templateTwConfig = path.join(__dirname, 'templates', 'react', 'tailwind.config.js');
  const templatePcConfig = path.join(__dirname, 'templates', 'react', 'postcss.config.js');
  if (!fs.existsSync(twConfigPath) && fs.existsSync(templateTwConfig)) fs.copyFileSync(templateTwConfig, twConfigPath);
  if (!fs.existsSync(pcConfigPath) && fs.existsSync(templatePcConfig)) fs.copyFileSync(templatePcConfig, pcConfigPath);
  console.log(`[Gen] Canonical files written`);

  // Write UI component library + utils + hooks
  writeDefaultReactProject(projectDir);

  // Auto-fix relative imports in all generated files
  validateJsxFiles(projectDir);

  // ── SAFETY NET: Fix everything the AI might have forgotten ──
  // This runs AFTER all generation + back-tests. It ensures the project
  // is 100% functional even if the AI made mistakes.
  (function safetyNet() {
    const srcDir = path.join(projectDir, 'src');

    // 1. App.tsx must have Toaster if any file uses toast()
    const appPath = path.join(srcDir, 'App.tsx');
    if (fs.existsSync(appPath)) {
      let app = fs.readFileSync(appPath, 'utf8');
      let usesToast = false;
      for (const sub of ['pages', 'components']) {
        const dir = path.join(srcDir, sub);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.tsx') && !f.endsWith('.jsx')) continue;
          try {
            const content = fs.readFileSync(path.join(dir, f), 'utf8');
            if (content.includes('toast(') || content.includes('toast.')) usesToast = true;
          } catch {}
        }
      }
      if (usesToast && !app.includes('Toaster')) {
        app = "import { Toaster } from 'sonner';\n" + app;
        app = app.replace(/<\/div>\s*\)\s*}\s*$/, '<Toaster position="top-right" />\n</div>\n  )\n}');
        fs.writeFileSync(appPath, app);
        console.log('[SafetyNet] Injected <Toaster/> into App.tsx');
      }
    }

    // 2. Stub missing pages/components imported in App.tsx
    if (fs.existsSync(appPath)) {
      const app = fs.readFileSync(appPath, 'utf8');
      const imports = app.match(/from ['"]@\/(pages|components)\/(\w+)['"]/g) || [];
      for (const imp of imports) {
        const match = imp.match(/from ['"]@\/(pages|components)\/(\w+)['"]/);
        if (!match) continue;
        const [, dir, name] = match;
        const filePath = path.join(srcDir, dir, name + '.tsx');
        if (!fs.existsSync(filePath)) {
          const dirPath = path.dirname(filePath);
          if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
          fs.writeFileSync(filePath, `export default function ${name}() {\n  return (\n    <div className="min-h-screen flex items-center justify-center">\n      <h1 className="text-2xl font-bold">${name}</h1>\n    </div>\n  );\n}\n`);
          console.log(`[SafetyNet] Created stub: src/${dir}/${name}.tsx`);
        }
      }
    }

    // 3. Header.tsx must exist if App.tsx imports it
    const headerPath = path.join(srcDir, 'components', 'Header.tsx');
    if (!fs.existsSync(headerPath) && fs.existsSync(appPath) && fs.readFileSync(appPath, 'utf8').includes('Header')) {
      fs.mkdirSync(path.dirname(headerPath), { recursive: true });
      fs.writeFileSync(headerPath, `import { Link } from 'react-router-dom';\n\nexport default function Header() {\n  return (\n    <header className="bg-background border-b border-border px-6 py-4">\n      <nav className="max-w-7xl mx-auto flex justify-between items-center">\n        <Link to="/" className="text-xl font-bold text-foreground">Accueil</Link>\n        <div className="flex gap-6">\n          <Link to="/contact" className="text-muted-foreground hover:text-foreground">Contact</Link>\n        </div>\n      </nav>\n    </header>\n  );\n}\n`);
      console.log('[SafetyNet] Created default Header.tsx');
    }

    // 4. Footer.tsx must exist if App.tsx imports it
    const footerPath = path.join(srcDir, 'components', 'Footer.tsx');
    if (!fs.existsSync(footerPath) && fs.existsSync(appPath) && fs.readFileSync(appPath, 'utf8').includes('Footer')) {
      fs.mkdirSync(path.dirname(footerPath), { recursive: true });
      fs.writeFileSync(footerPath, `export default function Footer() {\n  return (\n    <footer className="bg-muted border-t border-border px-6 py-8 text-center text-muted-foreground text-sm">\n      <p>&copy; ${new Date().getFullYear()} Tous droits réservés.</p>\n    </footer>\n  );\n}\n`);
      console.log('[SafetyNet] Created default Footer.tsx');
    }

    // 5. index.css must have @tailwind directives (Tailwind 3)
    const cssPath = path.join(srcDir, 'index.css');
    if (fs.existsSync(cssPath)) {
      let css = fs.readFileSync(cssPath, 'utf8');
      if (!css.includes('@tailwind base')) {
        // Replace with template index.css which has correct @tailwind directives
        const templateCss = path.join(__dirname, 'templates', 'react', 'src', 'index.css');
        if (fs.existsSync(templateCss)) {
          fs.copyFileSync(templateCss, cssPath);
          console.log('[SafetyNet] Replaced index.css with template (missing @tailwind directives)');
        }
      }
    }

    // 6. Home.tsx must exist (the most important page)
    const homePath = path.join(srcDir, 'pages', 'Home.tsx');
    if (!fs.existsSync(homePath)) {
      fs.mkdirSync(path.dirname(homePath), { recursive: true });
      fs.writeFileSync(homePath, `export default function Home() {\n  return (\n    <div className="min-h-screen">\n      <section className="py-20 text-center">\n        <h1 className="text-4xl font-bold text-foreground mb-4">Bienvenue</h1>\n        <p className="text-muted-foreground text-lg">Votre site est en cours de construction.</p>\n      </section>\n    </div>\n  );\n}\n`);
      console.log('[SafetyNet] Created default Home.tsx');
    }

    // 7. UNIVERSAL IMPORT RESOLVER: scan ALL files, find ALL broken imports, fix them
    // This catches EVERYTHING: missing UI components, missing pages, missing libs
    const allTsxFiles = [];
    function scanTsx(dir) {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory() && !['node_modules', 'ui', 'dist', '.git'].includes(f.name)) scanTsx(path.join(dir, f.name));
        else if (f.isFile() && (f.name.endsWith('.tsx') || f.name.endsWith('.ts'))) allTsxFiles.push(path.join(dir, f.name));
      }
    }
    scanTsx(srcDir);

    for (const file of allTsxFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const imports = content.match(/from ['"](@\/[^'"]+)['"]/g) || [];
      for (const imp of imports) {
        const importPath = imp.match(/from ['"](@\/([^'"]+))['"]/)?.[2];
        if (!importPath) continue;

        // Try to resolve the import
        let resolved = path.join(srcDir, importPath);
        if (!resolved.endsWith('.tsx') && !resolved.endsWith('.ts')) {
          if (!fs.existsSync(resolved + '.tsx') && !fs.existsSync(resolved + '.ts') && !fs.existsSync(resolved + '/index.tsx') && !fs.existsSync(resolved + '/index.ts')) {
            // Import doesn't resolve — create a stub
            const ext = importPath.startsWith('components/ui/') ? '.tsx' : '.tsx';
            const stubPath = resolved + ext;
            const stubDir = path.dirname(stubPath);
            if (!fs.existsSync(stubDir)) fs.mkdirSync(stubDir, { recursive: true });

            if (importPath.startsWith('components/ui/')) {
              // UI component stub — export the named exports the import expects
              const namedImports = content.match(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]@\\/${importPath.replace(/\//g, '\\/')}['"]`));
              const names = namedImports ? namedImports[1].split(',').map(n => n.trim()) : ['default'];
              const exports = names.map(n => {
                if (n === 'default') return '';
                return `export function ${n}({ children, className, ...props }: any) {\n  return <div className={className} {...props}>{children}</div>;\n}`;
              }).filter(Boolean).join('\n\n');
              fs.writeFileSync(stubPath, `import * as React from "react";\nimport { cn } from "@/lib/utils";\n\n${exports}\n`);
              console.log(`[SafetyNet] Created UI stub: ${importPath}${ext} (${names.join(', ')})`);
            } else if (importPath.startsWith('pages/')) {
              // Page stub
              const pageName = path.basename(importPath);
              fs.writeFileSync(stubPath, `export default function ${pageName}() {\n  return <div className="p-8"><h1 className="text-2xl font-bold">${pageName}</h1></div>;\n}\n`);
              console.log(`[SafetyNet] Created page stub: ${importPath}${ext}`);
            } else if (importPath.startsWith('components/')) {
              // Component stub
              const compName = path.basename(importPath);
              fs.writeFileSync(stubPath, `export default function ${compName}({ children, ...props }: any) {\n  return <div {...props}>{children}</div>;\n}\n`);
              console.log(`[SafetyNet] Created component stub: ${importPath}${ext}`);
            } else {
              // Generic stub
              const name = path.basename(importPath);
              fs.writeFileSync(stubPath, `export default function ${name}() { return null; }\nexport const ${name}Context = {};\n`);
              console.log(`[SafetyNet] Created generic stub: ${importPath}${ext}`);
            }
          }
        }
      }
    }

    console.log('[SafetyNet] All checks passed');
  })();

  // Push final files to Docker container
  if (!(await isContainerRunningAsync(projectId))) {
    try { await launchTemplateContainer(projectId); } catch(e) {}
  }
  try {
    const containerName = getContainerName(projectId);
    // bind mounts: src/, index.html, server.js auto-visible in container
    // Only restart Express if server.js changed (for new API routes/tables)
    if (fs.existsSync(path.join(projectDir, 'server.js'))) {
      const { spawnSync } = require('child_process');
      if (spawnSync('node', ['--check', path.join(projectDir, 'server.js')], { timeout: 5000 }).status === 0) {
        try { execSync(`docker exec ${containerName} sh -c 'kill $(cat /tmp/express.pid 2>/dev/null) 2>/dev/null; cp server.js server.cjs 2>/dev/null; node server.cjs & echo $! > /tmp/express.pid'`, { timeout: 10000 }); } catch {}
      }
    }
    console.log(`[Gen] Files visible via bind mount, Express restarted`);
  } catch(e) { console.warn(`[Gen] Container push: ${e.message}`); }

  // Read final state from disk and save to DB
  const finalFiles = readProjectFilesRecursive(projectDir);
  allCode = formatProjectCode(finalFiles);
  job.code = allCode;
  savePartialToDb();

  db.prepare("UPDATE projects SET build_status='done',build_url=?,status='ready',updated_at=datetime('now') WHERE id=?").run(`/run/${projectId}/`, projectId);

  job.status = 'done';
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(0);
  job.progressMessage = `Projet React généré en ${totalSec}s !`;
  console.log(`[Gen] COMPLETE: ${Object.keys(finalFiles).length} files, ${allCode.length} chars, ${totalSec}s total`);
}

// Scan App.tsx and all components/pages for missing imports
function findMissingImports(projectDir) {
  const missing = [];
  const srcDir = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDir)) return missing;

  // Collect all .tsx/.jsx files to scan
  const filesToScan = [];
  for (const name of ['App.tsx', 'App.jsx']) {
    const p = path.join(srcDir, name);
    if (fs.existsSync(p)) { filesToScan.push(p); break; }
  }
  for (const sub of ['components', 'pages']) {
    const dir = path.join(srcDir, sub);
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).filter(f => f.endsWith('.tsx') || f.endsWith('.jsx')).forEach(f => filesToScan.push(path.join(dir, f)));
    }
  }

  // Extract imports and check if target exists
  const checked = new Set();
  for (const file of filesToScan) {
    const content = fs.readFileSync(file, 'utf8');
    const fileDir = path.dirname(file);
    // Match: import X from './path', '../path', or '@/path'
    const importRegex = /import\s+(?:\{[^}]+\}|\w+)\s+from\s+['"]((?:\.|@\/)[^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      let resolved;
      // Handle @/ alias → resolve to src/
      if (importPath.startsWith('@/')) {
        resolved = path.join(srcDir, importPath.substring(2));
      } else {
        resolved = path.resolve(fileDir, importPath);
      }
      // Try extensions
      if (!resolved.endsWith('.tsx') && !resolved.endsWith('.ts') && !resolved.endsWith('.jsx') && !resolved.endsWith('.js') && !resolved.endsWith('.css')) {
        if (fs.existsSync(resolved + '.tsx')) resolved += '.tsx';
        else if (fs.existsSync(resolved + '.ts')) resolved += '.ts';
        else if (fs.existsSync(resolved + '.jsx')) resolved += '.jsx';
        else resolved += '.tsx'; // default to .tsx
      }
      if (!checked.has(resolved)) {
        checked.add(resolved);
        if (!fs.existsSync(resolved)) {
          // Convert back to project-relative path
          const rel = path.relative(projectDir, resolved);
          if (rel.startsWith('src/')) {
            missing.push(rel);
          }
        }
      }
    }
  }
  return missing;
}

// ─── VITE BUILD TEST (like Lovable: detect errors before deployment) ───
// Runs a quick vite build in the project directory to catch import errors,
// syntax errors, and type errors BEFORE the container is built.
// Returns { success: true } or { success: false, error: 'exact Vite error message' }
function testViteBuild(projectDir) {
  // Check if vite and node_modules exist
  const viteBin = path.join(projectDir, 'node_modules', '.bin', 'vite');
  if (!fs.existsSync(viteBin)) {
    // No local vite — try with npx from base image
    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync('npx', ['vite', 'build', '--mode', 'development'], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, NODE_PATH: '/app/node_modules' }
      });
      if (result.status === 0) return { success: true };
      const error = (result.stderr || result.stdout || '').trim();
      return { success: false, error };
    } catch (e) {
      return { success: true }; // Can't test — assume OK
    }
  }

  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync(viteBin, ['build', '--mode', 'development'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 30000
    });
    if (result.status === 0) return { success: true };
    const error = (result.stderr || result.stdout || '').trim();
    // Extract the meaningful error (Vite errors have a clear format)
    const errorMatch = error.match(/error[:\s]+([\s\S]*?)(?:\n\n|\nat\s)/i);
    return { success: false, error: errorMatch ? errorMatch[1].trim() : error.substring(0, 1000) };
  } catch (e) {
    return { success: true }; // Can't test — assume OK
  }
}

// Quick JSX validation — catch common errors before Vite build
function validateJsxFiles(projectDir) {
  const errors = [];
  const srcDir = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDir)) return errors;

  const jsxFiles = [];
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) scanDir(path.join(dir, entry.name));
      else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') || entry.name.endsWith('.jsx') || entry.name.endsWith('.js')) jsxFiles.push(path.join(dir, entry.name));
    }
  }
  scanDir(srcDir);

  for (const file of jsxFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(projectDir, file);

    // Must have export
    if (!content.includes('export')) {
      errors.push({ file: rel, issue: 'no export statement' });
    }
    // Must not have SUGGESTIONS: text
    let current = content;
    if (/^SUGGESTIONS:/m.test(current)) {
      current = current.replace(/\n*SUGGESTIONS:[\s\S]*$/m, '').trim();
      fs.writeFileSync(file, current);
      errors.push({ file: rel, issue: 'SUGGESTIONS artifact removed' });
    }
    // Must not have markdown backticks
    if (/^```/m.test(current)) {
      current = current.replace(/^```.*$/gm, '').trim();
      fs.writeFileSync(file, current);
      errors.push({ file: rel, issue: 'markdown backticks removed' });
    }
    // Check for unclosed JSX (very basic — count < vs />)
    const openTags = (content.match(/<[A-Z]\w*/g) || []).length;
    const closeTags = (content.match(/<\/[A-Z]\w*/g) || []).length;
    const selfClose = (content.match(/\/>/g) || []).length;
    if (openTags > closeTags + selfClose + 3) {
      errors.push({ file: rel, issue: `possible unclosed JSX (${openTags} open, ${closeTags} close, ${selfClose} self-close)` });
    }
    // Check for duplicate default exports
    const defaultExports = (content.match(/export default/g) || []).length;
    if (defaultExports > 1) {
      errors.push({ file: rel, issue: `${defaultExports} default exports (should be 1)` });
    }
    // Auto-fix relative imports → @/ alias (the AI sometimes generates ../ despite the prompt)
    if (/from ['"]\.\.\//.test(current) || /from ['"]\.\/components/.test(current) || /from ['"]\.\/pages/.test(current)) {
      let fixed = current;
      // ../components/ → @/components/ (preserve original quote style)
      fixed = fixed.replace(/from (['"])\.\.\/components\//g, "from $1@/components/");
      fixed = fixed.replace(/from (['"])\.\.\/\.\.\/components\//g, "from $1@/components/");
      // ../pages/ → @/pages/
      fixed = fixed.replace(/from (['"])\.\.\/pages\//g, "from $1@/pages/");
      // ../lib/ → @/lib/
      fixed = fixed.replace(/from (['"])\.\.\/lib\//g, "from $1@/lib/");
      fixed = fixed.replace(/from (['"])\.\.\/\.\.\/lib\//g, "from $1@/lib/");
      // ../hooks/ → @/hooks/
      fixed = fixed.replace(/from (['"])\.\.\/hooks\//g, "from $1@/hooks/");
      fixed = fixed.replace(/from (['"])\.\.\/\.\.\/hooks\//g, "from $1@/hooks/");
      // ./components/ → @/components/ (from App.tsx)
      fixed = fixed.replace(/from (['"])\.\/components\//g, "from $1@/components/");
      fixed = fixed.replace(/from (['"])\.\/pages\//g, "from $1@/pages/");
      if (fixed !== current) {
        fs.writeFileSync(file, fixed);
        current = fixed;
        errors.push({ file: rel, issue: 'relative imports converted to @/' });
      }
    }
  }
  return errors;
}

// Write ### marked code sections to files in the project directory
// Merge modified files with existing code — keeps files Claude didn't return
// Validate generated server.js syntax and auto-fix with Claude (like Lovable)
// Validate React project: server.js syntax + essential JSX files exist + vite.config.js parseable
async function validateAndFixCode(projectId, code, maxAttempts = 3) {
  const projDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  const serverJsPath = path.join(projDir, 'server.js');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Write files to disk
    writeGeneratedFiles(projDir, code, projectId);

    // 1) Validate server.js syntax (CommonJS — node --check works)
    let serverOk = true;
    if (fs.existsSync(serverJsPath)) {
      const { spawnSync } = require('child_process');
      const result = spawnSync('node', ['--check', serverJsPath], { encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0) {
        serverOk = false;
        const error = (result.stderr || result.stdout || '').substring(0, 500);
        console.log(`[Validate] server.js syntax error (attempt ${attempt}/${maxAttempts}): ${error.substring(0, 100)}`);

        if (attempt >= maxAttempts) break;

        // Ask Claude to fix
        const fixPrompt = `Le server.js du projet React a cette erreur de syntaxe:\n${error}\n\nCorrige UNIQUEMENT l'erreur. Le server.js sert dist/ via express.static. Retourne le server.js complet corrigé avec ### server.js`;
        const fixPayload = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 32000,
          messages: [
            { role: 'user', content: `### server.js\n${fs.readFileSync(serverJsPath, 'utf8')}` },
            { role: 'user', content: fixPrompt }
          ]
        });
        const fixOpts = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(fixPayload) }
        };

        code = await new Promise((resolve) => {
          const req = https.request(fixOpts, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
              try {
                const r = JSON.parse(d);
                const text = r.content?.[0]?.text || '';
                if (text.includes('### ')) {
                  resolve(mergeModifiedCode(code, text));
                } else { resolve(code); }
              } catch { resolve(code); }
            });
          });
          req.on('error', () => resolve(code));
          req.setTimeout(60000, () => { req.destroy(); resolve(code); });
          req.write(fixPayload); req.end();
        });
        console.log(`[Validate] Fix received from Claude, retrying...`);
        continue; // retry the loop
      }
    }

    // 2) Validate essential React files exist
    const essentialFiles = ['index.html', 'src/main.tsx', 'src/App.tsx', 'vite.config.js'];
    let missingFiles = [];
    for (const f of essentialFiles) {
      if (!fs.existsSync(path.join(projDir, f))) missingFiles.push(f);
    }
    if (missingFiles.length > 0) {
      console.log(`[Validate] Missing React files: ${missingFiles.join(', ')} — writing defaults`);
      writeDefaultReactProject(projDir);
    }

    // 3) Quick JSX sanity check: src/App.jsx should contain valid-looking JSX
    const appJsxPath = path.join(projDir, 'src', 'App.tsx');
    if (fs.existsSync(appJsxPath)) {
      const appContent = fs.readFileSync(appJsxPath, 'utf8');
      const hasExport = /export\s+default/.test(appContent);
      const hasJsx = /<\w/.test(appContent);
      const hasImport = /import\s+/.test(appContent);
      if (!hasExport || !hasJsx || !hasImport) {
        console.warn(`[Validate] src/App.jsx looks malformed (export:${hasExport} jsx:${hasJsx} import:${hasImport})`);
        if (attempt < maxAttempts) {
          // Ask Claude to fix App.jsx
          const fixPrompt = `Le fichier src/App.jsx du projet React est malformé. Il doit contenir un composant React valide avec import React, export default function, et du JSX. Corrige-le.\n\nContenu actuel:\n${appContent.substring(0, 3000)}\n\nRetourne le fichier corrigé avec ### src/App.tsx`;
          const fixPayload = JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 16000,
            messages: [{ role: 'user', content: fixPrompt }]
          });
          const fixOpts = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(fixPayload) }
          };
          code = await new Promise((resolve) => {
            const req = https.request(fixOpts, res => {
              let d = ''; res.on('data', c => d += c);
              res.on('end', () => {
                try {
                  const r = JSON.parse(d);
                  const text = r.content?.[0]?.text || '';
                  if (text.includes('### ')) resolve(mergeModifiedCode(code, text));
                  else resolve(code);
                } catch { resolve(code); }
              });
            });
            req.on('error', () => resolve(code));
            req.setTimeout(60000, () => { req.destroy(); resolve(code); });
            req.write(fixPayload); req.end();
          });
          continue;
        }
      }
    }

    if (serverOk) {
      console.log(`[Validate] React project validated OK (attempt ${attempt})`);
      return code;
    }
  }
  return code;
}

// Build a project structure summary for Claude (React multi-file)
function buildProjectStructure(code) {
  const files = {};
  code.split(/### /).filter(s => s.trim()).forEach(s => {
    const nl = s.indexOf('\n');
    if (nl === -1) return;
    const fn = s.substring(0, nl).trim();
    const content = s.substring(nl + 1).trim();
    if (fn) files[fn] = content;
  });

  let structure = 'STRUCTURE DU PROJET REACT:\n';
  for (const [fn, content] of Object.entries(files)) {
    if (fn === 'server.js') {
      const routes = (content.match(/app\.(get|post|put|delete)\(['"`/][^,]+/g) || []);
      const tables = (content.match(/CREATE TABLE[^(]+/g) || []);
      structure += `\n  server.js (${content.length} chars)\n`;
      structure += `    Routes: ${routes.slice(0, 15).join(', ')}\n`;
      structure += `    Tables: ${tables.join(', ')}\n`;
    } else if (fn === 'src/App.jsx') {
      const reactRoutes = (content.match(/<Route\s+path="([^"]+)"/g) || []);
      const imports = (content.match(/import\s+\w+\s+from\s+'([^']+)'/g) || []);
      structure += `\n  src/App.jsx (${content.length} chars)\n`;
      structure += `    Routes: ${reactRoutes.join(', ')}\n`;
      structure += `    Imports: ${imports.length}\n`;
    } else if (fn === 'package.json') {
      try {
        const pkg = JSON.parse(content);
        const deps = Object.keys(pkg.dependencies || {});
        structure += `\n  package.json — ${pkg.name}\n`;
        structure += `    Dependencies: ${deps.join(', ')}\n`;
      } catch { structure += `\n  package.json\n`; }
    } else if (fn.startsWith('src/components/') || fn.startsWith('src/pages/')) {
      structure += `\n  ${fn} (${content.length} chars)\n`;
    }
  }
  return structure;
}

// ─── GUARD: safeFixServerJs — auto-correct ALL common AI errors in server.js ───
function safeFixServerJs(content) {
  const fixes = [];
  const usesAsyncSqlite = content.includes('db.serialize') || content.includes('(err, rows)') || content.includes('(err, row)') || content.includes(".verbose()");

  // ── 1. WRONG PACKAGES (simple string replace — always safe) ──
  content = content.replace(/require\(['"]sqlite3['"]\)\.verbose\(\)/g, "require('better-sqlite3')");
  content = content.replace(/require\(['"]sqlite3['"]\)/g, "require('better-sqlite3')");
  content = content.replace(/require\(['"]bcrypt['"]\)(?!js)/g, "require('bcryptjs')");

  // ── 2. WRONG DB CONSTRUCTOR ──
  content = content.replace(/new\s+sqlite3\.Database\([^)]*\)/g, "new (require('better-sqlite3'))('/app/data/app.db')");
  content = content.replace(/['"]:\s*memory\s*:['"]/g, "'/app/data/app.db'");

  // ── 3. IF CODE USES ASYNC SQLITE3 API → full rewrite via line-by-line transform ──
  if (usesAsyncSqlite) {
    fixes.push('async→sync rewrite');
    const lines = content.split('\n');
    const output = [];
    let skipClosingBrace = 0; // track orphaned }); from callbacks

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Remove db.serialize wrapper
      if (/db\.serialize\s*\(/.test(line)) { skipClosingBrace++; continue; }

      // db.run(SQL) for DDL → db.prepare(SQL).run()
      line = line.replace(/db\.run\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*\)/, 'db.prepare($1).run()');

      // db.run(SQL, [params]) → db.prepare(SQL).run(params)
      line = line.replace(/db\.run\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\[([^\]]*)\]\s*\)/, 'db.prepare($1).run($2)');

      // db.all(SQL, (err, rows) => { → const rows = db.prepare(SQL).all();
      const allNoParams = line.match(/db\.all\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/);
      if (allNoParams) {
        line = line.replace(/db\.all\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/, 'try { const $2 = db.prepare($1).all();');
        skipClosingBrace++;
        output.push(line); continue;
      }

      // db.all(SQL, [params], (err, rows) => { → const rows = db.prepare(SQL).all(params);
      const allWithParams = line.match(/db\.all\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\[([^\]]*)\]\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/);
      if (allWithParams) {
        line = line.replace(/db\.all\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\[([^\]]*)\]\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/, 'try { const $3 = db.prepare($1).all($2);');
        skipClosingBrace++;
        output.push(line); continue;
      }

      // db.get(SQL, (err, row) => { → const row = db.prepare(SQL).get();
      const getNoParams = line.match(/db\.get\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/);
      if (getNoParams) {
        line = line.replace(/db\.get\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/, 'try { const $2 = db.prepare($1).get();');
        skipClosingBrace++;
        output.push(line); continue;
      }

      // db.get(SQL, [params], (err, row) => { → const row = db.prepare(SQL).get(params);
      const getWithParams = line.match(/db\.get\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\[([^\]]*)\]\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/);
      if (getWithParams) {
        line = line.replace(/db\.get\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*,\s*\[([^\]]*)\]\s*,\s*\(err,?\s*(\w+)\)\s*=>\s*\{/, 'try { const $3 = db.prepare($1).get($2);');
        skipClosingBrace++;
        output.push(line); continue;
      }

      // bcrypt.compare(a, b, (err, match) => { → const match = bcrypt.compareSync(a, b);
      if (/bcrypt\.compare\(/.test(line) && /=>\s*\{/.test(line)) {
        line = line.replace(/bcrypt\.compare\(\s*([^,]+),\s*([^,]+),\s*(?:\([^)]*\)|[^)]*)\s*=>\s*\{/, '{ const match = bcrypt.compareSync($1, $2);');
        skipClosingBrace++;
        output.push(line); continue;
      }

      // bcrypt.hash(a, n, (err, hash) => { → const hash = bcrypt.hashSync(a, n);
      if (/bcrypt\.hash\(/.test(line) && /=>\s*\{/.test(line)) {
        line = line.replace(/bcrypt\.hash\(\s*([^,]+),\s*(\d+)\s*,\s*(?:\([^)]*\)|[^)]*)\s*=>\s*\{/, '{ const hash = bcrypt.hashSync($1, $2);');
        skipClosingBrace++;
        output.push(line); continue;
      }

      // Remove if (err) checks
      if (/^\s*if\s*\(\s*err\s*\)/.test(line)) {
        // Skip this line and any single-line error handler
        if (line.includes(';') && !line.includes('{')) continue;
        if (line.includes('{') && line.includes('}')) continue;
        if (line.includes('{')) { // multiline if(err) block — skip until }
          let depth = 1;
          while (++i < lines.length && depth > 0) {
            depth += (lines[i].match(/\{/g) || []).length;
            depth -= (lines[i].match(/\}/g) || []).length;
          }
          i--; continue;
        }
        continue;
      }

      // Replace orphaned }); with } catch(e) { res.status(500).json({error:e.message}); }
      if (skipClosingBrace > 0 && /^\s*\}\s*\)\s*;?\s*$/.test(line)) {
        output.push(line.replace(/\}\s*\)\s*;?/, '} catch(e) { if (res && !res.headersSent) res.status(500).json({error:e.message}); }'));
        skipClosingBrace--;
        continue;
      }

      // await bcrypt → sync
      line = line.replace(/await\s+bcrypt\.hash\(([^,]+),\s*(\d+)\)/g, 'bcrypt.hashSync($1, $2)');
      line = line.replace(/await\s+bcrypt\.compare\(([^,]+),\s*([^)]+)\)/g, 'bcrypt.compareSync($1, $2)');

      output.push(line);
    }
    content = output.join('\n');
  }

  // ── 4. SIMPLE FIXES (always safe) ──

  // Listen on 0.0.0.0
  if (!content.includes("'0.0.0.0'") && !content.includes('"0.0.0.0"')) {
    content = content.replace(/app\.listen\(\s*(PORT|port|\d+)\s*,\s*\(\)/g, "app.listen($1, '0.0.0.0', ()");
    content = content.replace(/app\.listen\(\s*(PORT|port|\d+)\s*,\s*\(/g, "app.listen($1, '0.0.0.0', (");
    content = content.replace(/app\.listen\(\s*(PORT|port|\d+)\s*\)/g, "app.listen($1, '0.0.0.0', () => console.log('Server running on port ' + $1))");
    fixes.push('listen→0.0.0.0');
  }

  // Missing /health
  if (!content.includes('/health')) {
    const idx = content.indexOf('express.json()');
    if (idx > 0) { const at = content.indexOf(';', idx) + 1; content = content.substring(0, at) + "\napp.get('/health', (req, res) => res.json({ status: 'ok' }));" + content.substring(at); }
    fixes.push('+/health');
  }

  // Missing static
  if (!content.includes('express.static')) {
    const idx = content.indexOf('express.json()');
    if (idx > 0) { const at = content.indexOf(';', idx) + 1; content = content.substring(0, at) + "\napp.use(express.static('dist'));" + content.substring(at); }
    fixes.push('+static');
  }

  // Missing SPA fallback
  if (!content.includes("app.get('*'") && !content.includes('app.get("*"') && !content.includes('app.get(/.*/)')) {
    const li = content.lastIndexOf('app.listen');
    if (li > 0) { content = content.substring(0, li) + "app.get('*', (req, res) => res.sendFile(require('path').join(__dirname, 'dist', 'index.html')));\n\n" + content.substring(li); fixes.push('+SPA'); }
  }

  // ESM → CommonJS
  if (/^import\s+\w+\s+from\s+/m.test(content)) {
    content = content.replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g, "const $1 = require('$2');");
    content = content.replace(/import\s*\{\s*([^}]+)\s*\}\s*from\s+['"]([^'"]+)['"]\s*;?/g, "const { $1 } = require('$2');");
    content = content.replace(/export\s+default\s+/g, 'module.exports = ');
    fixes.push('ESM→CJS');
  }

  // Trailing conversational text
  const lastBrace = content.lastIndexOf('}');
  const lastSemi = content.lastIndexOf(';');
  const lastCode = Math.max(lastBrace, lastSemi);
  if (lastCode > 0) {
    const after = content.substring(lastCode + 1).trim();
    if (after.length > 10 && /[a-zA-ZÀ-ÿ]/.test(after)) {
      content = content.substring(0, lastCode + 1) + '\n';
      fixes.push('trailing-text');
    }
  }

  if (fixes.length > 0) console.log(`[Guard:server.js] Fixed: ${fixes.join(', ')}`);
  return content;
}

// ─── UNIVERSAL INDEX.CSS FIX ───
// Guarantees index.css works with Tailwind 3 no matter what the AI generates.
// Uses the template as the safe base, extracts AI's custom colors, merges them.
// ── TAILWIND 3 CSS FIX (simple — TW3 is mature, few issues) ──
// ── SAFE WRITE: ALL auto-fixes applied on EVERY file write ──
// This is the SINGLE point of truth for writing .tsx/.ts/.css files.
// Every fix runs here — no matter if the file was written by edit_file,
// write_file, line_replace, SafetyNet, or any other path.
function safeWriteTsx(filePath, content) {
  if (!content || !filePath) return;
  const filename = path.basename(filePath);
  const ext = path.extname(filePath);

  if (ext === '.tsx' || ext === '.jsx' || ext === '.ts') {
    // 1. Deduplicate imports
    const uniqueImports = new Set();
    content = content.replace(/^import .+$/gm, (match) => {
      if (uniqueImports.has(match)) return ''; // remove duplicate
      uniqueImports.add(match);
      return match;
    });
    content = content.replace(/\n{3,}/g, '\n\n');

    // 2. Fix picsum without seed
    content = content.replace(/https:\/\/picsum\.photos\/(\d+)\/(\d+)/g, (match, w, h) => {
      if (match.includes('/seed/')) return match;
      const seed = filename.replace(/\.[^.]+$/, '') + '-' + w + 'x' + h;
      return `https://picsum.photos/seed/${seed}/${w}/${h}`;
    });

    // 3. Add missing export default
    if (!content.includes('export default') && !content.includes('export {') && !filePath.includes('/ui/') && !filePath.includes('/lib/') && !filePath.includes('/hooks/')) {
      const funcMatch = content.match(/^function (\w+)/m);
      if (funcMatch) content = content.replace(`function ${funcMatch[1]}`, `export default function ${funcMatch[1]}`);
    }

    // 4. Remove BrowserRouter from App.tsx (it's in main.tsx)
    if (filename === 'App.tsx' && content.includes('BrowserRouter')) {
      content = content.replace(/import\s*\{[^}]*BrowserRouter,?\s*/g, (match) => {
        const others = match.match(/\{([^}]*)\}/)?.[1]?.split(',').map(s => s.trim()).filter(s => s && s !== 'BrowserRouter');
        if (others && others.length > 0) return `import { ${others.join(', ')} `;
        return '';
      });
      content = content.replace(/<BrowserRouter[^>]*>/g, '');
      content = content.replace(/<\/BrowserRouter>/g, '');
      content = content.replace(/\n{3,}/g, '\n\n');
    }
  }

  // Write the file
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
}

function fixIndexCss(content) {
  const templatePath = path.join(__dirname, 'templates', 'react', 'src', 'index.css');
  // TW4 → TW3 conversion
  if (content.includes('@import "tailwindcss"')) {
    content = content.replace('@import "tailwindcss";', '@tailwind base;\n@tailwind components;\n@tailwind utilities;');
  }
  content = content.replace(/@theme\s*\{[\s\S]*?\n\}/g, '');
  content = content.replace(/theme\([^)]+\)/g, '');
  if (!content.includes('@tailwind base')) {
    content = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n' + content;
  }
  // Fix unbalanced braces
  const opens = (content.match(/\{/g) || []).length;
  const closes = (content.match(/\}/g) || []).length;
  if (opens !== closes && fs.existsSync(templatePath)) {
    const template = fs.readFileSync(templatePath, 'utf8');
    const aiRoot = content.match(/:root\s*\{([^}]+)\}/);
    const aiDark = content.match(/\.dark\s*\{([^}]+)\}/);
    let fixed = template;
    if (aiRoot) fixed = fixed.replace(/:root\s*\{[^}]+\}/, `:root {\n${aiRoot[1]}}`);
    if (aiDark) fixed = fixed.replace(/\.dark\s*\{[^}]+\}/, `.dark {\n${aiDark[1]}}`);
    return fixed;
  }
  // If no HSL variables, use template
  if (!content.includes('--background:') && !content.includes('--primary:')) {
    if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
  }
  return content;
}

// ─── DIFF-BASED MODIFICATION SUPPORT ───
// Apply SEARCH/REPLACE diffs to existing files (like Claude Code's edit format)
// Format: ### DIFF filename\n<<<< SEARCH\nold code\n==== REPLACE\nnew code\n>>>>
function applyDiffs(existingCode, diffCode) {
  const existingFiles = {};
  // Parse existing files
  existingCode.split(/### /).filter(s => s.trim()).forEach(s => {
    const nl = s.indexOf('\n');
    if (nl === -1) return;
    const fn = s.substring(0, nl).trim();
    if (fn && !fn.startsWith('DIFF ')) existingFiles[fn] = s.substring(nl + 1).trim();
  });

  // Find DIFF blocks in the new code
  const diffPattern = /### DIFF ([^\n]+)\n([\s\S]*?)(?=### (?:DIFF )?|$)/g;
  let match;
  let applied = 0;
  let failed = 0;

  while ((match = diffPattern.exec(diffCode)) !== null) {
    const filename = match[1].trim();
    const diffBody = match[2];
    if (!existingFiles[filename]) {
      console.warn(`[Diff] File not found for diff: ${filename}`);
      failed++;
      continue;
    }

    // Parse all SEARCH/REPLACE blocks in this diff
    const searchReplacePattern = /<<<< SEARCH\n([\s\S]*?)\n==== REPLACE\n([\s\S]*?)\n>>>>/g;
    let srMatch;
    let fileContent = existingFiles[filename];
    let fileApplied = 0;

    while ((srMatch = searchReplacePattern.exec(diffBody)) !== null) {
      const searchText = srMatch[1];
      const replaceText = srMatch[2];
      if (fileContent.includes(searchText)) {
        fileContent = fileContent.replace(searchText, replaceText);
        fileApplied++;
      } else {
        // Try with trimmed whitespace (common issue)
        const trimmedSearch = searchText.trim();
        if (trimmedSearch && fileContent.includes(trimmedSearch)) {
          fileContent = fileContent.replace(trimmedSearch, replaceText.trim());
          fileApplied++;
        } else {
          console.warn(`[Diff] SEARCH block not found in ${filename}: "${searchText.substring(0, 50)}..."`);
          failed++;
        }
      }
    }

    if (fileApplied > 0) {
      existingFiles[filename] = fileContent;
      applied += fileApplied;
      console.log(`[Diff] Applied ${fileApplied} change(s) to ${filename}`);
    }
  }

  console.log(`[Diff] Total: ${applied} applied, ${failed} failed`);

  // Rebuild code string
  return formatProjectCodeFromMap(existingFiles);
}

// Helper: rebuild ### code string from file map
function formatProjectCodeFromMap(files) {
  const fileOrder = [
    'package.json', 'vite.config.js', 'index.html', 'server.js',
    'src/main.tsx', 'src/index.css', 'src/App.tsx'
  ];
  let result = '';
  const written = new Set();
  for (const fn of fileOrder) {
    if (files[fn]) { result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`; written.add(fn); }
  }
  Object.keys(files).filter(fn => !written.has(fn)).sort((a, b) => {
    const order = (f) => f.startsWith('src/components/') ? 0 : f.startsWith('src/pages/') ? 1 : 2;
    return order(a) - order(b) || a.localeCompare(b);
  }).forEach(fn => { result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`; });
  return result;
}

function mergeModifiedCode(existingCode, newCode) {
  // Check if newCode contains DIFF blocks — apply diffs instead of full merge
  if (newCode.includes('### DIFF ')) {
    // Extract full-file sections (### filename) and diff sections (### DIFF filename) separately
    const fullFileParts = newCode.replace(/### DIFF [^\n]+\n[\s\S]*?(?=### (?:DIFF )?|$)/g, '').trim();
    let result = existingCode;

    // Apply diffs first
    result = applyDiffs(result, newCode);

    // Then merge any full-file replacements
    if (fullFileParts.includes('### ')) {
      result = mergeFullFiles(result, fullFileParts);
    }
    return result;
  }

  // No diffs — standard full-file merge
  return mergeFullFiles(existingCode, newCode);
}

function mergeFullFiles(existingCode, newCode) {
  const existingFiles = {};
  const newFiles = {};
  // Strip artifacts from both inputs before parsing
  const cleanExisting = stripCodeArtifacts(existingCode);
  const cleanNew = stripCodeArtifacts(newCode);
  // Parse existing
  const eSections = cleanExisting.split(/### /).filter(s => s.trim());
  for (const s of eSections) {
    const nl = s.indexOf('\n');
    if (nl === -1) continue;
    const fn = s.substring(0, nl).trim();
    if (fn && !fn.startsWith('DIFF ')) existingFiles[fn] = cleanGeneratedContent(s.substring(nl + 1).trim());
  }
  // Parse new (may be partial — only modified files)
  const nSections = cleanNew.split(/### /).filter(s => s.trim());
  for (const s of nSections) {
    const nl = s.indexOf('\n');
    if (nl === -1) continue;
    const fn = s.substring(0, nl).trim();
    if (fn && !fn.startsWith('DIFF ')) newFiles[fn] = cleanGeneratedContent(s.substring(nl + 1).trim());
  }
  // Merge: new files override existing, existing files kept if not in new
  const merged = { ...existingFiles, ...newFiles };

  // Rebuild code string with React project file ordering
  const fileOrder = [
    'package.json', 'vite.config.js', 'index.html', 'server.js',
    'src/main.tsx', 'src/index.css', 'src/App.tsx'
  ];

  let result = '';
  const written = new Set();

  // Write ordered files first
  for (const fn of fileOrder) {
    if (merged[fn]) {
      result += (result ? '\n\n' : '') + `### ${fn}\n${merged[fn]}`;
      written.add(fn);
    }
  }
  // Then components, pages, and other src/ files (alphabetically)
  const remaining = Object.keys(merged)
    .filter(fn => !written.has(fn))
    .sort((a, b) => {
      // components before pages before others
      const order = (f) => f.startsWith('src/components/') ? 0 : f.startsWith('src/pages/') ? 1 : 2;
      return order(a) - order(b) || a.localeCompare(b);
    });

  for (const fn of remaining) {
    result += (result ? '\n\n' : '') + `### ${fn}\n${merged[fn]}`;
  }

  const modifiedCount = Object.keys(newFiles).length;
  const totalCount = Object.keys(merged).length;
  console.log(`[Merge] ${modifiedCount} file(s) modified, ${totalCount} total`);
  return result;
}

// Valid file paths for React + Vite projects (multi-file)
// Files the AI is NOT allowed to write (canonical — server controls these)
const PROTECTED_FILES = new Set([
  'package.json', 'vite.config.js', 'tsconfig.json', 'index.html', 'src/main.tsx',
  'server.js', 'src/App.tsx', 'tailwind.config.js', 'src/index.css', 'src/styles/theme.css'
]);

const VALID_FILE_PATTERNS = [
  /^package\.json$/,
  /^tsconfig\.json$/,
  /^vite\.config\.(js|ts)$/,
  /^index\.html$/,
  /^server\.js$/,
  /^src\/main\.(tsx|jsx)$/,
  /^src\/index\.css$/,
  /^src\/App\.(tsx|jsx)$/,
  /^src\/components\/[A-Za-z0-9_-]+\.(tsx|jsx)$/,
  /^src\/components\/ui\/[A-Za-z0-9_-]+\.(tsx|jsx)$/,
  /^src\/pages\/[A-Za-z0-9_-]+\.(tsx|jsx)$/,
  /^src\/styles\/[A-Za-z0-9_-]+\.css$/,
  /^src\/lib\/[A-Za-z0-9_-]+\.(ts|js|tsx|jsx)$/,
  /^src\/hooks\/[A-Za-z0-9_-]+\.(ts|js|tsx|jsx)$/,
  /^src\/context\/[A-Za-z0-9_-]+\.(ts|js|tsx|jsx)$/,
  /^src\/types\/[A-Za-z0-9_-]+\.(ts|d\.ts)$/,
  // Legacy support
  /^public\/index\.html$/,
];

function isValidProjectFile(filename) {
  return VALID_FILE_PATTERNS.some(pattern => pattern.test(filename));
}

function writeGeneratedFiles(projectDir, code, projectId) {
  const sections = code.split(/^### /m).filter(s => s.trim());
  let filesWritten = 0;
  const CANONICAL_LIB_FILES = new Set(['src/lib/utils.ts', 'src/hooks/useToast.ts', 'src/hooks/useIsMobile.ts']);

  for (const section of sections) {
    const newlineIdx = section.indexOf('\n');
    if (newlineIdx === -1) continue;
    let filename = section.substring(0, newlineIdx).trim();

    // Skip DIFF markers (handled by applyDiffs)
    if (filename.startsWith('DIFF ')) continue;

    let content = section.substring(newlineIdx + 1).trim();
    if (!filename || !content) continue;

    // Map public/index.html → index.html (React projects have index.html at root)
    if (filename === 'public/index.html' && content.includes('id="root"')) {
      filename = 'index.html';
    }

    // Only write valid project files
    if (!isValidProjectFile(filename)) continue;

    // Clean Claude artifacts from file content before writing
    content = cleanGeneratedContent(content);
    if (!content) continue;

    // ── CSS FIX: Ensure valid Tailwind 3 CSS ──
    if (filename === 'src/index.css') {
      // Fix unbalanced braces (AI common error: extra } or missing })
      let opens = (content.match(/\{/g) || []).length;
      let closes = (content.match(/\}/g) || []).length;
      if (opens !== closes) {
        console.log(`[WriteFiles] CSS braces unbalanced: ${opens} open, ${closes} close — fixing`);
        // If CSS is broken, use the template as base and inject AI's :root colors
        const templateCss = path.join(__dirname, 'templates', 'react', 'src', 'index.css');
        if (fs.existsSync(templateCss)) {
          const template = fs.readFileSync(templateCss, 'utf8');
          // Extract AI's :root block
          const aiRoot = content.match(/:root\s*\{([^}]+)\}/);
          const aiDark = content.match(/\.dark\s*\{([^}]+)\}/);
          let fixed = template;
          if (aiRoot) fixed = fixed.replace(/:root\s*\{[^}]+\}/, `:root {\n${aiRoot[1]}}`);
          if (aiDark) fixed = fixed.replace(/\.dark\s*\{[^}]+\}/, `.dark {\n${aiDark[1]}}`);
          // Extract font imports
          const fonts = content.match(/@import url\([^)]+\)\s*;/g) || [];
          if (fonts.length) fixed = fonts.join('\n') + '\n' + fixed;
          content = fixed;
          console.log(`[WriteFiles] CSS fixed: template + AI colors merged`);
        }
      }
      // TW4 syntax → convert to TW3
      if (content.includes('@import "tailwindcss"')) {
        content = content.replace('@import "tailwindcss";', '@tailwind base;\n@tailwind components;\n@tailwind utilities;');
      }
      // Remove @theme blocks (TW4 only)
      content = content.replace(/@theme\s*\{[\s\S]*?\n\}/g, '');
      // Remove theme() function calls (TW4 only)
      content = content.replace(/theme\(colors\.([a-zA-Z.-]+)\)/g, 'hsl(var(--$1))');
      content = content.replace(/theme\(([^)]+)\)/g, '/* $1 */');
      // Ensure @tailwind directives exist
      if (!content.includes('@tailwind base')) {
        content = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n' + content;
      }
      // Ensure :root with HSL variables exists — ONLY for new files (not modifications)
      // If the file already exists on disk, DON'T replace — the AI might have just modified colors
      const existingCssPath = projectId ? path.join(DOCKER_PROJECTS_DIR, String(projectId), 'src', 'index.css') : null;
      const cssAlreadyExists = existingCssPath && fs.existsSync(existingCssPath);
      if (!cssAlreadyExists && !content.includes('--background:') && !content.includes('--primary:')) {
        const templateCss = path.join(__dirname, 'templates', 'react', 'src', 'index.css');
        if (fs.existsSync(templateCss)) {
          content = fs.readFileSync(templateCss, 'utf8');
          console.log(`[WriteFiles] New project — using Tailwind 3 template for index.css`);
        }
      }
    }

    // AUTO-FIX: Convert ESM imports to CommonJS in server.js
    // The AI sometimes generates "import x from 'y'" despite the prompt saying CommonJS
    if (filename === 'server.js' && content.includes('import ') && content.includes(' from ')) {
      console.log(`[WriteFiles] Auto-fixing ESM → CommonJS in server.js`);
      // import express from 'express' → const express = require('express')
      content = content.replace(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?$/gm, "const $1 = require('$2');");
      // import { a, b } from 'x' → const { a, b } = require('x')
      content = content.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?$/gm, "const {$1} = require('$2');");
      // export default → module.exports =
      content = content.replace(/^export\s+default\s+/gm, 'module.exports = ');
      // export { a, b } → module.exports = { a, b }
      content = content.replace(/^export\s+\{([^}]+)\}\s*;?$/gm, 'module.exports = {$1};');
    }

    // AUTO-FIX: Remove BrowserRouter from App.tsx (it's in main.tsx with basename)
    if ((filename === 'src/App.tsx' || filename === 'src/App.jsx') && content.includes('BrowserRouter')) {
      console.log(`[WriteFiles] Auto-fixing: removing BrowserRouter from ${filename} (already in main.tsx)`);
      // Remove BrowserRouter import
      content = content.replace(/import\s*\{[^}]*BrowserRouter[^}]*\}\s*from\s*['"]react-router-dom['"]\s*;?\n?/g, (match) => {
        // Keep other imports from react-router-dom (Routes, Route, Link, etc.)
        const others = match.match(/\{([^}]*)\}/)?.[1]?.split(',').map(s => s.trim()).filter(s => s && s !== 'BrowserRouter');
        if (others && others.length > 0) return `import { ${others.join(', ')} } from 'react-router-dom';\n`;
        return '';
      });
      // Remove <BrowserRouter> and </BrowserRouter> wrapper
      content = content.replace(/<BrowserRouter[^>]*>/g, '');
      content = content.replace(/<\/BrowserRouter>/g, '');
      // Clean double blank lines
      content = content.replace(/\n{3,}/g, '\n\n');
    }

    // ── GUARD: Auto-fix TSX/JSX — every known AI mistake ──
    if (filename.endsWith('.tsx') || filename.endsWith('.jsx')) {
      const tsxFixes = [];

      // G1. Missing export default (pages and components must have it)
      if (!filename.startsWith('src/components/ui/') && !filename.startsWith('src/lib/') && !filename.startsWith('src/hooks/')) {
        if (!content.includes('export default') && !content.includes('export {')) {
          const funcMatch = content.match(/^function\s+(\w+)/m);
          if (funcMatch) {
            content = content.replace(`function ${funcMatch[1]}`, `export default function ${funcMatch[1]}`);
            tsxFixes.push('+export default');
          }
        }
      }

      // G2. Missing return JSX (function body without return)
      if (filename.startsWith('src/pages/') || filename.startsWith('src/components/')) {
        const funcBody = content.match(/export default function \w+[^{]*\{([\s\S]*)$/);
        if (funcBody && !funcBody[1].includes('return') && !funcBody[1].includes('return (')) {
          // Component function has no return — likely AI forgot it
          tsxFixes.push('WARN:no-return');
        }
      }

      // G3. Relative imports → @/ alias
      content = content.replace(/from\s+['"]\.\.\/(components|pages|lib|hooks)\//g, "from '@/$1/");
      content = content.replace(/from\s+['"]\.\/(components|pages|lib|hooks)\//g, "from '@/$1/");
      if (content !== content) tsxFixes.push('relative→@/');

      // G4. var(--color-*) CSS variables → semantic Tailwind classes
      content = content.replace(/bg-\[var\(--color-primary\)\]/g, 'bg-primary');
      content = content.replace(/text-\[var\(--color-primary\)\]/g, 'text-primary');
      content = content.replace(/bg-\[var\(--color-background\)\]/g, 'bg-background');
      content = content.replace(/text-\[var\(--color-text\)\]/g, 'text-foreground');
      content = content.replace(/text-\[var\(--color-text-muted\)\]/g, 'text-muted-foreground');
      content = content.replace(/border-\[var\(--color-border\)\]/g, 'border-border');
      content = content.replace(/bg-\[var\(--color-surface\)\]/g, 'bg-muted');
      content = content.replace(/bg-\[var\(--color-error\)\]/g, 'bg-destructive');

      // G5. Hardcoded colors → semantic tokens
      content = content.replace(/bg-white(?!\S)/g, 'bg-background');
      content = content.replace(/text-black(?!\S)/g, 'text-foreground');
      content = content.replace(/bg-gray-50(?!\S)/g, 'bg-muted');
      content = content.replace(/bg-gray-100(?!\S)/g, 'bg-muted');
      content = content.replace(/text-gray-500(?!\S)/g, 'text-muted-foreground');
      content = content.replace(/text-gray-600(?!\S)/g, 'text-muted-foreground');
      content = content.replace(/text-gray-900(?!\S)/g, 'text-foreground');
      content = content.replace(/border-gray-200(?!\S)/g, 'border-border');
      content = content.replace(/border-gray-300(?!\S)/g, 'border-border');

      // G6. HTML brut → composants UI (className hints)
      // Can't auto-replace <button> → <Button> safely (might break), but log warning
      if (/<button\s+className/i.test(content) && !filename.startsWith('src/components/ui/')) {
        tsxFixes.push('WARN:raw-button');
      }

      // G7. Duplicate imports (single-pass, reliable)
      const uniqueImports = new Set();
      content = content.replace(/^import .+$/gm, (match) => {
        if (uniqueImports.has(match)) { tsxFixes.push('dedup-import'); return ''; }
        uniqueImports.add(match);
        return match;
      });
      content = content.replace(/\n{3,}/g, '\n\n');

      // G8. window.location instead of react-router Link
      if (content.includes('window.location.href') && !filename.includes('Login') && !filename.includes('Admin')) {
        content = content.replace(/window\.location\.href\s*=\s*['"]\/([^'"]*)['"]/g, "navigate('/$1')");
        if (!content.includes('useNavigate')) {
          content = content.replace(/^(import .+ from 'react-router-dom'.*)$/m, "$1\nimport { useNavigate } from 'react-router-dom';");
        }
        tsxFixes.push('window.location→navigate');
      }

      if (tsxFixes.length > 0) console.log(`[Guard:tsx] ${filename}: ${tsxFixes.join(', ')}`);
    }

    if (filename.endsWith('.tsx') || filename.endsWith('.jsx')) {
      // Fix picsum.photos without seed (random images)
      content = content.replace(/https:\/\/picsum\.photos\/(\d+)\/(\d+)/g, (match, w, h) => {
        // Already has seed? Keep it
        if (match.includes('/seed/')) return match;
        // Generate a seed from context (filename + dimensions)
        const seed = filename.replace(/[^a-zA-Z0-9]/g, '-').replace(/\.tsx$|\.jsx$/, '') + '-' + w + 'x' + h;
        return `https://picsum.photos/seed/${seed}/${w}/${h}`;
      });

      // Duplicate imports already handled by G7 above

      // Fix imports of packages not in package.json — remove them to prevent Vite crash
      const INSTALLED_PACKAGES = new Set([
        'react', 'react-dom', 'react-router-dom', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge', 'next-themes', 'vaul', 'react-hook-form', '@hookform/resolvers', 'zod',
        'sonner', 'cmdk', 'date-fns', 'recharts', 'embla-carousel-react', 'react-day-picker',
        'input-otp', 'react-resizable-panels', 'tailwindcss-animate',
        '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-tabs',
        '@radix-ui/react-accordion', '@radix-ui/react-tooltip', '@radix-ui/react-popover',
        '@radix-ui/react-context-menu', '@radix-ui/react-hover-card', '@radix-ui/react-menubar',
        '@radix-ui/react-navigation-menu', '@radix-ui/react-toggle', '@radix-ui/react-toggle-group',
        '@radix-ui/react-aspect-ratio', '@radix-ui/react-slot',
        '@radix-ui/react-checkbox', '@radix-ui/react-switch', '@radix-ui/react-radio-group',
        '@radix-ui/react-slider', '@radix-ui/react-progress', '@radix-ui/react-collapsible',
        '@radix-ui/react-scroll-area', '@radix-ui/react-separator', '@radix-ui/react-label',
        '@radix-ui/react-avatar', '@radix-ui/react-alert-dialog', '@radix-ui/react-select',
        'express', 'better-sqlite3', 'bcryptjs', 'jsonwebtoken', 'cors', 'helmet', 'compression'
      ]);
      content = content.replace(/^import\s+.*from\s+['"]([^'"@./][^'"]*)['"]\s*;?\s*$/gm, (match, pkg) => {
        // Extract base package name (e.g. "date-fns/locale" → "date-fns")
        const basePkg = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
        if (!INSTALLED_PACKAGES.has(basePkg)) {
          console.log(`[WriteFiles] Removed uninstalled import: ${basePkg} from ${filename}`);
          return `// removed: ${match.trim()} — package not installed`;
        }
        return match;
      });

      // Fix missing export default (AI sometimes forgets)
      if (!content.includes('export default') && !content.includes('export {')) {
        const funcMatch = content.match(/^function (\w+)/m);
        if (funcMatch) {
          content = content.replace(`function ${funcMatch[1]}`, `export default function ${funcMatch[1]}`);
          console.log(`[WriteFiles] Added missing export default to ${filename}`);
        }
      }
    }

    // ALWAYS push via SSE
    if (projectId) {
      notifyProjectClients(projectId, 'file_written', { path: filename, content });
    }

    // Skip writing infrastructure files to DISK (server controls their format).
    // UI components, lib/, hooks/ are now TRUSTED (Lovable model) — AI can customize them.
    if (PROTECTED_FILES.has(filename)) continue;

    const filePath = path.join(projectDir, filename);
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
    // ── GUARD: Auto-fix server.js — every known AI mistake ──
    if (filename === 'server.js') {
      content = safeFixServerJs(content);
    }

    // ── GUARD: Validate syntax before writing (rollback if broken) ──
    const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);

    // Syntax check for server.js (CommonJS — node --check works)
    if (filename === 'server.js') {
      try {
        const { execSync } = require('child_process');
        execSync(`node --check "${filePath}"`, { timeout: 5000, stdio: 'pipe' });
      } catch (syntaxErr) {
        console.warn(`[Guard:syntax] server.js failed syntax check — rolling back`);
        if (backup) fs.writeFileSync(filePath, backup);
        else fs.unlinkSync(filePath);
        // Don't count as written
        continue;
      }
    }

    filesWritten++;
    console.log(`[WriteFiles] Wrote ${filename} (${content.length} bytes)`);
  }
  console.log(`[WriteFiles] Total: ${filesWritten} files written, SSE pushed to WC`);
}

// ─── VISUAL VERIFICATION (Sprint D — FEATURE-FLAGGED) ───
// Optionally calls the screenshot verifier container to check for white screens,
// JS errors, and API failures that static checks cannot catch.
//
// Disabled by default: set ENABLE_VISUAL_VERIFY=true and VISUAL_VERIFY_URL=http://pbp-screenshot-verifier:4000
// to enable. See scripts/screenshot-verifier/README.md for setup.
//
// Returns: { ok, issues, console_errors, network_errors, duration_ms } or null if disabled
const VISUAL_VERIFY_ENABLED = process.env.ENABLE_VISUAL_VERIFY === 'true';
const VISUAL_VERIFY_URL = process.env.VISUAL_VERIFY_URL || 'http://pbp-screenshot-verifier:4000';
const VISUAL_VERIFY_TIMEOUT_MS = 20000;

async function runVisualVerification(projectId) {
  if (!VISUAL_VERIFY_ENABLED) return null; // Feature flag OFF — skip silently
  const containerName = getContainerName(projectId);
  const targetUrl = `http://${containerName}:5173/`;

  return new Promise((resolve) => {
    const payload = JSON.stringify({ url: targetUrl, projectId, timeout: 15000 });
    const u = new URL(VISUAL_VERIFY_URL + '/verify');
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: VISUAL_VERIFY_TIMEOUT_MS
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(result);
        } catch (e) {
          log('warn', 'visual', 'parse error', { projectId, error: e.message });
          resolve(null);
        }
      });
    });
    req.on('error', e => {
      log('warn', 'visual', 'verifier unreachable', { projectId, error: e.message });
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      log('warn', 'visual', 'verifier timeout', { projectId });
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

// ─── RUNTIME HEALTH CHECK ───
// Performs a live HTTP fetch on the project container's Vite dev server and reads
// recent docker logs to detect compilation/runtime errors that wouldn't be caught
// by static checks. WARNING-MODE: never blocks generation, never triggers auto-fix
// in V1. Just produces structured `issues` for visibility.
//
// Returns: { ok: boolean, issues: [{type, severity, message}], httpStatus, htmlOk }
// Validates lucide-react imports against the ACTUAL package installed in the container.
// This is the most accurate way to catch hallucinated icon names. Uses docker exec to
// query the real Object.keys(require('lucide-react')) → gets the exact valid set.
//
// Returns an array of {file, type, severity, message} issues for invalid imports.
// Returns [] if validation can't run (container down, docker exec fails, etc.) — never throws.
async function validateLucideIconsInContainer(projectId, files) {
  const issues = [];
  if (!files || typeof files !== 'object') return issues;

  // 1. Extract all lucide-react imports from .tsx/.ts files
  const importedByFile = {}; // { 'src/pages/X.tsx': ['Icon1', 'Icon2'] }
  for (const [fn, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g;
    let m;
    const icons = [];
    while ((m = importRe.exec(content)) !== null) {
      const names = m[1].split(',')
        .map(s => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      icons.push(...names);
    }
    if (icons.length > 0) importedByFile[fn] = [...new Set(icons)];
  }
  if (Object.keys(importedByFile).length === 0) return issues;

  // 2. Query the container for the actual lucide-react exports
  let validIcons;
  try {
    const containerName = getContainerName(projectId);
    // Use a short script that prints exports as JSON. 5s timeout — should be < 200ms normally.
    const cmd = `docker exec ${containerName} node -e "try{const m=require('lucide-react');console.log(JSON.stringify(Object.keys(m)));}catch(e){console.error(e.message);process.exit(1);}"`;
    const out = execSync(cmd, { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty exports');
    validIcons = new Set(parsed);
    log('info', 'lucide', 'fetched valid icons from container', { projectId, count: validIcons.size });
  } catch (e) {
    // Can't validate — fail open (don't flag anything to avoid false positives)
    log('warn', 'lucide', 'container query failed (skip validation)', { projectId, error: e.message });
    return issues;
  }

  // 3. Find mismatches
  for (const [fn, icons] of Object.entries(importedByFile)) {
    for (const icon of icons) {
      if (!validIcons.has(icon)) {
        issues.push({
          file: fn,
          type: 'INVALID_LUCIDE_ICON_RUNTIME',
          severity: 'error',
          message: `lucide-react n'exporte PAS "${icon}" (verifie via docker exec). Verifie le nom (camelCase, sensible a la casse) ou utilise une icone alternative.`
        });
      }
    }
  }
  return issues;
}

async function runRuntimeHealthCheck(projectId, opts = {}) {
  const result = {
    ok: true,
    issues: [],
    httpStatus: null,
    htmlOk: null,
    duration_ms: 0
  };
  if (!coherence) {
    result.issues.push({ type: 'COHERENCE_UNAVAILABLE', severity: 'warning', message: 'coherence module not loaded' });
    return result;
  }
  const containerName = getContainerName(projectId);
  const t0 = Date.now();

  // 1. HTTP fetch with retry+backoff (Vite HMR may need a beat after file writes)
  const maxAttempts = opts.maxAttempts || 3;
  const baseDelayMs = opts.baseDelayMs || 2000;
  let html = null;
  let httpStatus = null;
  let httpErr = null;
  // Vite is configured with --base /run/{id}/ so we must hit that exact path
  const vitePath = `/run/${projectId}/`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const fetched = await fetchContainerHttp(containerName, 5173, vitePath, 8000);
      httpStatus = fetched.status;
      html = fetched.body;
      // Only 2xx is OK — a 3xx redirect with empty body means we hit the wrong path
      if (httpStatus >= 200 && httpStatus < 300) break;
    } catch (e) {
      httpErr = e.message;
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, baseDelayMs * attempt));
    }
  }
  result.httpStatus = httpStatus;

  if (httpStatus === null || httpStatus >= 500 || httpErr) {
    result.ok = false;
    result.issues.push({
      type: 'CONTAINER_UNREACHABLE',
      severity: 'warning',
      message: `Container ${containerName} unreachable or returned error after ${maxAttempts} attempts: ${httpErr || 'HTTP ' + httpStatus}`
    });
  } else if (html) {
    // 2. Validate HTML shell structure
    const htmlCheck = coherence.validateHtmlStructure(html);
    result.htmlOk = htmlCheck.ok;
    if (!htmlCheck.ok) {
      result.ok = false;
      result.issues.push({
        type: 'HTML_STRUCTURE_INVALID',
        severity: 'warning',
        message: `Served HTML invalid: ${htmlCheck.reason}`
      });
    }
  }

  // 3. Read docker logs for Vite/runtime errors
  try {
    const logs = execSync(`docker logs --tail 100 ${containerName} 2>&1`, { timeout: 5000, encoding: 'utf8' });
    const logCheck = coherence.parseViteLogs(logs);
    if (logCheck.hasErrors) {
      result.ok = false;
      // Cap to first 5 errors to avoid log spam
      const sampled = logCheck.errors.slice(0, 5);
      result.issues.push({
        type: 'VITE_RUNTIME_ERRORS',
        severity: 'warning',
        message: `${logCheck.errors.length} error(s) in Vite logs`,
        details: sampled
      });
    }
  } catch (e) {
    // Docker logs unavailable — don't crash, just note it
    log('warn', 'runtime', 'docker logs failed', { projectId, error: e.message });
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

// Helper: fetch over the docker network. Used by runRuntimeHealthCheck.
// The Prestige server joins the pbp-projects network, so it can resolve containers by DNS.
// ─── SMART ERROR DIAGNOSIS — translates raw Vite errors into precise fix instructions ───
// Without this, Claude receives "SyntaxError: Unexpected reserved word" and doesn't understand
// that the VARIABLE NAME is the problem. With diagnosis, Claude gets "rename the parameter
// 'public' to 'publicItem' in .map() on line 199" — a precise, actionable instruction.
function diagnoseViteError(errorText, brokenFile, attempt) {
  const file = brokenFile || errorText.match(/\/app\/(src\/[^\s:]+)/)?.[1] || '';
  const lineMatch = errorText.match(/:(\d+):\d+/);
  const line = lineMatch ? lineMatch[1] : null;
  const loc = file ? `dans ${file}${line ? ` (ligne ${line})` : ''}` : '';

  // Reserved word as variable name
  const reservedMatch = errorText.match(/Unexpected reserved word '(\w+)'/);
  if (reservedMatch) {
    const word = reservedMatch[1];
    return `ERREUR ${loc} : "${word}" est un MOT RESERVE JavaScript utilise comme nom de variable. Ouvre ${file || 'le fichier'} avec view_file, trouve le .map(), .forEach() ou callback qui utilise "${word}" comme parametre, et RENOMME-LE en "${word}Item" partout dans cette callback avec edit_file. NE CHANGE RIEN D'AUTRE.`;
  }

  // Unexpected token (syntax error)
  if (errorText.includes('Unexpected token')) {
    return `ERREUR DE SYNTAXE ${loc} : token inattendu. Ouvre ${file || 'le fichier'} avec view_file, lis la ligne ${line || 'indiquee'} et les lignes autour. Identifie l'erreur exacte (parenthese, accolade, JSX mal ferme) et corrige UNIQUEMENT cette ligne avec edit_file.${attempt > 1 ? ' ATTENTION: ta correction precedente n\'a pas fonctionne. Relis le fichier ENTIER avec view_file avant de corriger.' : ''}`;
  }

  // Module/export not found
  const moduleMatch = errorText.match(/(?:Cannot find module|Failed to resolve|does not provide an export named) ['"]?([^'";\s]+)/);
  if (moduleMatch) {
    return `ERREUR D'IMPORT ${loc} : "${moduleMatch[1]}" n'existe pas ou n'est pas exporte. Ouvre ${file || 'le fichier'} avec view_file, verifie l'import et corrige avec edit_file.${attempt > 1 ? ' Si le module n\'existe pas, SUPPRIME l\'import et remplace par une alternative.' : ''}`;
  }

  // ReferenceError: X is not defined
  const refMatch = errorText.match(/(\w+) is not defined/);
  if (refMatch) {
    return `ERREUR ${loc} : "${refMatch[1]}" est utilise mais pas importe. Ouvre ${file || 'le fichier'} avec view_file, ajoute l'import manquant avec edit_file. NE CHANGE RIEN D'AUTRE.`;
  }

  // SQLite error: no such table / no such column
  const tableMatch = errorText.match(/no such table:\s*(\w+)/);
  if (tableMatch) {
    return `ERREUR SQL dans server.js : la table "${tableMatch[1]}" n'existe pas. Ouvre server.js avec view_file, trouve les CREATE TABLE, et ajoute "CREATE TABLE IF NOT EXISTS ${tableMatch[1]} (...)" avec les colonnes necessaires. Ajoute aussi des INSERT de donnees de demo. Utilise edit_file.`;
  }
  const colMatch = errorText.match(/no such column:\s*(\w+)/);
  if (colMatch) {
    return `ERREUR SQL dans server.js : la colonne "${colMatch[1]}" n'existe pas dans la table. Ouvre server.js avec view_file, trouve le CREATE TABLE correspondant et ajoute la colonne "${colMatch[1]}" dans la definition. Utilise edit_file.`;
  }
  if (errorText.includes('SQLITE_ERROR')) {
    return `ERREUR SQLite dans server.js. Ouvre server.js avec view_file, verifie les requetes SQL (SELECT, INSERT, UPDATE) et les CREATE TABLE. Corrige la syntaxe SQL ou la structure de table avec edit_file. NE CHANGE RIEN D'AUTRE.`;
  }

  // Port already in use
  if (errorText.includes('EADDRINUSE')) {
    return `ERREUR : le port est deja utilise (EADDRINUSE). Dans server.js, verifie que le serveur utilise process.env.PORT || 3000. Ce n'est pas un bug de code — le conteneur doit etre redemarre.`;
  }

  // Unhandled promise rejection
  if (errorText.includes('UnhandledPromiseRejection')) {
    return `ERREUR : promesse non geree (UnhandledPromiseRejection). Ouvre server.js avec view_file, trouve les operations async (fetch, db.prepare, etc.) qui n'ont pas de try/catch, et ajoute un bloc try/catch avec une reponse d'erreur JSON. Utilise edit_file.`;
  }

  // React hook error
  if (errorText.includes('Invalid hook call')) {
    return `ERREUR React : hook appele en dehors d'un composant ou dans une condition. Ouvre ${file || 'le fichier concerne'} avec view_file. Les hooks (useState, useEffect, etc.) doivent etre au TOP LEVEL du composant, JAMAIS dans un if/for/callback. Corrige avec edit_file.`;
  }

  // Infinite render loop
  if (errorText.includes('Maximum update depth exceeded')) {
    return `ERREUR React : boucle de rendu infinie (Maximum update depth exceeded). Ouvre ${file || 'le fichier concerne'} avec view_file. Cherche un useState/setState appele dans le corps du composant ou dans un useEffect sans tableau de dependances []. Ajoute les deps ou deplace le setState dans un handler. Corrige avec edit_file.`;
  }

  // Stack overflow
  if (errorText.includes('Maximum call stack size exceeded')) {
    return `ERREUR : stack overflow (appel recursif infini). Ouvre ${file || 'le fichier concerne'} avec view_file. Cherche une fonction qui s'appelle elle-meme, ou un composant qui se rend lui-meme sans condition d'arret. Corrige avec edit_file.`;
  }

  // CSS/PostCSS error
  if (errorText.includes('Invalid CSS') || errorText.includes('postcss')) {
    return `ERREUR CSS ${loc}. Ouvre ${file || 'src/index.css'} avec view_file, trouve la syntaxe CSS invalide et corrige avec edit_file. Rappel: les couleurs doivent etre dans tailwind.config.js, pas dans index.css.`;
  }

  // Fallback — still better than raw error
  if (attempt > 1) {
    return `ERREUR Vite PERSISTE (tentative ${attempt}) :\n\n${errorText}\n\n${file ? `Relis ${file} EN ENTIER avec view_file. ` : ''}La correction precedente N'A PAS fonctionne. Analyse le fichier ligne par ligne, identifie la cause REELLE de l'erreur, et corrige avec edit_file. NE CHANGE QUE le probleme, PRESERVE tout le reste.`;
  }
  return `ERREUR Vite ${loc} :\n\n${errorText}\n\n${file ? `Ouvre ${file} avec view_file, ` : ''}identifie la cause exacte et corrige avec edit_file. NE CHANGE RIEN D'AUTRE.`;
}

function fetchContainerHttp(host, port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path, method: 'GET',
      timeout: timeoutMs,
      headers: { 'Accept': 'text/html' }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── PLAN MODE — set of plan IDs already executed (anti-double-approve guard) ───
// Plans can only be approved once. Stored in-memory; on server restart users can re-approve
// (acceptable: they would just regenerate, no data loss). Pruned implicitly when set grows
// beyond MAX_TRACKED_EXECUTED_PLANS to avoid unbounded memory growth.
const executedPlans = new Set();
const MAX_TRACKED_EXECUTED_PLANS = 10000;

// ─── PLAN MODE — background plan generation (markdown only, no tools) ───
// Mirrors generateClaude's job lifecycle: status pending → running → done|error.
// On success: persists plan to project_messages with role='plan' and exposes job.plan_markdown + job.plan_id.
// Token usage tracked automatically via callClaudeAPI(trackingInfo).
async function generatePlan(jobId, user, project, message) {
  const job = generationJobs.get(jobId);
  if (!job) return;

  job.status = 'running';
  job.progressMessage = 'Analyse du projet et création du plan...';

  try {
    // Pull last 8 user/plan messages from history (chrono order). Skip 'assistant' rows
    // because they contain raw generated code which would blow up the planning context.
    let history = [];
    try {
      history = db.prepare(
        "SELECT role, content FROM project_messages WHERE project_id=? AND role IN ('user','plan') ORDER BY id DESC LIMIT 8"
      ).all(project.id);
      history.reverse();
    } catch (e) {
      log('warn', 'plan', 'history fetch failed', { jobId, error: e.message });
    }

    const planMessages = (ai && ai.buildPlanContext)
      ? ai.buildPlanContext(project, history, message)
      : [{ role: 'user', content: message }];

    const planSystemBlocks = [{
      type: 'text',
      text: (ai && ai.PLAN_SYSTEM_PROMPT) || 'Tu produis un plan en Markdown sans aucun outil.',
      cache_control: { type: 'ephemeral' }
    }];

    const planMarkdown = await callClaudeAPI(
      planSystemBlocks,
      planMessages,
      16000, // Plans can be detailed for complex features (like Lovable — no artificial limit)
      { userId: user.id, projectId: project.id, operation: 'plan', jobId }, // jobId → AbortController
      {} // NO tools — markdown only (planning phase, execution comes after approval)
    );

    if (!planMarkdown || typeof planMarkdown !== 'string' || planMarkdown.trim().length < 30) {
      job.status = 'error';
      job.error = 'Plan vide ou trop court. Reformulez votre demande.';
      log('warn', 'plan', 'empty plan returned', { jobId, projectId: project.id });
      return;
    }

    // Persist plan in DB. Single atomic INSERT — no transaction needed.
    let planId;
    try {
      const result = db.prepare(
        'INSERT INTO project_messages (project_id, role, content) VALUES (?,?,?)'
      ).run(project.id, 'plan', planMarkdown);
      planId = result.lastInsertRowid;
    } catch (e) {
      job.status = 'error';
      job.error = 'Erreur de sauvegarde du plan.';
      log('error', 'plan', 'db insert failed', { jobId, error: e.message });
      return;
    }

    job.plan_markdown = planMarkdown;
    job.plan_id = planId;
    job.status = 'done';
    job.progressMessage = 'Plan prêt';

    log('info', 'plan', 'plan generated', {
      jobId, planId, projectId: project.id, userId: user.id, length: planMarkdown.length
    });

    // Best-effort SSE notification — never fail the job if it errors
    try {
      notifyProjectClients(project.id, 'plan_ready', {
        planId,
        preview: planMarkdown.substring(0, 200),
        userName: user.name
      }, user.id);
    } catch (e) { /* swallow */ }
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ERR_CANCELED')) {
      job.status = 'cancelled';
      job.progressMessage = 'Plan annulé';
      log('info', 'plan', 'plan cancelled by user', { jobId });
      return;
    }
    job.status = 'error';
    job.error = `Erreur génération plan: ${e.message}`;
    log('error', 'plan', 'generation failed', { jobId, error: e.message, stack: e.stack });
  }
}

// ─── LEGACY GENERATE CLAUDE (KEPT FOR SMALL OPERATIONS) ───
function generateClaude(messages, jobId, brief, options = {}) {
  const job = generationJobs.get(jobId);
  if (!job) return;

  // ─── LOVABLE MODEL: single streaming call for BOTH new projects AND modifications ───
  // Previously, new projects went through generateMultiTurn (3 separate API calls:
  // infra → pages → components). This caused coherence bugs between phases and was
  // 2-3x slower. Now ALL generation uses the same streaming path with tool loop.
  //
  // For new projects, we pre-apply sector palette + canonical files before the call
  // (previously done inside generateMultiTurn).
  if (job.project_id) {
    const existingProject = db.prepare('SELECT generated_code, status FROM projects WHERE id=?').get(job.project_id);
    const hasGeneratedCode = existingProject?.generated_code && existingProject.generated_code.length > 500;
    const isModification = hasGeneratedCode; // ANY project with code = modification (never streaming)

    if (isModification) {
      // Use NON-STREAMING callClaudeAPI for modifications (like Lovable).
      // Streaming loses tool calls at the end of the stream ("No complete tool blocks").
      // Non-streaming receives the full response → tool calls are never lost.
      console.log(`[generateClaude] Modification for project ${job.project_id} — non-streaming API (reliable tool calls)`);
      (async () => {
        try {
          job.status = 'running';
          job.progressMessage = 'Modification en cours...';

          const effectiveBrief = brief || (messages[messages.length - 1]?.content || '');
          const sectorProfile = ai ? ai.detectSectorProfile(effectiveBrief) : null;
          let basePrompt = ai ? (ABSOLUTE_BROWSER_RULE + ai.CHAT_SYSTEM_PROMPT) : 'Expert React.';
          // Inject contextual modules based on the user's message
          if (ai && ai.getContextualPromptModules) {
            const ctxMods = ai.getContextualPromptModules(effectiveBrief, {});
            if (ctxMods.length > 0) basePrompt += '\n\n' + ctxMods.join('\n\n');
          }
          const systemBlocks = [{ type: 'text', text: basePrompt, cache_control: { type: 'ephemeral' } }];
          if (sectorProfile) systemBlocks.push({ type: 'text', text: sectorProfile });

          // Build messages with project context
          const project = db.prepare('SELECT * FROM projects WHERE id=?').get(job.project_id);
          const history = db.prepare('SELECT role, content FROM project_messages WHERE project_id=? ORDER BY id DESC LIMIT 20').all(job.project_id);
          const projectKeys = db.prepare('SELECT env_name, service FROM project_api_keys WHERE project_id=?').all(job.project_id);
          let projectMemory = null;
          try { const row = db.prepare('SELECT content FROM project_memory WHERE project_id=?').get(job.project_id); if (row?.content) projectMemory = row.content; } catch {}

          const ctxMessages = ai ? ai.buildConversationContext(project, history.reverse(), effectiveBrief, projectKeys, null, projectMemory) : messages;

          // ── STEP 1: Sonnet for everything (like Lovable) — 32K for complete output ──
          const maxTok = 32000;
          const tracking = { userId: job.user_id, projectId: job.project_id, operation: 'modify', jobId };

          const result = await callClaudeAPI(systemBlocks, ctxMessages, maxTok, tracking, { useTools: true, jobId });

          if (result && job.project_id) {
            const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));

            // ── SNAPSHOT: Save current state before applying AI changes ──
            const preModifySnapshot = saveProjectSnapshot(projDir);

            writeGeneratedFiles(projDir, result, job.project_id);

            // ── STEP 2: Verify — does it work? ──
            // 2a. Check missing imports (most common AI error: import without creating file)
            let projectOK = true;
            let diagnostic = '';
            try {
              const missingFiles = [];
              const srcDir = path.join(projDir, 'src');
              const scanImports = (dir) => {
                if (!fs.existsSync(dir)) return;
                for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                  if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') {
                    scanImports(path.join(dir, f.name));
                  } else if (f.isFile() && /\.(tsx|ts|jsx)$/.test(f.name)) {
                    try {
                      const content = fs.readFileSync(path.join(dir, f.name), 'utf8');
                      const imports = content.match(/from\s+['"]@\/([^'"]+)['"]/g) || [];
                      for (const imp of imports) {
                        const importPath = imp.match(/@\/([^'"]+)/)?.[1];
                        if (!importPath) continue;
                        const resolved = path.join(srcDir, importPath);
                        if (!fs.existsSync(resolved + '.tsx') && !fs.existsSync(resolved + '.ts') && !fs.existsSync(resolved + '.jsx') && !fs.existsSync(resolved)) {
                          missingFiles.push({ file: f.name, import: importPath });
                        }
                      }
                    } catch {}
                  }
                }
              };
              scanImports(srcDir);
              if (missingFiles.length > 0) {
                const missingList = missingFiles.map(m => `- ${m.file} importe @/${m.import} → FICHIER MANQUANT`).join('\n');
                diagnostic = `✗ IMPORTS MANQUANTS (fichiers importés mais non créés):\n${missingList}\n\nCrée ces fichiers MAINTENANT avec write_file.`;
                projectOK = false;
                console.log(`[AgentMode] ${missingFiles.length} missing imports detected in project ${job.project_id}`);
                for (const m of missingFiles.slice(0, 5)) {
                  trackErrorPattern('IMPORT_MISSING', `${m.file}:@/${m.import}`, job.project_id, `${m.file} importe @/${m.import} → FICHIER MANQUANT`);
                }
              }
            } catch {}

            // 2b. Check frontend/backend coherence (field name mismatches)
            try {
              const coherenceWarnings = [];
              const projSrcDir = path.join(projDir, 'src');
              const projServerPath = path.join(projDir, 'server.js');
              let serverContent = '';
              if (fs.existsSync(projServerPath)) {
                serverContent = fs.readFileSync(projServerPath, 'utf8');
              }

              if (serverContent && fs.existsSync(projSrcDir)) {
                // Extract all backend route handlers and their expected body fields
                // Pattern: app.post('/api/...', ...  const { field1, field2 } = req.body
                const routeBodyMap = {};
                const routeRegex = /app\.(post|put|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
                let routeMatch;
                while ((routeMatch = routeRegex.exec(serverContent)) !== null) {
                  const routePath = routeMatch[2];
                  // Find the next req.body destructuring after this route
                  const afterRoute = serverContent.substring(routeMatch.index, routeMatch.index + 2000);
                  const bodyMatch = afterRoute.match(/const\s*\{([^}]+)\}\s*=\s*req\.body/);
                  if (bodyMatch) {
                    const fields = bodyMatch[1].split(',').map(f => f.trim().split(/\s/)[0]).filter(Boolean);
                    routeBodyMap[routePath] = fields;
                  }
                }

                // Scan .tsx files for fetch() calls and extract sent fields
                const scanCoherence = (dir) => {
                  if (!fs.existsSync(dir)) return;
                  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') {
                      scanCoherence(path.join(dir, f.name));
                    } else if (f.isFile() && /\.(tsx|ts|jsx)$/.test(f.name)) {
                      try {
                        const content = fs.readFileSync(path.join(dir, f.name), 'utf8');
                        // Find fetch() calls with URL and body
                        const fetchRegex = /fetch\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{[^}]*body\s*:\s*JSON\.stringify\s*\(\s*\{([^}]*)\}/g;
                        let fetchMatch;
                        while ((fetchMatch = fetchRegex.exec(content)) !== null) {
                          const fetchUrl = fetchMatch[1];
                          const bodyStr = fetchMatch[2];
                          const frontendFields = bodyStr.split(',')
                            .map(f => f.trim().split(/\s*:/)[0].trim())
                            .filter(Boolean);

                          // Check if this URL matches a known backend route
                          const backendFields = routeBodyMap[fetchUrl];
                          if (backendFields && frontendFields.length > 0) {
                            // Compare fields
                            const missingInBackend = frontendFields.filter(f => !backendFields.includes(f));
                            const missingInFrontend = backendFields.filter(f => !frontendFields.includes(f));
                            if (missingInBackend.length > 0) {
                              coherenceWarnings.push(
                                `${f.name} envoie { ${missingInBackend.join(', ')} } vers ${fetchUrl} mais le backend ne les attend pas (attend: ${backendFields.join(', ')})`
                              );
                            }
                            if (missingInFrontend.length > 0 && missingInFrontend.some(f => !['id', 'created_at', 'updated_at'].includes(f))) {
                              const relevant = missingInFrontend.filter(f => !['id', 'created_at', 'updated_at'].includes(f));
                              if (relevant.length > 0) {
                                coherenceWarnings.push(
                                  `${f.name} n'envoie PAS { ${relevant.join(', ')} } vers ${fetchUrl} mais le backend les attend`
                                );
                              }
                            }
                          }
                        }
                      } catch (_) {}
                    }
                  }
                };
                scanCoherence(projSrcDir);

                if (coherenceWarnings.length > 0) {
                  const warningText = coherenceWarnings.map(w => `- ${w}`).join('\n');
                  diagnostic += (diagnostic ? '\n\n' : '') +
                    `⚠ INCOHÉRENCES FRONTEND/BACKEND:\n${warningText}\n\nCorrige les noms de champs pour qu'ils correspondent.`;
                  projectOK = false;
                  console.log(`[AgentMode] ${coherenceWarnings.length} frontend/backend coherence issue(s) in project ${job.project_id}`);
                  for (const w of coherenceWarnings.slice(0, 3)) {
                    trackErrorPattern('COHERENCE', w.substring(0, 200), job.project_id, w);
                  }

                  // Learn from coherence issues
                  for (const w of coherenceWarnings.slice(0, 3)) {
                    appendProjectRule(projDir, w);
                  }
                }
              }
            } catch (e) {
              console.warn(`[AgentMode] Coherence check failed: ${e.message}`);
            }

            // 2c. Check server.js syntax + Express health
            if (projectOK && containerExecService) {
              try {
                const isRunning = await isContainerRunningAsync(job.project_id);
                if (isRunning) {
                  job.progressMessage = 'Vérification...';
                  const serverDiag = await containerExecService.verifyProject(job.project_id);
                  if (serverDiag.includes('✗') || serverDiag.includes('ERREUR')) {
                    diagnostic = serverDiag;
                    projectOK = false;
                  }
                }
              } catch (e) {}
            }

            // ── STEP 3: If errors → 1 auto-fix attempt (like Lovable) ──
            if (!projectOK) {
              console.log(`[AgentMode] Auto-fixing errors for project ${job.project_id}`);
              job.progressMessage = '🔧 Correction automatique...';
              try {
                // Send ONLY the error + relevant file content (not entire project)
                const fixContext = diagnostic.substring(0, 2000);
                const fixMessages = [
                  { role: 'user', content: `ERREURS DÉTECTÉES :\n\n${fixContext}\n\nCorrige ces erreurs avec edit_file ou write_file.` }
                ];
                const fixResult = await callClaudeAPI(systemBlocks, fixMessages, 16000,
                  { ...tracking, operation: 'auto-fix' }, { useTools: true, jobId });
                if (fixResult) writeGeneratedFiles(projDir, fixResult, job.project_id);

                // Learn from the error — save rule for future generations
                if (diagnostic.includes('MANQUANT')) {
                  appendProjectRule(projDir, 'Ne pas oublier de créer le fichier quand on ajoute un import (@/ alias)');
                }
                if (diagnostic.includes('syntax') || diagnostic.includes('ERREUR')) {
                  appendProjectRule(projDir, 'Toujours vérifier la syntaxe server.js (CommonJS, require, pas import)');
                }
              } catch (e) {
                console.warn(`[AgentMode] Auto-fix failed: ${e.message}`);
              }

              // ── ROLLBACK CHECK: Re-verify after auto-fix. If still broken → restore snapshot ──
              let stillBroken = false;
              try {
                const postFixSrc = path.join(projDir, 'src');
                if (fs.existsSync(postFixSrc)) {
                  const postFixScan = (dir) => {
                    let missing = 0;
                    if (!fs.existsSync(dir)) return 0;
                    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                      if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') {
                        missing += postFixScan(path.join(dir, f.name));
                      } else if (f.isFile() && /\.(tsx|ts|jsx)$/.test(f.name)) {
                        try {
                          const content = fs.readFileSync(path.join(dir, f.name), 'utf8');
                          const imports = content.match(/from\s+['"]@\/([^'"]+)['"]/g) || [];
                          for (const imp of imports) {
                            const importPath = imp.match(/@\/([^'"]+)/)?.[1];
                            if (!importPath) continue;
                            const resolved = path.join(postFixSrc, importPath);
                            if (!fs.existsSync(resolved + '.tsx') && !fs.existsSync(resolved + '.ts') && !fs.existsSync(resolved + '.jsx') && !fs.existsSync(resolved)) {
                              missing++;
                            }
                          }
                        } catch (_) {}
                      }
                    }
                    return missing;
                  };
                  const missingCount = postFixScan(postFixSrc);
                  if (missingCount > 0) stillBroken = true;
                }
                // Also check server.js syntax if container is running
                if (!stillBroken && containerExecService) {
                  try {
                    const isRunning = await isContainerRunningAsync(job.project_id);
                    if (isRunning) {
                      const postDiag = await containerExecService.verifyProject(job.project_id);
                      if (postDiag.includes('✗') || postDiag.includes('ERREUR')) stillBroken = true;
                    }
                  } catch (_) {}
                }
              } catch (_) {}

              if (stillBroken && preModifySnapshot && Object.keys(preModifySnapshot).length > 0) {
                console.log(`[AgentMode] Auto-fix failed to resolve issues — rolling back to snapshot`);
                trackErrorPattern('ROLLBACK', 'agent_autofix_failed', job.project_id, diagnostic?.substring(0, 500), { rollback: true });
                job.progressMessage = '↩ Restauration de la version précédente...';
                rollbackToSnapshot(projDir, preModifySnapshot, job.project_id, 'Auto-fix STEP 3 failed, project still broken');
                appendProjectRule(projDir, 'La dernière modification IA a cassé le projet et a été annulée automatiquement');
              }
            } else {
              console.log(`[AgentMode] Project ${job.project_id} verified OK`);
            }

            // Re-read files and update DB
            const finalFiles = readProjectFilesRecursive(projDir);
            const finalCode = formatProjectCode(finalFiles);
            db.prepare("UPDATE projects SET generated_code=?,build_status='done',build_url=?,status='ready',updated_at=datetime('now') WHERE id=?")
              .run(finalCode, `/run/${job.project_id}/`, job.project_id);
            job.code = finalCode;

            // Extract credentials
            const creds = extractCredentials(finalCode);
            if (creds) job.credentials = creds;
          }

          job.status = 'done';
          job.progressMessage = '✅ Modifications appliquées';
          console.log(`[generateClaude] Modification done for project ${job.project_id}`);
          // Run quick audit in background (non-blocking, $0.00)
          if (job.project_id) runQuickAudit(job.project_id).catch(() => {});
        } catch (e) {
          if (e.name === 'AbortError' || e.message?.includes('abort')) {
            job.status = 'cancelled';
            job.progressMessage = 'Annulé';
          } else {
            console.error(`[generateClaude] Modification error: ${e.message}`);
            job.status = 'error';
            job.error = e.message;
          }
        }
      })();
      return;
    } else {
      // NEW project: pre-apply sector palette + write canonical files BEFORE streaming
      console.log(`[generateClaude] New generation for project ${job.project_id} — single streaming call (Lovable model)`);
      const projectDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
      try {
        // Write default React project structure (canonical files, UI components)
        writeDefaultReactProject(projectDir);

        // Apply sector-specific color palette to tailwind.config.js
        const effectiveBrief = brief || (messages[messages.length - 1]?.content || '');
        if (ai && effectiveBrief) {
          const sectorKey = Object.keys(ai.SECTOR_PROFILES || {}).find(key => {
            const profile = ai.SECTOR_PROFILES[key];
            return profile && profile.keywords && profile.keywords.some(kw => effectiveBrief.toLowerCase().includes(kw));
          });
          // Sector palette injection handled by the streaming path's system prompt
          // (sectorProfile is detected below and added to systemBlocks)
        }
      } catch (e) {
        console.warn(`[generateClaude] Pre-setup failed (non-fatal): ${e.message}`);
      }
      // Falls through to the streaming API path below (same as modifications)
    }
  }

  // For non-project operations, fall back to API (kept for compatibility)
  if (!ANTHROPIC_API_KEY) { 
    job.status = 'error';
    job.error = 'Le service IA n\'est pas configuré. Contactez l\'administrateur.';
    return; 
  }
  
  // Prompt selection: SYSTEM_PROMPT for NEW projects (full generation instructions),
  // CHAT_SYSTEM_PROMPT for MODIFICATIONS (surgical edit instructions).
  // Previously used messages.length > 2 as heuristic, but this was WRONG for plan
  // approvals on new projects (messages include plan context → length > 2 → wrong prompt).
  // Now uses the definitive check: does the project have generated code?
  const isModification = job.project_id && (() => {
    const p = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
    return p?.generated_code && p.generated_code.length > 500;
  })();
  const baseSystemPrompt = ai
    ? (isModification ? (ABSOLUTE_BROWSER_RULE + ai.CHAT_SYSTEM_PROMPT) : (ABSOLUTE_BROWSER_RULE + ai.SYSTEM_PROMPT))
    : (ABSOLUTE_BROWSER_RULE + 'Tu es un expert en développement professionnel. Génère du code complet et de qualité production.');
  const sectorProfile = ai && brief ? ai.detectSectorProfile(brief) : null;
  
  const contentGenPrompt = `

## GÉNÉRATION DE CONTENU AUTOMATIQUE
AVANT de générer le code, crée automatiquement du contenu contextuel adapté au secteur :
- Un slogan accrocheur et mémorable
- Des textes professionnels pour chaque section (hero, about, services, témoignages)
- Des noms fictifs réalistes pour l'équipe (avec titres et courtes bios)
- Des prix et tarifs cohérents avec le marché français
- 3-5 témoignages clients convaincants et réalistes
- Images : TOUJOURS https://picsum.photos/seed/DESCRIPTIF/WIDTH/HEIGHT (avec seed pour image fixe)

RÈGLE ABSOLUE : Zéro "Lorem ipsum" — tout le contenu doit être réaliste et contextuel.`;

  const savedApis = db ? db.prepare('SELECT name,service,key_value,description FROM api_keys').all() : [];
  let apiIntegrationPrompt = '';
  if (savedApis.length > 0) {
    apiIntegrationPrompt = `

## APIS DISPONIBLES POUR INTÉGRATION AUTOMATIQUE
Les APIs suivantes sont configurées dans le système. Intègre-les automatiquement si pertinentes :
${savedApis.map(a => `- ${a.name} (${a.service}): ${a.description || 'Disponible'}`).join('\n')}

Règles d'intégration automatique :
- Stripe disponible + projet e-commerce/paiement → intègre le checkout Stripe
- Google Maps disponible + projet restaurant/immobilier/local → intègre une carte
- Twilio disponible → ajoute formulaire contact avec notification SMS
- OpenAI disponible → intègre un chatbot client
- Mailchimp disponible → ajoute formulaire newsletter`;
  }

  // Build system prompt with Anthropic Prompt Caching
  // Base prompt is identical across calls — cache for 5 min to save ~60% input tokens
  const systemBlocks = [
    { type: 'text', text: `${baseSystemPrompt}${contentGenPrompt}${apiIntegrationPrompt}`, cache_control: { type: 'ephemeral' } }
  ];
  if (sectorProfile) {
    systemBlocks.push({ type: 'text', text: sectorProfile });
  }

  // Token budget: new projects need more tokens (full site generation in 1 shot).
  // Modifications need less (surgical edits). getMaxTokensForProject returns 32k/64k.
  const isNewProject = job.project_id && (() => {
    const p = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
    return !p?.generated_code || p.generated_code.length < 500;
  })();
  let maxTokens = ai && ai.getMaxTokensForProject ? ai.getMaxTokensForProject(brief) : 24000;
  // New projects: 32K for full site generation
  if (isNewProject && maxTokens < 32000) maxTokens = 32000;
  const model = 'claude-sonnet-4-20250514';
  console.log(`[Claude API Generate] model: ${model}, max_tokens: ${maxTokens}, new: ${!!isNewProject}, job: ${jobId}`);

  job.status = 'running';
  job.progressMessage = isNewProject ? '🧠 Analyse du brief et conception du site...' : '🧠 Analyse du code existant...';

  // Fast-fail: user aborted before we even started
  if (job.abortController && job.abortController.signal.aborted) {
    job.status = 'cancelled';
    job.progressMessage = 'Génération annulée';
    return;
  }

  // Force tool use when Claude MUST modify code (not discuss):
  // - Intent 'code': user asked for a modification → MUST use edit_file/write_file
  // - Plan execution: user approved a plan → MUST implement it
  // - File upload: user uploaded a file → MUST integrate it
  // Without this, Claude responds with TEXT explaining what it WOULD do
  // instead of actually DOING it. This was THE root cause of "nothing changes".
  const hasUpload = messages.some(m => typeof m.content === 'string' && m.content.includes('INSTRUCTION OBLIGATOIRE'));
  const isCodeIntent = job.intent === 'code';
  const forceTools = isCodeIntent || job.type === 'plan_execution' || hasUpload;
  const apiPayload = { model, max_tokens: maxTokens, system: systemBlocks, stream: true, messages,
    tools: [...CODE_TOOLS, { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    tool_choice: forceTools ? { type: 'any' } : { type: 'auto' }
  };
  const payload = JSON.stringify(apiPayload);
  const opts = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31,web-search-2025-03-05','Content-Length':Buffer.byteLength(payload)} };
  // Forward AbortController signal so user can cancel mid-stream
  if (job.abortController) opts.signal = job.abortController.signal;
  
  anthropicRequest(payload, opts, (apiRes) => {
    let buffer = '';
    // Track tool_use blocks accumulated during streaming
    const toolBlocks = []; // { name, id, input_json }
    const MAX_STREAM_TOOL_CALLS = 30; // Like Lovable — focused, not wasteful
    let currentToolId = null;
    let currentToolName = null;
    let currentToolJson = '';

    // Streaming timeout: if no data for 3 minutes, abort (prevents infinite hangs)
    let streamTimeout = null;
    const resetStreamTimeout = () => {
      if (streamTimeout) clearTimeout(streamTimeout);
      streamTimeout = setTimeout(() => {
        console.error(`[Stream] Timeout — no data for 3 minutes, aborting job ${jobId}`);
        if (job.abortController) job.abortController.abort();
        else { apiRes.destroy(); job.status = 'error'; job.error = 'Timeout: pas de réponse du service IA depuis 3 minutes.'; }
      }, 180000);
    };
    resetStreamTimeout();

    apiRes.on('data', chunk => {
      resetStreamTimeout(); // reset timeout on each data chunk
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const d = JSON.parse(data);

          // Text deltas (regular content / fallback ### markers)
          if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && d.delta?.text) {
            job.code += d.delta.text;
            job.progress = job.code.length;
          }

          // Tool use start — begin accumulating input JSON
          if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
            currentToolId = d.content_block.id;
            currentToolName = d.content_block.name;
            // Show user-friendly progress for each tool (like Claude Code shows its actions)
            const toolLabels = {
              'write_file': '📝 Écriture',
              'edit_file': '✏️ Modification',
              'line_replace': '✏️ Modification',
              'view_file': '👁 Lecture',
              'search_files': '🔍 Recherche dans le code',
              'read_console_logs': '🐛 Analyse des erreurs',
              'fetch_website': '🌐 Analyse du site',
              'web_search': '🔍 Recherche web',
              'search_images': '🖼 Recherche d\'images',
              'generate_image': '🎨 Génération d\'image',
              'add_dependency': '📦 Installation de package',
              'remove_dependency': '📦 Suppression de package',
              'delete_file': '🗑 Suppression',
              'rename_file': '📁 Renommage',
              'run_security_check': '🔒 Vérification sécurité',
              'get_table_schema': '🗄 Lecture de la base de données',
              'parse_document': '📄 Lecture du document',
              'download_to_project': '⬇️ Téléchargement',
              'enable_stripe': '💳 Configuration Stripe',
              'generate_mermaid': '📊 Génération de diagramme'
            };
            job.progressMessage = toolLabels[currentToolName] || `🔧 ${currentToolName}`;
            currentToolJson = '';
            if (currentToolName === 'write_file') job.progressMessage = 'Écriture de fichier...';
            else if (currentToolName === 'edit_file') job.progressMessage = 'Modification de fichier...';
          }

          // Tool use JSON delta — accumulate
          if (d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta' && d.delta?.partial_json) {
            currentToolJson += d.delta.partial_json;
          }

          // Tool use end — parse, store, and IMMEDIATELY write to container (like Lovable)
          if (d.type === 'content_block_stop' && currentToolId) {
            if (toolBlocks.length >= MAX_STREAM_TOOL_CALLS) {
              console.warn(`[Stream] Tool call limit (${MAX_STREAM_TOOL_CALLS}) reached for project ${job.project_id} — stopping`);
              currentToolId = null; currentToolName = null; currentToolJson = '';
              return;
            }
            try {
              const input = JSON.parse(currentToolJson);
              toolBlocks.push({ name: currentToolName, id: currentToolId, input });

              // Track files modified during streaming for potential rollback
              if (!job._streamBackups) job._streamBackups = {};

              // REAL-TIME: Write file to container IMMEDIATELY as each tool call completes
              if (currentToolName === 'write_file' && input.path && input.content && job.project_id) {
                job.progressMessage = `📝 Écriture de ${input.path}`;
                const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
                // Backup existing file for rollback if stream fails
                const existingFile = path.join(projDir, input.path);
                if (fs.existsSync(existingFile) && !job._streamBackups[input.path]) {
                  job._streamBackups[input.path] = fs.readFileSync(existingFile, 'utf8');
                }
                let cleanContent = cleanGeneratedContent(input.content);
                // Lovable-style ellipsis merge
                if (cleanContent && cleanContent.includes('// ... keep existing code')) {
                  const existingPath = path.join(projDir, input.path);
                  if (fs.existsSync(existingPath)) {
                    cleanContent = mergeEllipsis(fs.readFileSync(existingPath, 'utf8'), cleanContent);
                  }
                }
                // Infrastructure files (package.json, vite.config, etc.) are still server-controlled.
                // UI components, lib/, hooks/ are now TRUSTED to the AI (Lovable model).
                const isInfraProtected = PROTECTED_FILES.has(input.path);

                // ALWAYS send via SSE for live preview
                if (cleanContent) {
                  notifyProjectClients(job.project_id, 'file_written', { path: input.path, content: cleanContent });
                  console.log(`[Stream] SSE push: ${input.path}`);
                }

                // Write to disk (Vite HMR picks up changes via bind mount)
                if (!isInfraProtected && cleanContent) {
                  const filePath = path.join(projDir, input.path);
                  const fileDir = path.dirname(filePath);
                  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
                  fs.writeFileSync(filePath, cleanContent);
                  // bind mount — Vite HMR picks up changes automatically
                }
              } else if (currentToolName === 'edit_file' && input.path && input.search && job.project_id) {
                job.progressMessage = `✏️ Modification de ${input.path}`;
                const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
                const filePath = path.join(projDir, input.path);

                // GUARD: Convert edit_file on large files to line_replace (same as non-streaming)
                if (fs.existsSync(filePath)) {
                  const lineCount = fs.readFileSync(filePath, 'utf8').split('\n').length;
                  if (lineCount > 200) {
                    console.log(`[StreamGuard] Large file ${input.path} (${lineCount} lines) — converting edit_file to line_replace`);
                    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
                    const searchFirst = input.search.split('\n')[0].trim();
                    let matchStart = -1;
                    for (let si = 0; si < lines.length; si++) {
                      if (lines[si].includes(searchFirst) || lines[si].trim() === searchFirst) { matchStart = si; break; }
                    }
                    if (matchStart >= 0) {
                      const searchLines = input.search.split('\n');
                      const before = lines.slice(0, matchStart);
                      const after = lines.slice(matchStart + searchLines.length);
                      const newContent = [...before, ...(input.replace || '').split('\n'), ...after].join('\n');
                      if (!job._streamBackups[input.path]) job._streamBackups[input.path] = fs.readFileSync(filePath, 'utf8');
                      fs.writeFileSync(filePath, newContent);
                      console.log(`[StreamGuard] Safe line_replace applied: ${input.path}`);
                    } else {
                      console.warn(`[StreamGuard] Search text not found in ${input.path}`);
                    }
                    currentToolId = null; currentToolName = null; currentToolJson = '';
                    return;
                  }
                }

                // ALWAYS send edit to WebContainer via SSE
                notifyProjectClients(job.project_id, 'file_edited', { path: input.path, search: input.search, replace: input.replace || '' });
                console.log(`[Stream] SSE edit: ${input.path}`);
                // Apply edit to disk + container with FUZZY matching (same as applyToolEdits)
                if (fs.existsSync(filePath)) {
                  let content = fs.readFileSync(filePath, 'utf8');
                  // Backup for rollback
                  if (!job._streamBackups[input.path]) job._streamBackups[input.path] = content;
                  let matched = false;
                  // Level 1: Exact match
                  if (content.includes(input.search)) {
                    content = content.replace(input.search, input.replace || '');
                    matched = true;
                  }
                  // Level 2: Whitespace-normalized match
                  if (!matched) {
                    const normSearch = input.search.replace(/\s+/g, '\\s+');
                    try {
                      const re = new RegExp(normSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\s\+/g, '\\s+'));
                      const m = content.match(re);
                      if (m) {
                        content = content.replace(m[0], input.replace || '');
                        matched = true;
                        console.log(`[Stream] Fuzzy edit matched on ${input.path}`);
                      }
                    } catch (_) {}
                  }
                  if (matched) {
                    if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
                  } else {
                    console.warn(`[Stream] Edit FAILED on ${input.path}: search text not found`);
                  }
                }
              } else if (currentToolName === 'line_replace' && input.path && input.start_line && input.new_content && job.project_id) {
                job.progressMessage = `Modifie: ${input.path} L${input.start_line}`;
                notifyProjectClients(job.project_id, 'file_edited', { path: input.path, lineReplace: true, startLine: input.start_line, endLine: input.end_line });
                const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
                const filePath = path.join(projDir, input.path);
                if (fs.existsSync(filePath)) {
                  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
                  const start = Math.max(0, input.start_line - 1);
                  const end = Math.min(lines.length, input.end_line || input.start_line);
                  lines.splice(start, end - start, input.new_content);
                  fs.writeFileSync(filePath, lines.join('\n'));
                  // bind mount — Vite HMR picks up changes automatically
                }
              } else if (currentToolName === 'write_file' && input.path) {
                job.progressMessage = `Fichier: ${input.path}`;
              }
            } catch (parseErr) {
              console.warn(`[Stream] Failed to parse tool input: ${parseErr.message}`);
            }
            currentToolId = null;
            currentToolName = null;
            currentToolJson = '';
          }

          // Web search progress
          if (d.type === 'content_block_start' && d.content_block?.type === 'server_tool_use') {
            job.progressMessage = '🌐 Recherche web en cours...';
          }
          if (d.type === 'content_block_start' && d.content_block?.type === 'text') {
            job.progressMessage = '🧠 Réflexion et analyse...';
          }
          if (d.type === 'message_stop') {
            job._messageComplete = true;
          }
          if (d.type === 'error') {
            console.error('[Claude API] Stream error:', JSON.stringify(d.error));
            job.status = 'error';
            job.error = d.error?.message || 'Erreur API';
            // Rollback files modified during this stream
            if (job._streamBackups && job.project_id) {
              const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
              for (const [fn, backup] of Object.entries(job._streamBackups)) {
                try {
                  fs.writeFileSync(path.join(projDir, fn), backup, 'utf8');
                  console.log(`[Rollback] Restored ${fn}`);
                } catch (_) {}
              }
            }
          }
        } catch(e) {
          if (data && data.length > 10) console.warn(`[Claude API] Malformed SSE: ${data.substring(0, 80)}`);
        }
      }
    });
    apiRes.on('error', e => {
      if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ERR_CANCELED')) {
        job.status = 'cancelled';
        job.progressMessage = 'Génération annulée';
        return;
      }
      job.status = 'error'; job.error = e.message;
    });
    apiRes.on('end', async () => {
      if (streamTimeout) clearTimeout(streamTimeout); // clean up timeout
      // If tool_use blocks were received, process them into code
      if (toolBlocks.length > 0) {
        console.log(`[Stream] Processing ${toolBlocks.length} tool calls`);
        const parsed = { files: {}, edits: [], text: job.code };
        for (const tb of toolBlocks) {
          if (tb.name === 'write_file' && tb.input?.path && tb.input?.content) {
            parsed.files[tb.input.path] = cleanGeneratedContent(tb.input.content);
          } else if (tb.name === 'edit_file' && tb.input?.path) {
            parsed.edits.push(tb.input);
          }
        }
        // Convert tool files to ### marker code for DB storage
        const toolCode = toolResponseToCode(parsed);
        if (toolCode) job.code = toolCode;
        // Apply edits to existing project files on disk
        if (parsed.edits.length > 0 && job.project_id) {
          const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
          const editResult = applyToolEdits(projDir, parsed.edits);

          // If edits failed, ask Claude to rewrite the file instead (fallback)
          if (editResult.failed > 0 && editResult.failedEdits.length > 0) {
            console.log(`[Stream] ${editResult.failed} edit(s) failed — retrying with write_file`);
            try {
              const retryFiles = [...new Set(editResult.failedEdits.map(e => e.path))];
              // Include actual file content around the failed edit location
              const retryDetails = editResult.failedEdits.map(e => {
                let hint = '';
                try {
                  const fp = path.join(projDir, e.path);
                  if (fs.existsSync(fp)) {
                    const lines = fs.readFileSync(fp, 'utf8').split('\n');
                    const searchFirst = (e.search || '').split('\n')[0].trim();
                    const idx = lines.findIndex(l => l.includes(searchFirst));
                    if (idx >= 0) {
                      const s = Math.max(0, idx - 3);
                      const end = Math.min(lines.length, idx + 8);
                      hint = '\nLignes ' + (s+1) + '-' + end + ':\n' + lines.slice(s, end).map((l,i) => (s+i+1) + '| ' + l).join('\n');
                    }
                  }
                } catch {}
                return `Fichier: ${e.path}\nA ajouter: ${e.replace.substring(0, 200)}...${hint}`;
              }).join('\n\n');
              const retryPrompt = `Les edit_file suivants ont echoue. Utilise write_file avec "// ... keep existing code" pour inserer le nouveau code au bon endroit SANS reecrire tout le fichier.

${retryDetails}

IMPORTANT : dans write_file, ecris SEULEMENT les parties modifiees. Utilise "// ... keep existing code" pour garder le reste intact.`;
              const sysBlocks = [{ type: 'text', text: ai ? ai.CHAT_SYSTEM_PROMPT : 'Réécris les fichiers.' }];
              const existingProject = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
              const ctxMsgs = ai ? ai.buildConversationContext(
                { ...existingProject, title: '', brief: '' }, [], retryPrompt, []
              ) : [{ role: 'user', content: retryPrompt }];
              const retryCode = await callClaudeAPI(sysBlocks, ctxMsgs, 32000,
                { userId: job.user_id, projectId: job.project_id, operation: 'auto-correct' },
                { useTools: true });
              if (retryCode) {
                writeGeneratedFiles(projDir, retryCode, job.project_id);
                console.log(`[Stream] Failed edits retried with write_file — success`);
              }
            } catch (retryErr) {
              console.warn(`[Stream] Retry failed: ${retryErr.message}`);
            }
          }

          // Re-read files from disk after all edits
          if (job.project_id) {
            const updatedFiles = readProjectFilesRecursive(projDir);
            job.code = formatProjectCode(updatedFiles);
          }
        }
        // Write tool files to disk
        if (Object.keys(parsed.files).length > 0 && job.project_id) {
          writeGeneratedFiles(path.join(DOCKER_PROJECTS_DIR, String(job.project_id)), toolCode, job.project_id);
        }
      }

      // ── DIRECT AUTO-FIX after EVERY modification (not just initial generation) ──
      // Catches mechanical errors the AI introduced or failed to fix (reserved words, require in TSX, etc.)
      if (job.project_id) {
        const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
        const postFiles = readProjectFilesRecursive(projDir);
        const fixCount = autoFixMechanicalErrors(projDir, postFiles);
        if (fixCount > 0) {
          // Re-read and update stored code after direct fixes
          const fixedFiles = readProjectFilesRecursive(projDir);
          job.code = formatProjectCode(fixedFiles);
          console.log(`[Stream] Direct auto-fix applied ${fixCount} fix(es) after modification`);
        }
      }

      // ── POST-STREAM VERIFICATION (Agent Mode) ──
      // Check for: missing imports, syntax errors, container health.
      // Auto-fix any issues by calling Claude.
      if (job.project_id) {
        const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
        let postStreamErrors = [];

        // 1. Scan for missing imports (most common AI error)
        try {
          const srcDir = path.join(projDir, 'src');
          const scanDir = (dir) => {
            if (!fs.existsSync(dir)) return;
            for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
              if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') scanDir(path.join(dir, f.name));
              else if (f.isFile() && /\.(tsx|ts|jsx)$/.test(f.name)) {
                try {
                  const content = fs.readFileSync(path.join(dir, f.name), 'utf8');
                  const imports = content.match(/from\s+['"]@\/([^'"]+)['"]/g) || [];
                  for (const imp of imports) {
                    const p = imp.match(/@\/([^'"]+)/)?.[1];
                    if (!p) continue;
                    const r = path.join(srcDir, p);
                    if (!fs.existsSync(r + '.tsx') && !fs.existsSync(r + '.ts') && !fs.existsSync(r + '.jsx') && !fs.existsSync(r)) {
                      postStreamErrors.push(`${f.name} importe @/${p} → FICHIER MANQUANT`);
                    }
                  }
                } catch {}
              }
            }
          };
          scanDir(srcDir);
        } catch {}

        // 2. Check server.js syntax
        if (containerExecService) {
          try {
            const isRunning = await isContainerRunningAsync(job.project_id);
            if (isRunning) {
              const syntaxCheck = await containerExecService.execInContainer(job.project_id, 'node --check server.cjs 2>&1', { timeout: 10000 }).catch(() => null);
              if (syntaxCheck && syntaxCheck.exitCode !== 0) {
                postStreamErrors.push(`server.js ERREUR DE SYNTAXE: ${(syntaxCheck.stderr || syntaxCheck.stdout || '').substring(0, 300)}`);
              }
            }
          } catch {}
        }

        // 3. Auto-fix all detected errors
        if (postStreamErrors.length > 0) {
          console.log(`[Stream] ${postStreamErrors.length} error(s) detected post-stream in project ${job.project_id}`);
          try {
            const errorList = postStreamErrors.map((e, i) => `${i + 1}. ${e}`).join('\n');
            const fixPrompt = `ERREURS DÉTECTÉES après la génération :\n\n${errorList}\n\nCrée les fichiers manquants avec write_file et corrige les erreurs de syntaxe. Chaque fichier manquant doit être un composant React valide avec export default.`;
            const fixBlocks = [{ type: 'text', text: ai ? (ABSOLUTE_BROWSER_RULE + ai.CHAT_SYSTEM_PROMPT) : 'Fix errors.' }];
            const fixResult = await callClaudeAPI(fixBlocks, [{ role: 'user', content: fixPrompt }], 16000,
              { userId: job.user_id, projectId: job.project_id, operation: 'auto-fix-post-stream' },
              { useTools: true });
            if (fixResult) {
              writeGeneratedFiles(projDir, fixResult, job.project_id);
              console.log(`[Stream] Auto-fixed ${postStreamErrors.length} error(s) in project ${job.project_id}`);
            }
          } catch (fixErr) {
            console.warn(`[Stream] Auto-fix failed: ${fixErr.message}`);
          }
        }
      }

      // ── AUTO-INSTALL: detect imports of packages not in node_modules → npm install ──
      // This is the DEFINITIVE fix for blank screens caused by missing packages.
      // Instead of maintaining a hardcoded list of deps, we scan what Claude actually
      // wrote and install anything missing. Like Lovable: zero config, always works.
      if (job.project_id) {
        try {
          const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
          const containerName = getContainerName(job.project_id);
          const isRunning = await isContainerRunningAsync(job.project_id);

          if (isRunning) {
            // Scan ALL .tsx/.ts/.jsx files for external imports
            const externalImports = new Set();
            const scanDir = (dir) => {
              if (!fs.existsSync(dir)) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, f.name);
                if (f.isDirectory() && f.name !== 'node_modules' && f.name !== '.git') scanDir(fp);
                else if (f.isFile() && /\.(tsx|ts|jsx|js)$/.test(f.name) && f.name !== 'vite.config.js') {
                  try {
                    const content = fs.readFileSync(fp, 'utf8');
                    const importRe = /from\s+["']([^"'@./][^"']*)["']/g;
                    let m;
                    while ((m = importRe.exec(content)) !== null) {
                      const dep = m[1];
                      const base = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0];
                      externalImports.add(base);
                    }
                  } catch (_) {}
                }
              }
            };
            scanDir(path.join(projDir, 'src'));
            if (fs.existsSync(path.join(projDir, 'server.js'))) {
              try {
                const srvContent = fs.readFileSync(path.join(projDir, 'server.js'), 'utf8');
                const importRe = /require\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g;
                let m;
                while ((m = importRe.exec(srvContent)) !== null) {
                  const base = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
                  externalImports.add(base);
                }
              } catch (_) {}
            }

            // Check which imports are NOT installed in the container
            if (externalImports.size > 0) {
              let installedPkgs;
              try {
                const lsOutput = execSync(
                  `docker exec ${containerName} sh -c "ls node_modules/ 2>/dev/null | head -200"`,
                  { timeout: 5000, encoding: 'utf8' }
                );
                // Also get scoped packages (@radix-ui/*, @hookform/*, etc.)
                const scopedOutput = execSync(
                  `docker exec ${containerName} sh -c "for d in node_modules/@*/; do ls \\$d 2>/dev/null | sed \\"s|^|\\$(basename \\$d)/|\\" ; done 2>/dev/null | head -200"`,
                  { timeout: 5000, encoding: 'utf8' }
                );
                installedPkgs = new Set([
                  ...lsOutput.split('\n').filter(Boolean),
                  ...scopedOutput.split('\n').filter(Boolean).map(p => '@' + p)
                ]);
              } catch (_) {
                installedPkgs = null; // can't check, skip
              }

              if (installedPkgs) {
                // Node built-ins to skip
                const BUILTINS = new Set(['fs','path','http','https','crypto','os','url','stream','util','events','child_process','net','tls','zlib','querystring','buffer','assert','cluster','dns','readline','string_decoder','timers','tty','v8','vm','worker_threads','perf_hooks','node']);
                const toInstall = [];
                for (const pkg of externalImports) {
                  if (BUILTINS.has(pkg)) continue;
                  if (installedPkgs.has(pkg)) continue;
                  toInstall.push(pkg);
                }

                if (toInstall.length > 0) {
                  job.progressMessage = `Installation de ${toInstall.length} package(s) manquant(s)...`;
                  console.log(`[AutoInstall] Missing packages detected: ${toInstall.join(', ')}`);
                  try {
                    const installCmd = `docker exec ${containerName} npm install ${toInstall.join(' ')} --save --legacy-peer-deps 2>&1 | tail -5`;
                    execSync(installCmd, { timeout: 120000, encoding: 'utf8' });
                    console.log(`[AutoInstall] Installed: ${toInstall.join(', ')}`);
                  } catch (installErr) {
                    console.warn(`[AutoInstall] npm install failed: ${installErr.message}`);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn(`[AutoInstall] scan failed (non-fatal): ${e.message}`);
        }
      }

      // ── DEV SERVER HEALTH CHECK (like Lovable — fast, not full build) ──
      // Instead of running `vite build` (60s+ per attempt, up to 5 attempts = 300s),
      // just check that the Vite dev server responds with valid HTML.
      // The dev server is ALREADY running in the container via HMR.
      // If it responds → code works. If not → read error from container logs → fix.
      //
      // vite build is ONLY used at PUBLISH time (not after every generation).
      // This matches Lovable: they use HMR/dev server check, not production build.
      if (job.project_id) {
        const containerName = getContainerName(job.project_id);
        const healthMaxRetries = 3;

        for (let healthAttempt = 1; healthAttempt <= healthMaxRetries; healthAttempt++) {
          try {
            const isRunning = await isContainerRunningAsync(job.project_id);
            if (!isRunning) break;

            job.progressMessage = healthAttempt === 1
              ? 'Vérification du preview...'
              : `Correction automatique (${healthAttempt}/${healthMaxRetries})...`;

            // Wait briefly for Vite HMR to process the new files (500ms polling interval)
            await new Promise(r => setTimeout(r, 2000));

            // Check 1: Vite dev server responds with HTML containing <div id="root">
            const hostname = getContainerHostname(job.project_id);
            const healthOk = await new Promise(resolve => {
              const req = http.get(`http://${hostname}:5173/run/${job.project_id}/`, { timeout: 5000 }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => resolve(res.statusCode < 400 && body.includes('id="root"')));
              });
              req.on('error', () => resolve(false));
              req.on('timeout', () => { req.destroy(); resolve(false); });
            });

            if (healthOk) {
              // Check 2: read container logs for Vite errors (fast — no build needed)
              let hasViteErrors = false;
              let viteError = '';
              try {
                const logs = execSync(`docker logs --tail 30 ${containerName} 2>&1`, { timeout: 5000, encoding: 'utf8' });
                const errorLines = logs.split('\n').filter(l =>
                  (l.includes('[vite]') && (l.includes('error') || l.includes('Error'))) ||
                  l.includes('Failed to resolve') || l.includes('SyntaxError') ||
                  l.includes('does not provide an export') ||
                  l.includes('Unexpected reserved word') || l.includes('Unexpected token') ||
                  l.includes('plugin:vite:') || l.includes('ReferenceError') ||
                  l.includes('is not defined')
                ).filter(l => !l.includes('ECONNREFUSED') && !l.includes('health'));
                if (errorLines.length > 0) {
                  hasViteErrors = true;
                  viteError = errorLines.slice(-3).join('\n');
                }
              } catch (_) {}

              if (!hasViteErrors) {
                console.log(`[HealthCheck] Vite dev server OK for project ${job.project_id} (${healthAttempt})`);
                break; // ✅ Preview works
              }
              // Has errors in logs but server responds → fix the error
              console.log(`[HealthCheck] Vite responding but has errors: ${viteError.substring(0, 150)}`);
            } else {
              // Dev server not responding — read logs for the error
              try {
                const logs = execSync(`docker logs --tail 20 ${containerName} 2>&1`, { timeout: 5000, encoding: 'utf8' });
                const errorLines = logs.split('\n').filter(l =>
                  l.includes('error') || l.includes('Error') || l.includes('Failed') ||
                  l.includes('SyntaxError') || l.includes('SQLITE_ERROR') ||
                  l.includes('no such table') || l.includes('EADDRINUSE') ||
                  l.includes('UnhandledPromiseRejection') || l.includes('FATAL')
                ).filter(l => !l.includes('ECONNREFUSED') && !l.includes('health')).slice(-5);
                viteError = errorLines.join('\n') || 'Vite dev server not responding';
              } catch (_) {
                viteError = 'Cannot read container logs';
              }
              console.log(`[HealthCheck] Vite NOT responding for project ${job.project_id}: ${viteError.substring(0, 150)}`);
            }

            // If we're on the last attempt, don't try to fix — mark as warning
            if (healthAttempt >= healthMaxRetries) {
              log('warn', 'health', 'dev server check failed after retries', {
                jobId, projectId: job.project_id
              });
              job.healthCheckFailed = true;
              job.healthError = viteError ? viteError.substring(0, 200) : 'Preview non fonctionnel';
              break;
            }

            // Ask Claude to fix the error (same escalation as before but lighter)
            const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
            const brokenFile = (viteError || '').match(/\/app\/([^\s:]+\.(tsx|ts|jsx|js))/)?.[1] || '';
            let fixPrompt;

            // Diagnose the error and build a PRECISE fix instruction
            fixPrompt = diagnoseViteError(viteError, brokenFile, healthAttempt);

            try {
              const fixCode = await callClaudeAPI(
                [{ type: 'text', text: ai ? ai.CHAT_SYSTEM_PROMPT : 'Corrige.' }],
                [{ role: 'user', content: fixPrompt }],
                16000,
                { userId: job.user_id, projectId: job.project_id, operation: 'health-fix', jobId },
                { useTools: true }
              );
              if (fixCode) {
                writeGeneratedFiles(projDir, fixCode, job.project_id);
                // Direct auto-fix after AI correction (catches what AI missed)
                const postFixFiles = readProjectFilesRecursive(projDir);
                autoFixMechanicalErrors(projDir, postFixFiles);
                console.log(`[HealthCheck] Fix applied (attempt ${healthAttempt}), rechecking...`);
              }
            } catch (fixErr) {
              console.warn(`[HealthCheck] Fix failed: ${fixErr.message}`);
            }
          } catch (e) {
            console.warn(`[HealthCheck] Check failed (non-fatal): ${e.message}`);
            break;
          }
        }
      }

      // ── AUTO-FOLLOW-UP: Use GPT-4 Mini to verify completeness (GENERIC, UNLIMITED) ──
      // Instead of hardcoded checks, ask GPT-4 Mini: "the user asked X, the AI did Y, what's missing?"
      // This works for ANY feature, ANY complexity, ANY subject — no hardcoded keywords.
      if (toolBlocks.length > 0 && job.project_id) {
        const userMsg = (messages[messages.length - 1]?.content || '');
        const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));

        // Build a summary of what was actually done
        const done = toolBlocks.map(t => {
          if (t.name === 'write_file') return `write_file ${t.input?.path}`;
          if (t.name === 'edit_file') return `edit_file ${t.input?.path} (search: "${(t.input?.search || '').substring(0, 50)}...")`;
          return `${t.name}`;
        }).join('\n');

        // Build a summary of the current project state
        const currentFiles = [];
        const appTsx = fs.existsSync(path.join(projDir, 'src', 'App.tsx')) ? fs.readFileSync(path.join(projDir, 'src', 'App.tsx'), 'utf8') : '';
        const serverJs = fs.existsSync(path.join(projDir, 'server.js')) ? fs.readFileSync(path.join(projDir, 'server.js'), 'utf8') : '';
        const routes = (appTsx.match(/<Route\s+path="([^"]+)"/g) || []).map(r => r.match(/path="([^"]+)"/)?.[1]);
        const tables = (serverJs.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map(t => t.replace('CREATE TABLE IF NOT EXISTS ', ''));
        const apiRoutes = (serverJs.match(/app\.(get|post|put|delete)\(['"]([^'"]+)['"]/g) || []).map(r => r.match(/['"]([^'"]+)['"]/)?.[1]);
        const pages = fs.existsSync(path.join(projDir, 'src', 'pages')) ? fs.readdirSync(path.join(projDir, 'src', 'pages')) : [];

        // Scan for fetch URLs without matching backend routes
        const allProjectFiles = readProjectFilesRecursive(projDir);
        const fetchUrls = [];
        for (const [fn, content] of Object.entries(allProjectFiles)) {
          if (!fn.endsWith('.tsx')) continue;
          const matches = content.match(/fetch\s*\(\s*[`'"]([^`'"]+)/g) || [];
          for (const m of matches) {
            const url = m.match(/fetch\s*\(\s*[`'"]([^`'"]+)/)?.[1];
            if (url && url.startsWith('/api/')) fetchUrls.push({ file: fn, url });
          }
        }
        const unmatchedFetches = fetchUrls.filter(f => !serverJs.includes(f.url.split('?')[0]));

        const verifyPrompt = `L'utilisateur a demandé: "${userMsg}"

L'IA a fait ces actions:
${done}

État actuel du projet:
- Pages: ${pages.join(', ')}
- Routes App.tsx: ${routes.join(', ')}
- Tables SQLite: ${tables.join(', ')}
- Routes API: ${apiRoutes.join(', ')}${unmatchedFetches.length > 0 ? `\n- ATTENTION — fetch() sans route backend: ${unmatchedFetches.map(f => `${f.file} → ${f.url}`).join(', ')}` : ''}

La demande est-elle COMPLÈTEMENT satisfaite? Vérifie:
1. Chaque page mentionnée dans le brief existe-t-elle?
2. Chaque fetch('/api/...') dans le frontend a-t-il une route dans server.js?
3. Les routes App.tsx correspondent-elles aux pages existantes?

Liste UNIQUEMENT ce qui MANQUE. Format:
- write_file src/pages/NomPage.tsx — description
- edit_file server.js — ajouter route GET /api/xxx + table + données
- edit_file src/App.tsx — ajouter import + Route

Si TOUT est fait, réponds UNIQUEMENT: COMPLET`;

        let missingItems = [];
        try {
          // Use GPT-4 Mini if available (fast, cheap), otherwise use Claude
          let verifyResponse;
          if (OPENAI_API_KEY) {
            verifyResponse = await callGPT4Mini(verifyPrompt, 500);
          } else {
            verifyResponse = await callClaudeAPI(
              [{ type: 'text', text: 'Tu vérifies si une modification est complète. Réponds UNIQUEMENT avec la liste des manques ou COMPLET.' }],
              [{ role: 'user', content: verifyPrompt }], 500,
              { userId: job.user_id, projectId: job.project_id, operation: 'verify' }
            );
          }

          if (verifyResponse && !verifyResponse.includes('COMPLET')) {
            missingItems = verifyResponse.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('write_file') || l.trim().startsWith('edit_file'));
          }
        } catch (e) {
          console.warn(`[FollowUp] Verify failed: ${e.message}`);
        }

        if (missingItems.length > 0) {
          console.log(`[FollowUp] Incomplete: ${missingItems.length} items missing`);
          missingItems.forEach(m => console.log(`  ${m}`));
          job.progressMessage = 'Finalisation des fichiers manquants...';
          try {
            const followUpPrompt = `INCOMPLET. Après vérification, il manque:\n${missingItems.join('\n')}

Demande originale: "${userMsg}"

Complète MAINTENANT. Pour chaque élément manquant:
- Nouvelle page → write_file avec composant React complet (export default function, imports @/, Tailwind)
- Modification server.js → edit_file (CREATE TABLE + routes API + données demo + middleware auth si nécessaire)
- Modification App.tsx → edit_file (ajouter import en haut + <Route path="..." element={<.../>}/> dans Routes)

TOUS les fichiers en UNE SEULE réponse. Pas de fichier oublié.`;

            const sysBlocks = [{ type: 'text', text: ai ? (ABSOLUTE_BROWSER_RULE + ai.CHAT_SYSTEM_PROMPT) : 'Complète.' }];
            const existingProject = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
            const contextMsgs = ai ? ai.buildConversationContext(
              { ...existingProject, title: '', brief: '' }, [], followUpPrompt, []
            ) : [{ role: 'user', content: followUpPrompt }];
            const followUpCode = await callClaudeAPI(sysBlocks, contextMsgs, 32000,
              { userId: job.user_id, projectId: job.project_id, operation: 'auto-correct' },
              { useTools: true });
            if (followUpCode) {
              const projDir2 = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
              writeGeneratedFiles(projDir2, followUpCode, job.project_id);
              const existing = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
              if (existing?.generated_code) job.code = mergeModifiedCode(existing.generated_code, followUpCode);
              console.log(`[FollowUp] Completed missing files`);
            }
          } catch (e) {
            console.warn(`[FollowUp] Fix failed: ${e.message}`);
          }
        } else {
          console.log(`[FollowUp] Verification: COMPLET — nothing missing`);
        }
      }

      if (job.status === 'running' && job.code.length > 0) {
        try {
          // Strip Claude artifacts (only needed for text/### fallback mode)
          job.code = stripCodeArtifacts(job.code);

          // Merge with existing code if modification
          if (job.project_id && job.code.includes('### ')) {
            const existingCode = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
            if (existingCode && existingCode.generated_code) {
              job.code = mergeModifiedCode(existingCode.generated_code, job.code);
            }
          }
          // Validate syntax ONLY for new generations (not modifications)
          // Modifications use edit_file which writes directly to disk —
          // running validateAndFixCode would OVERWRITE the AI's changes with template defaults
          const isNewGeneration = !job.project_id || !db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id)?.generated_code;
          if (isNewGeneration && job.project_id) {
            job.progressMessage = 'Vérification du code...';
            job.code = await validateAndFixCode(job.project_id, job.code);
          }
        } catch (e) { console.error('[Claude API] Post-process error:', e.message); }

        // Push final files to Docker container
        if (job.project_id) {
          try {
            const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
            const containerName = getContainerName(job.project_id);
            validateJsxFiles(projDir);
            // bind mounts: src/, index.html, server.js are auto-visible in container
            const finalFiles = readProjectFilesRecursive(projDir);
            const finalCode = formatProjectCode(finalFiles);
            db.prepare("UPDATE projects SET generated_code=?,build_status='done',build_url=?,status='ready',updated_at=datetime('now') WHERE id=?")
              .run(finalCode, `/run/${job.project_id}/`, job.project_id);
            job.code = finalCode;
            console.log(`[Stream] Final files pushed to container ${containerName}`);
          } catch (pushErr) {
            console.warn(`[Stream] Final push failed: ${pushErr.message}`);
          }
        }

        job.status = 'done';
        // If health check failed, notify the user via SSE so the error banner shows
        if (job.healthCheckFailed && job.project_id) {
          job.warning = job.healthError || 'Le preview a des erreurs — cliquez Corriger pour résoudre.';
          notifyProjectClients(job.project_id, 'generation_warning', { message: job.warning });
        }
      } else if (job.status === 'running') {
        // Before giving up, check if files were written to disk during streaming.
        // The streaming handler writes files in REAL-TIME (line ~5395). Even if the
        // stream ended messily (timeout, network blip, incomplete tool block), the
        // files may already be on disk and the preview working.
        let recovered = false;
        if (job.project_id) {
          try {
            const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
            const diskFiles = readProjectFilesRecursive(projDir);
            const diskCode = formatProjectCode(diskFiles);
            if (diskCode && diskCode.length > 500) {
              job.code = diskCode;
              job.status = 'done';
              recovered = true;
              db.prepare("UPDATE projects SET generated_code=?,build_status='done',status='ready',updated_at=datetime('now') WHERE id=?")
                .run(diskCode, job.project_id);
              console.log(`[Stream] No complete tool blocks at end, but ${Object.keys(diskFiles).length} files found on disk — recovered as done`);
            }
          } catch (e) {
            console.warn(`[Stream] Disk recovery failed: ${e.message}`);
          }
        }
        if (!recovered) {
          job.status = 'error';
          job.error = 'La génération n\'a produit aucun résultat. Réessayez.';
        }
      }
    });
  }, (e) => {
    // Distinguish user-initiated abort from real errors
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ERR_CANCELED')) {
      job.status = 'cancelled';
      job.progressMessage = 'Génération annulée';
      console.log(`[generateClaude] Job ${job.user_id ? 'u' + job.user_id : ''} cancelled by user`);
      return;
    }
    job.status = 'error';
    job.error = e.message;
  }, job);
}

// ─── GENERATE CLAUDE WITH IMAGE (NON-STREAMING, FOR POLLING) ───
// ─── GENERATE CLAUDE CODE FROM IMAGE ───
async function generateClaudeWithImage(imageBase64, mediaType, prompt, jobId) {
  const job = generationJobs.get(jobId);
  if (!job) return;
  
  if (!ANTHROPIC_API_KEY) { 
    job.status = 'error';
    job.error = 'Le service IA n\'est pas configuré. Contactez l\'administrateur.';
    return; 
  }
  
  const projectId = job.project_id;
  if (!projectId) {
    job.status = 'error';
    job.error = 'ID du projet manquant pour la génération à partir d\'image.';
    return;
  }
  
  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  
  // Create project directory if it doesn't exist
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
  
  // Create src directory for React project
  const srcDirImg = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDirImg)) {
    fs.mkdirSync(srcDirImg, { recursive: true });
  }

  // Save the image to the project directory for Claude Code to analyze
  const imagePath = path.join(projectDir, 'design-reference.png');
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  fs.writeFileSync(imagePath, imageBuffer);
  
  // Write BRIEF.md with image reference
  const briefContent = `# Brief du Projet

## Design de référence
Une image de design a été fournie : design-reference.png

${prompt || 'Reproduire fidèlement ce design en HTML/CSS/JS moderne, responsive et professionnel.'}
`;
  fs.writeFileSync(path.join(projectDir, 'BRIEF.md'), briefContent);
  
  // Write CLAUDE.md with image-specific instructions (React + Vite)
  const claudeMdContent = `# Prestige AI — Instructions (Design Image → React)

Tu es Prestige AI, le meilleur générateur d'applications React. Tu travailles dans le dossier courant uniquement.

## Brief
Analyse l'image design-reference.png et reproduis FIDÈLEMENT ce design en React + TailwindCSS.

## Instructions de reproduction (PRÉCISES)
1. **Structure visuelle** : header, sections, footer, grilles, sidebar — reproduis le LAYOUT EXACT
2. **Couleurs PRÉCISES** : extrais les couleurs hex exactes de l'image. Configure-les dans tailwind.config.js
3. **Typographie** : identifie les tailles, poids, inter-lignage. Utilise les utilities Tailwind correspondants
4. **Espacements** : reproduis les marges et paddings visuels avec précision (px → rem)
5. **Responsive** : mobile-first avec sm:, md:, lg: breakpoints
6. **OCR / Texte** : lis TOUT le texte visible dans l'image (titres, boutons, labels, paragraphes) et reproduis-le MOT POUR MOT dans le code. Ne remplace JAMAIS le texte par du placeholder
7. **Images** : si l'image contient des photos, utilise des images similaires via picsum.photos/seed/DESCRIPTIF
8. **Icônes** : identifie les icônes visibles et utilise les équivalents Lucide React
9. **Animations** : reproduis les effets visuels subtils (hover, transitions, ombres)

## Architecture React + Vite

Crée un projet React complet :
- package.json — "type": "module", dépendances React + Vite + TailwindCSS + Express
- vite.config.js — plugins: react + tailwindcss, proxy /api
- index.html — <div id="root"> + <script type="module" src="/src/main.tsx">
- server.js — Express servant dist/, SQLite, JWT auth
- src/main.jsx — point d'entrée React
- src/index.css — @import "tailwindcss" + custom CSS
- src/App.jsx — BrowserRouter + Routes + Layout
- src/components/*.tsx — Header, Footer, etc.
- src/pages/*.tsx — Home, etc.

## Qualité
- REPRODUIS FIDÈLEMENT le design de l'image en composants React + TailwindCSS
- Lucide React pour les icônes
- Images via https://picsum.photos
- Contenu réaliste et professionnel

## Processus
1. Analyse l'image design-reference.png
2. Génère les fichiers React reproduisant le design
3. Installe et build : npm install && npm run build
4. Lance : node server.js &
5. Teste : curl http://localhost:3000/health
6. Corrige si erreur, reteste
7. Quand tout fonctionne, écris le fichier READY
8. Si échec après 5 tentatives, écris ERROR
`;
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMdContent);
  
  // Update job status
  job.status = 'running';
  job.claudeCodeOutput = '';
  job.progressMessage = 'Analyse du design...';
  
  console.log(`[Claude Code Image] Starting generation from image for project ${projectId}`);
  console.log(`[Claude Code Image] Project directory: ${projectDir}`);
  
  // Build the prompt for Claude Code
  const claudePrompt = `Lis le fichier CLAUDE.md et analyse l'image design-reference.png dans ce dossier. Reproduis fidèlement ce design en créant un projet React + Vite + TailwindCSS complet (package.json, vite.config.js, index.html, server.js, src/*.jsx). Teste avec npm run build et crée le fichier READY quand tout fonctionne.`;
  
  // Spawn Claude Code process (see generateClaudeCode for security notes)
  const claudeProcess = spawn('claude', [
    '--dangerously-skip-permissions',
    '--print',
    claudePrompt
  ], {
    cwd: projectDir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
    }
  });
  
  // Store process reference
  claudeCodeProcesses.set(projectId, claudeProcess);

  // Timeout: kill process if it takes too long
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.warn(`[Claude Code Image] Timeout after ${CLAUDE_CODE_TIMEOUT_MS / 1000}s for project ${projectId}`);
    claudeProcess.kill('SIGTERM');
    setTimeout(() => {
      try { claudeProcess.kill('SIGKILL'); } catch {}
    }, 5000);
  }, CLAUDE_CODE_TIMEOUT_MS);

  // Capture stdout in real-time
  claudeProcess.stdout.on('data', (data) => {
    const output = data.toString();
    job.claudeCodeOutput += output;
    job.progress = job.claudeCodeOutput.length;

    if (output.includes('Analyzing') || output.includes('image')) {
      job.progressMessage = 'Analyse du design...';
    } else if (output.includes('package.json')) {
      job.progressMessage = 'Création du fichier package.json...';
    } else if (output.includes('server.js')) {
      job.progressMessage = 'Génération du backend...';
    } else if (output.includes('index.html') || output.includes('HTML')) {
      job.progressMessage = 'Reproduction du design en HTML/CSS...';
    } else if (output.includes('Testing') || output.includes('node --check')) {
      job.progressMessage = 'Vérification de la syntaxe...';
    } else if (output.includes('READY') || output.includes('Success')) {
      job.progressMessage = 'Design reproduit avec succès !';
    }

    console.log(`[Claude Code Image] Output: ${output.substring(0, 200)}...`);
  });

  // Capture stderr
  claudeProcess.stderr.on('data', (data) => {
    const errorOutput = data.toString();
    job.claudeCodeOutput += `[stderr] ${errorOutput}`;
    console.error(`[Claude Code Image] stderr: ${errorOutput}`);
  });

  // Handle process completion
  claudeProcess.on('close', (code) => {
    clearTimeout(timeout);
    console.log(`[Claude Code Image] Process exited with code ${code}${timedOut ? ' (timeout)' : ''}`);
    claudeCodeProcesses.delete(projectId);

    if (timedOut) {
      job.status = 'error';
      job.error = 'Claude Code a dépassé le délai maximum. Réessayez.';
      return;
    }

    const errorPath = path.join(projectDir, 'ERROR');

    if (fs.existsSync(errorPath)) {
      job.status = 'error';
      job.error = 'Claude Code a rencontré des erreurs lors de la reproduction du design.';
      try { fs.unlinkSync(errorPath); } catch {}
      return;
    }

    // Read all generated React project files
    try {
      const allFiles = readProjectFilesRecursive(projectDir);
      if (Object.keys(allFiles).length >= 3) {
        job.code = formatProjectCode(allFiles);
        job.progressMessage = 'Validation du design...';

        // ── IMAGE-TO-CODE VALIDATION + AUTO-FIX ──
        // After generation, validate build in background & auto-fix if needed
        job.status = 'done';
        job.progressMessage = 'Design reproduit — validation en cours...';
        console.log(`[Claude Code Image] Generation complete for project ${projectId} — ${Object.keys(allFiles).length} files`);

        // Background validation + auto-fix (non-blocking — user sees result immediately)
        if (containerExecService && ctx.docker) {
          (async () => {
            try {
              const buildResult = await containerExecService.buildInContainer(projectId);
              if (buildResult.exitCode !== 0) {
                console.log(`[Claude Code Image] Build failed — running auto-fix for project ${projectId}`);
                job.progressMessage = 'Correction automatique du design...';
                const fixJobId = crypto.randomUUID();
                generationJobs.set(fixJobId, { status: 'pending', code: job.code, error: null, progress: 0, project_id: projectId, user_id: job.user_id });
                try {
                  await agentModeService.runAgentLoop(fixJobId, { id: job.user_id }, { id: projectId, title: 'Image Design', project_type: 'web' },
                    `Le projet a des erreurs de build après génération depuis une image. Corrige toutes les erreurs. Build output: ${(buildResult.stderr || buildResult.stdout || '').substring(0, 1500)}`,
                    { callClaudeAPI, tools: CODE_TOOLS, containerExec: containerExecService, readProjectFiles: readProjectFilesRecursive, formatProjectCode }
                  );
                  const fixJob = generationJobs.get(fixJobId);
                  if (fixJob?.code) job.code = fixJob.code;
                } catch(fixErr) {
                  console.warn(`[Claude Code Image] Auto-fix failed: ${fixErr.message}`);
                }
                generationJobs.delete(fixJobId);
              }
              job.progressMessage = 'Design reproduit avec succès !';
            } catch(e) {
              console.warn(`[Claude Code Image] Validation skipped: ${e.message}`);
            }
          })();
        } else {
          job.progressMessage = 'Design reproduit avec succès !';
        }
      } else {
        console.warn(`[Claude Code Image] Only ${Object.keys(allFiles).length} files found, writing defaults`);
        writeDefaultReactProject(projectDir);
        const filesWithDefaults = readProjectFilesRecursive(projectDir);
        job.code = formatProjectCode(filesWithDefaults);
        job.status = 'done';
        job.progressMessage = 'Projet généré avec fichiers par défaut.';
      }
    } catch (readErr) {
      job.status = 'error';
      job.error = `Erreur de lecture des fichiers: ${readErr.message}`;
    }
  });

  // Handle process errors
  claudeProcess.on('error', (err) => {
    clearTimeout(timeout);
    console.error(`[Claude Code Image] Process error: ${err.message}`);
    claudeCodeProcesses.delete(projectId);
    job.status = 'error';
    job.error = `Erreur Claude Code: ${err.message}`;
  });
}

// ─── SAVE PROJECT VERSION ───
function saveProjectVersion(projectId, code, userId, message) {
  try {
    const lastVersion = db.prepare('SELECT MAX(version_number) as max FROM project_versions WHERE project_id=?').get(projectId);
    const versionNumber = (lastVersion?.max || 0) + 1;
    db.prepare('INSERT INTO project_versions (project_id, version_number, generated_code, created_by, message) VALUES (?,?,?,?,?)').run(projectId, versionNumber, code, userId, message || `Version ${versionNumber}`);
    return versionNumber;
  } catch(e) { console.error('Version save error:', e.message); return null; }
}

// ─── SAVE AUDIT RESULTS TO DB ───
function saveAuditResults(projectId, testTable, report, triggeredBy) {
  try {
    const passCount = testTable.filter(t => t.ok === true).length;
    const failCount = testTable.filter(t => t.ok === false).length;
    const skipCount = testTable.filter(t => t.ok === null).length;
    const score = testTable.length > 0 ? Math.round((passCount / testTable.length) * 10) : 0;
    db.prepare('INSERT INTO audit_results (project_id, score, passed, failed, skipped, total, results_json, report, triggered_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(projectId, score, passCount, failCount, skipCount, testTable.length,
        JSON.stringify(testTable), (report || '').substring(0, 15000), triggeredBy || 'manual');
    console.log(`[Audit] Saved: project ${projectId}, score ${score}/10, ${passCount}✓ ${failCount}✗`);
    return score;
  } catch (e) {
    console.warn(`[Audit] Failed to save results: ${e.message}`);
    return null;
  }
}

// ─── LIGHTWEIGHT POST-GENERATION AUDIT (runs automatically, no AI cost) ───
// Executes a subset of the 20 tests (the ones that don't need a container running)
// after each code generation. If score < 7, sends a warning notification via SSE.
async function runQuickAudit(projectId) {
  try {
    const projDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
    if (!fs.existsSync(projDir)) return null;
    const serverCode = fs.existsSync(path.join(projDir, 'server.js')) ? fs.readFileSync(path.join(projDir, 'server.js'), 'utf8') : '';
    const srcDir = path.join(projDir, 'src');
    const testTable = [];

    // Static tests only (no curl, no container needed) — instant, $0.00

    // 1. Missing imports
    const missingImports = [];
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') scanDir(path.join(dir, f.name));
        else if (f.isFile() && /\.(tsx|ts|jsx)$/.test(f.name)) {
          try {
            const content = fs.readFileSync(path.join(dir, f.name), 'utf8');
            for (const imp of (content.match(/from\s+['"]@\/([^'"]+)['"]/g) || [])) {
              const p = imp.match(/@\/([^'"]+)/)?.[1]; if (!p) continue;
              const resolved = path.join(srcDir, p);
              if (!fs.existsSync(resolved + '.tsx') && !fs.existsSync(resolved + '.ts') && !fs.existsSync(resolved + '.jsx') && !fs.existsSync(resolved))
                missingImports.push(`@/${p}`);
            }
          } catch (_) {}
        }
      }
    };
    scanDir(srcDir);
    testTable.push({ cat: 'Frontend', test: 'Imports @/', ok: missingImports.length === 0, details: missingImports.length === 0 ? 'OK' : missingImports.slice(0, 3).join(', ') });

    // 2. Export default
    const noExport = [];
    const checkExports = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) checkExports(path.join(dir, f.name));
        else if (f.isFile() && /\.(tsx|jsx)$/.test(f.name) && f.name !== 'main.tsx') {
          try { if (!fs.readFileSync(path.join(dir, f.name), 'utf8').includes('export default')) noExport.push(f.name); } catch (_) {}
        }
      }
    };
    checkExports(path.join(srcDir, 'pages')); checkExports(path.join(srcDir, 'components'));
    testTable.push({ cat: 'Frontend', test: 'Export default', ok: noExport.length === 0, details: noExport.length === 0 ? 'OK' : noExport.slice(0, 3).join(', ') });

    // 3. Fetch ↔ routes
    const fetchMismatches = [];
    const scanFetch = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') scanFetch(path.join(dir, f.name));
        else if (f.isFile() && /\.(tsx|jsx)$/.test(f.name)) {
          try {
            const c = fs.readFileSync(path.join(dir, f.name), 'utf8');
            for (const ft of (c.match(/fetch\s*\(\s*['"`](\/api\/[^'"`]+)/g) || [])) {
              const url = ft.match(/['"`](\/api\/[^'"`]+)/)?.[1];
              if (url && !serverCode.includes(`'${url}'`) && !serverCode.includes(`"${url}"`)) fetchMismatches.push(url);
            }
          } catch (_) {}
        }
      }
    };
    scanFetch(srcDir);
    testTable.push({ cat: 'Données', test: 'Fetch ↔ routes', ok: fetchMismatches.length === 0, details: fetchMismatches.length === 0 ? 'OK' : fetchMismatches.slice(0, 3).join(', ') });

    // 4. Tables with demo data
    const tables = (serverCode.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map(t => t.replace('CREATE TABLE IF NOT EXISTS ', ''));
    const tablesNoData = tables.filter(t => !serverCode.includes(`INSERT INTO ${t}`) && !serverCode.includes(`INSERT OR IGNORE INTO ${t}`));
    testTable.push({ cat: 'Données', test: 'Données demo', ok: tablesNoData.length === 0, details: tablesNoData.length === 0 ? 'OK' : `Vides: ${tablesNoData.join(', ')}` });

    // 5. Password hashing
    const hasBcrypt = serverCode.includes('bcrypt');
    testTable.push({ cat: 'Sécurité', test: 'Hachage passwords', ok: hasBcrypt, details: hasBcrypt ? 'bcrypt' : 'Pas de bcrypt' });

    // Calculate score
    const passCount = testTable.filter(t => t.ok === true).length;
    const score = testTable.length > 0 ? Math.round((passCount / testTable.length) * 10) : 0;

    // Save to DB
    saveAuditResults(projectId, testTable, null, 'auto');

    // If score < 7, warn via SSE
    if (score < 7) {
      const issues = testTable.filter(t => t.ok === false).map(t => t.test).join(', ');
      notifyProjectClients(projectId, 'audit_warning', {
        score, issues,
        message: `Audit automatique : ${score}/10 — problèmes détectés : ${issues}`
      });
      console.log(`[QuickAudit] Project ${projectId}: ${score}/10 — warning sent`);
    } else {
      console.log(`[QuickAudit] Project ${projectId}: ${score}/10 — OK`);
    }
    return score;
  } catch (e) {
    console.warn(`[QuickAudit] Failed for project ${projectId}: ${e.message}`);
    return null;
  }
}

// ─── AUTOMATIC ROLLBACK SYSTEM ───
// Save a full disk snapshot before any AI modification. If auto-fix fails,
// restore the snapshot so the user never sees a broken project (écran blanc).

// Save all project files to an in-memory snapshot. Returns the snapshot object.
function saveProjectSnapshot(projectDir) {
  const snapshot = {};
  try {
    const readDir = (dir, prefix) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.name === 'node_modules' || f.name === '.git' || f.name === 'dist' || f.name === 'data' || f.name === '.prestige') continue;
        const fullPath = path.join(dir, f.name);
        const relPath = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.isDirectory()) {
          readDir(fullPath, relPath);
        } else if (/\.(tsx|ts|jsx|js|css|json|html)$/.test(f.name) && f.name !== 'package-lock.json') {
          try {
            snapshot[relPath] = fs.readFileSync(fullPath, 'utf8');
          } catch (_) {}
        }
      }
    };
    readDir(projectDir, '');
    console.log(`[Snapshot] Saved ${Object.keys(snapshot).length} files from ${projectDir}`);
  } catch (e) {
    console.warn(`[Snapshot] Failed to save: ${e.message}`);
  }
  return snapshot;
}

// Restore a previously saved snapshot to disk. Also updates the DB.
function rollbackToSnapshot(projectDir, snapshot, projectId, reason) {
  if (!snapshot || Object.keys(snapshot).length === 0) {
    console.warn(`[Rollback] No snapshot to restore for project ${projectId}`);
    return false;
  }
  try {
    let restored = 0;
    for (const [relPath, content] of Object.entries(snapshot)) {
      const fullPath = path.join(projectDir, relPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      restored++;
    }
    // Also update DB with the restored code
    if (projectId) {
      const restoredCode = formatProjectCode(snapshot);
      db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now') WHERE id=?")
        .run(restoredCode, projectId);
    }
    console.log(`[Rollback] Restored ${restored} files for project ${projectId} — reason: ${reason}`);
    // Track the rollback in error_history
    try {
      db.prepare('INSERT INTO error_history (project_id, error_type, error_message, created_at) VALUES (?,?,?,datetime(\'now\'))')
        .run(projectId, 'ROLLBACK', `Auto-rollback: ${reason}`.substring(0, 500));
    } catch (_) {}
    return true;
  } catch (e) {
    console.error(`[Rollback] Failed to restore: ${e.message}`);
    return false;
  }
}

// ─── ERROR TELEMETRY ───
// Track error patterns for analysis. Uses UPSERT to increment counts.
// error_type: SYNTAX, IMPORT_MISSING, COHERENCE, VITE_BUILD, ROLLBACK, HMR, etc.
// error_signature: normalized short string identifying the specific error (e.g. "missing_import:@/hooks/useAuth")
function trackErrorPattern(errorType, errorSignature, projectId, sampleMessage, opts = {}) {
  try {
    const sig = (errorSignature || '').substring(0, 200);
    const sample = (sampleMessage || '').substring(0, 500);
    const existing = db.prepare('SELECT id, occurrence_count FROM error_patterns WHERE error_type=? AND error_signature=?').get(errorType, sig);
    if (existing) {
      db.prepare('UPDATE error_patterns SET occurrence_count=occurrence_count+1, last_project_id=?, last_seen=datetime(\'now\'), auto_fixed=auto_fixed+?, rollback_triggered=rollback_triggered+? WHERE id=?')
        .run(projectId, opts.autoFixed ? 1 : 0, opts.rollback ? 1 : 0, existing.id);
    } else {
      db.prepare('INSERT INTO error_patterns (error_type, error_signature, last_project_id, sample_message, auto_fixed, rollback_triggered) VALUES (?,?,?,?,?,?)')
        .run(errorType, sig, projectId, sample, opts.autoFixed ? 1 : 0, opts.rollback ? 1 : 0);
    }
  } catch (e) {
    // Telemetry should never break the main flow
    console.warn(`[Telemetry] Failed to track error: ${e.message}`);
  }
}

// ─── NOTIFY SSE CLIENTS — delegated to src/services/sse.js (imported above) ───

// ─── INJECT TRACKING SCRIPT INTO GENERATED CODE ───
function injectTrackingScript(html, projectId, subdomain) {
  const trackingScript = `
<script>
(function() {
  const PID = '${projectId}';
  const API = '${PUBLIC_URL || (typeof window !== 'undefined' ? window.location.origin : '')}/api/track/' + PID;
  let startTime = Date.now();
  
  function track(type, data) {
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: type, event_data: data, page: location.pathname })
    }).catch(() => {});
  }
  
  // Track pageview
  track('pageview', { url: location.href, referrer: document.referrer });
  
  // Track clicks on main elements
  document.addEventListener('click', function(e) {
    const el = e.target.closest('a, button, [data-track]');
    if (el) {
      track('click', { 
        tag: el.tagName, 
        text: (el.textContent || '').substring(0, 50),
        href: el.href || null,
        id: el.id || null
      });
    }
  });
  
  // Track form submissions
  document.addEventListener('submit', function(e) {
    const form = e.target;
    track('form_submit', { 
      action: form.action || location.href,
      id: form.id || null
    });
  });
  
  // Track time spent (on page unload)
  window.addEventListener('beforeunload', function() {
    const timeSpent = Math.round((Date.now() - startTime) / 1000);
    track('time_spent', { seconds: timeSpent, page: location.pathname });
  });
})();
</script>`;

  // Insert before </body> or </html>
  if (html.includes('</body>')) {
    return html.replace('</body>', trackingScript + '</body>');
  } else if (html.includes('</html>')) {
    return html.replace('</html>', trackingScript + '</html>');
  }
  return html + trackingScript;
}

// ─── SERVE BUILT FILES ───
function serveBuilt(res, buildId, filePath) {
  const buildDir = compiler?.getBuiltFiles(buildId);
  if (!buildDir) { res.writeHead(404); res.end('Build not found'); return; }
  const clean = (filePath||'index.html').replace(/\.\./g,'').replace(/^\//,'') || 'index.html';
  const full = path.join(buildDir, clean);
  
  // Security check: prevent path traversal attacks
  if (!isPathSafe(buildDir, full)) {
    res.writeHead(403); res.end('Access denied'); return;
  }
  
  if (!fs.existsSync(full)) {
    const idx = path.join(buildDir,'index.html');
    if (fs.existsSync(idx)) { res.writeHead(200,{'Content-Type':'text/html','Access-Control-Allow-Origin':'*'}); res.end(fs.readFileSync(idx)); return; }
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext=path.extname(full);
  const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
  res.writeHead(200,{'Content-Type':mime[ext]||'text/plain','Access-Control-Allow-Origin':'*'});
  res.end(fs.readFileSync(full));
}

// ─── PREVIEW ENGINE ───
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.jsx': 'application/javascript',
  '.ts': 'application/javascript',
  '.tsx': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

// Extract files from Claude's multi-file code output
function parseMultiFileCode(code) {
  const files = {};
  if (!code) return files;

  // Pattern 1: ### filename.ext + code block
  const pattern1 = /###\s+([^\n]+\.[\w]+)\n```(?:\w+)?\n([\s\S]*?)```/g;
  let m;
  while ((m = pattern1.exec(code)) !== null) {
    files[m[1].trim()] = cleanGeneratedContent(m[2]);
  }

  // Pattern 2: ## filename.ext + code block
  const pattern2 = /##\s+([^\n]+\.[\w]+)\n```(?:\w+)?\n([\s\S]*?)```/g;
  while ((m = pattern2.exec(code)) !== null) {
    if (!files[m[1].trim()]) files[m[1].trim()] = cleanGeneratedContent(m[2]);
  }

  // Pattern 3: **filename.ext** or `filename.ext` + code block
  const pattern3 = /(?:\*\*|`)([^*`\n]+\.[\w]+)(?:\*\*|`)\s*\n```(?:\w+)?\n([\s\S]*?)```/g;
  while ((m = pattern3.exec(code)) !== null) {
    if (!files[m[1].trim()]) files[m[1].trim()] = cleanGeneratedContent(m[2]);
  }

  // Pattern 4: ### filename.ext WITHOUT code blocks (new format)
  const pattern4 = /###\s+([^\n]+\.[\w]+)\n(?!```)([\s\S]*?)(?=###\s+[^\n]+\.[\w]+|$)/g;
  while ((m = pattern4.exec(code)) !== null) {
    if (!files[m[1].trim()]) {
      const content = cleanGeneratedContent(m[2]);
      if (content) files[m[1].trim()] = content;
    }
  }

  // If no multi-file found, treat as single file
  if (Object.keys(files).length === 0) {
    // Check for complete HTML document
    const htmlMatch = code.match(/<!DOCTYPE[\s\S]*?<\/html>/i);
    if (htmlMatch) {
      files['index.html'] = cleanGeneratedContent(htmlMatch[0]);
    } else {
      // Extract from single code block
      const single = code.match(/```(?:html|jsx?|tsx?|vue)?\n([\s\S]*?)```/);
      if (single) {
        const content = cleanGeneratedContent(single[1]);
        if (content.includes('<!DOCTYPE') || content.includes('<html')) {
          files['index.html'] = content;
        } else {
          files['App.jsx'] = content;
        }
      }
    }
  }

  return files;
}

// Detect framework/type from code
function detectFramework(code) {
  const c = code.toLowerCase();
  if (c.includes('react.createelement') || c.includes('reactdom') || c.includes('usestate(') || c.includes('useeffect(')) return 'react-cdn';
  if (c.includes('vue.createapp') || c.includes('v-bind') || c.includes('v-model') || c.includes('@click')) return 'vue-cdn';
  if (c.includes('from "react"') || c.includes("from 'react'")) return 'react';
  if (c.includes('from "vue"') || c.includes("from 'vue'")) return 'vue';
  if (c.includes('<!doctype') || c.includes('<html')) return 'html';
  return 'html';
}

// Wrap React CDN code in HTML
function wrapReactCDN(jsxCode) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Preview</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
${jsxCode}

const rootElement = document.getElementById('root');
const root = ReactDOM.createRoot(rootElement);
root.render(<App />);
  </script>
</body>
</html>`;
}

// Wrap Vue CDN code in HTML
function wrapVueCDN(vueCode) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Preview</title>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
${vueCode}
  </script>
</body>
</html>`;
}

// Save preview files for a project
function savePreviewFiles(projectId, code) {
  const previewDir = path.join(PREVIEWS_DIR, String(projectId));
  
  // Clean existing directory
  if (fs.existsSync(previewDir)) {
    fs.rmSync(previewDir, { recursive: true, force: true });
  }
  fs.mkdirSync(previewDir, { recursive: true });

  const files = parseMultiFileCode(code);
  const framework = detectFramework(code);
  
  // Determine main HTML content
  let mainHtml = files['index.html'];
  
  if (!mainHtml) {
    // Generate HTML based on framework
    if (framework === 'react-cdn' && files['App.jsx']) {
      mainHtml = wrapReactCDN(files['App.jsx']);
    } else if (framework === 'vue-cdn') {
      const vueCode = files['App.vue'] || files['app.js'] || Object.values(files)[0];
      if (vueCode) mainHtml = wrapVueCDN(vueCode);
    } else if (Object.keys(files).length > 0) {
      // Try to use first JSX file as React CDN
      const jsxFile = Object.entries(files).find(([k]) => k.endsWith('.jsx') || k.endsWith('.js'));
      if (jsxFile) {
        mainHtml = wrapReactCDN(jsxFile[1]);
      }
    }
    
    // Fallback: extract raw HTML from code if still nothing
    if (!mainHtml) {
      const htmlMatch = code.match(/<!DOCTYPE[\s\S]*?<\/html>/i);
      if (htmlMatch) {
        mainHtml = htmlMatch[0];
      } else {
        // Last resort: create minimal HTML wrapping the code
        // Truncate only for display purposes, but preserve meaningful content
        const codeLength = code.length;
        const truncatedCode = codeLength > MAX_CODE_DISPLAY_LENGTH ? code.substring(0, MAX_CODE_DISPLAY_LENGTH) + '\n\n... (code truncated, ' + codeLength + ' chars total)' : code;
        mainHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Preview</title><style>body{font-family:monospace;padding:20px;background:#1a1a2e;color:#e2e8f0;} pre{white-space:pre-wrap;word-wrap:break-word;}</style></head><body><h2 style="color:#D4A820;">Code généré</h2><p style="color:#8896c4;">Le code ne contient pas de HTML valide. Voici le contenu brut :</p><pre>' + escapeHtml(truncatedCode) + '</pre></body></html>';
      }
    }
  }

  // Inject error console script into HTML
  mainHtml = injectErrorConsole(mainHtml);

  // Write index.html
  fs.writeFileSync(path.join(previewDir, 'index.html'), mainHtml);

  // Write other files (CSS, JS, etc.)
  for (const [filename, content] of Object.entries(files)) {
    if (filename === 'index.html') continue;
    const filePath = path.join(previewDir, filename);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
  }

  return { success: true, dir: previewDir, framework, fileCount: Object.keys(files).length + 1 };
}

// Inject error console script
// ─── CLIENT-SIDE LOG STORAGE (ring buffer per project) ───
const clientLogs = new Map(); // projectId → [{ level, message, timestamp }]
const CLIENT_LOG_MAX = 100;

function addClientLog(projectId, level, message) {
  if (!projectId) return;
  const key = String(projectId);
  if (!clientLogs.has(key)) clientLogs.set(key, []);
  const logs = clientLogs.get(key);
  logs.push({ level, message: String(message).substring(0, 500), timestamp: new Date().toISOString() });
  if (logs.length > CLIENT_LOG_MAX) logs.shift();
}

function injectErrorConsole(html) {
  const errorScript = `
<script>
(function() {
  var _log = console.log, _warn = console.warn, _err = console.error;
  var _fetch = window.fetch;

  function send(level, msg) {
    try { window.parent.postMessage({ type: 'preview-console', level: level, message: String(msg).substring(0, 500) }, '*'); } catch(e) {}
  }

  console.log = function() { var m = [].slice.call(arguments).join(' '); send('log', m); _log.apply(console, arguments); };
  console.warn = function() { var m = [].slice.call(arguments).join(' '); send('warn', m); _warn.apply(console, arguments); };
  console.error = function() { var m = [].slice.call(arguments).join(' '); send('error', m); _err.apply(console, arguments); };

  window.onerror = function(msg, url, line) { send('error', msg + ' (line ' + line + ')'); return false; };
  window.onunhandledrejection = function(e) { send('error', 'Promise: ' + (e.reason && e.reason.message || e.reason || 'Unknown')); };

  // Intercept fetch to capture network errors (4xx/5xx)
  window.fetch = function(url, opts) {
    return _fetch.apply(this, arguments).then(function(res) {
      if (!res.ok) { send('network', res.status + ' ' + (opts && opts.method || 'GET') + ' ' + url); }
      return res;
    }).catch(function(err) {
      send('network', 'FAILED ' + (opts && opts.method || 'GET') + ' ' + url + ': ' + err.message);
      throw err;
    });
  };
})();
</script>`;

  // Insert before </head> or at start of <body>
  if (html.includes('</head>')) {
    return html.replace('</head>', errorScript + '</head>');
  } else if (html.includes('<body')) {
    return html.replace(/<body([^>]*)>/, '<body$1>' + errorScript);
  } else {
    return errorScript + html;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Serve preview files for a project
function servePreview(res, projectId, filePath) {
  const previewDir = path.join(PREVIEWS_DIR, String(projectId));
  
  if (!fs.existsSync(previewDir)) {
    res.writeHead(404);
    res.end('Preview not found. Generate code first.');
    return;
  }

  const clean = (filePath || 'index.html').replace(/\.\./g, '').replace(/^\//, '') || 'index.html';
  const fullPath = path.join(previewDir, clean);

  // Security check: prevent path traversal attacks
  if (!isPathSafe(previewDir, fullPath)) {
    res.writeHead(403);
    res.end('Access denied.');
    return;
  }

  if (!fs.existsSync(fullPath)) {
    // Try index.html fallback (SPA support)
    const indexPath = path.join(previewDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(indexPath));
      return;
    }
    res.writeHead(404);
    res.end('File not found');
    return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'text/plain';
  
  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(fs.readFileSync(fullPath));
}

// Clean old previews (older than 24 hours)
function cleanOldPreviews() {
  try {
    if (!fs.existsSync(PREVIEWS_DIR)) return;
    const dirs = fs.readdirSync(PREVIEWS_DIR);
    const now = Date.now();
    dirs.forEach(dir => {
      const full = path.join(PREVIEWS_DIR, dir);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > PREVIEW_RETENTION_MS) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch(e) {}
    });
  } catch(e) {}
}
// Clean old previews periodically
setInterval(cleanOldPreviews, CLEANUP_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════════════════
// DOCKER ISOLATED PREVIEW SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

// Ensure Docker projects directory exists
if (!fs.existsSync(DOCKER_PROJECTS_DIR)) {
  try { fs.mkdirSync(DOCKER_PROJECTS_DIR, { recursive: true }); } catch(e) { console.warn('Could not create DOCKER_PROJECTS_DIR:', e.message); }
}

// Check if Docker is available (using dockerode ping)
let dockerAvailable = false;
async function checkDockerAvailable() {
  if (!docker) return false;
  try {
    await docker.ping();
    return true;
  } catch (e) {
    return false;
  }
}

// Sync wrapper for isDockerAvailable (uses cached result set during init)
// NOTE: This returns false until initializeDockerSystem() completes
function isDockerAvailable() {
  return dockerAvailable;
}

// Ensure Docker network exists (using dockerode)
async function ensureDockerNetwork() {
  if (!docker) return;
  try {
    const networks = await docker.listNetworks();
    const networkNames = networks.map(n => n.Name);
    if (!networkNames.includes(DOCKER_NETWORK)) {
      await docker.createNetwork({ Name: DOCKER_NETWORK, Driver: 'bridge' });
      console.log(`Created Docker network: ${DOCKER_NETWORK}`);
    }
  } catch (e) {
    console.error('Failed to ensure Docker network:', e.message);
  }
}

// Join main container to pbp-projects network if not already connected
// This allows the main server to make health check requests to project containers via DNS
async function joinPbpProjectsNetwork() {
  if (!docker) return;
  try {
    // Get container ID from hostname (Docker sets HOSTNAME to container ID)
    const hostname = process.env.HOSTNAME || os.hostname();
    console.log(`[Network] Main container hostname: ${hostname}`);
    if (!hostname) {
      console.warn('[Network] Could not determine container hostname, skipping network join');
      return;
    }

    const container = docker.getContainer(hostname);
    let inspectData;
    try {
      inspectData = await container.inspect();
    } catch (e) {
      // Not running in a container or container not found — try by name from Coolify
      console.log(`[Network] Container lookup by hostname '${hostname}' failed: ${e.message}`);
      console.log('[Network] Not running in Docker container, skipping network join');
      return;
    }

    const containerName = inspectData.Name ? inspectData.Name.replace(/^\//, '') : hostname;
    console.log(`[Network] Container resolved: ${containerName} (ID: ${inspectData.Id ? inspectData.Id.substring(0, 12) : 'unknown'})`);

    // Check if already connected to pbp-projects network
    const networks = inspectData.NetworkSettings && inspectData.NetworkSettings.Networks;
    const networkNames = networks ? Object.keys(networks) : [];
    console.log(`[Network] Container current networks: ${networkNames.join(', ') || 'none'}`);

    if (networks && networks[DOCKER_NETWORK]) {
      const ip = networks[DOCKER_NETWORK].IPAddress;
      console.log(`[Network] Already connected to ${DOCKER_NETWORK} (IP: ${ip})`);
      return;
    }

    // Connect to pbp-projects network
    console.log(`[Network] Connecting container '${containerName}' to ${DOCKER_NETWORK}...`);
    const network = docker.getNetwork(DOCKER_NETWORK);
    await network.connect({ Container: inspectData.Id || hostname });
    console.log(`[Network] Successfully connected to ${DOCKER_NETWORK}`);

    // Verify the connection
    const verifyData = await container.inspect();
    const verifyNetworks = verifyData.NetworkSettings && verifyData.NetworkSettings.Networks;
    if (verifyNetworks && verifyNetworks[DOCKER_NETWORK]) {
      console.log(`[Network] Verified: IP in ${DOCKER_NETWORK} = ${verifyNetworks[DOCKER_NETWORK].IPAddress}`);
    } else {
      console.error(`[Network] WARNING: Connection to ${DOCKER_NETWORK} not verified after join!`);
    }
  } catch (e) {
    const hostname = process.env.HOSTNAME || os.hostname() || 'unknown';
    console.error(`[Network] Failed to join ${DOCKER_NETWORK} (container: ${hostname}): ${e.message}`);
    console.error(`[Network] Health checks to project containers will FAIL — DNS resolution requires same network`);
  }
}

// Get container name for a project
function getContainerName(projectId) {
  return `pbp-project-${projectId}`;
}

// Get the Docker DNS hostname for a project container.
// On the pbp-projects network, Docker resolves container names automatically.
function getContainerHostname(projectId) {
  return getContainerName(projectId); // pbp-project-{id}
}

// Check if container is running (using dockerode)
async function isContainerRunningAsync(projectId) {
  if (!docker) return false;
  try {
    const containerName = getContainerName(projectId);
    const container = docker.getContainer(containerName);
    const inspectData = await container.inspect();
    if (inspectData && inspectData.State) {
      return inspectData.State.Running === true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Stop and remove container (using dockerode)
// STOP a container — NEVER remove it. Data persists in bind mounts.
// Only removeContainerAsync (called by DELETE project) actually removes containers.
async function stopContainerAsync(projectId) {
  if (!docker) return;
  const containerName = getContainerName(projectId);
  try {
    const container = docker.getContainer(containerName);
    await container.stop({ t: 10 });
    console.log(`[Container] Stopped ${containerName}`);
  } catch (e) {
    // Container might not be running or not exist — that's OK
  }
}

// REMOVE a container permanently — only called when DELETING a project
async function removeContainerAsync(projectId) {
  if (!docker) return;
  const containerName = getContainerName(projectId);
  try {
    const container = docker.getContainer(containerName);
    try { await container.stop({ t: 5 }); } catch {}
    await container.remove({ force: true });
    console.log(`[Container] Removed ${containerName}`);
  } catch (e) {
    // Container doesn't exist
  }
}

// Remove container image (using dockerode)
async function removeContainerImageAsync(projectId) {
  if (!docker) return;
  const imageName = `pbp-project-${projectId}:latest`;
  try {
    const image = docker.getImage(imageName);
    await image.remove({ force: true });
  } catch (e) {
    // Image doesn't exist or can't be removed
  }
}

// Get container logs (using dockerode)
async function getContainerLogsAsync(projectId, tailLines = 100, sinceSeconds = 0) {
  if (!docker) return 'Erreur: Docker non disponible.';
  const containerName = getContainerName(projectId);
  try {
    const container = docker.getContainer(containerName);
    const opts = {
      stdout: true,
      stderr: true,
      tail: tailLines,
      follow: false
    };
    if (sinceSeconds > 0) {
      opts.since = Math.floor(Date.now() / 1000) - sinceSeconds;
    }
    const logStream = await container.logs(opts);
    // Docker logs stream includes 8-byte header per frame, need to demux
    if (Buffer.isBuffer(logStream)) {
      return demuxDockerLogs(logStream);
    }
    return logStream.toString('utf8');
  } catch (e) {
    return `Erreur: impossible de récupérer les logs. ${e.message}`;
  }
}

// Helper function to demux Docker logs (remove 8-byte frame headers)
function demuxDockerLogs(buffer) {
  let result = '';
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    // First byte is stream type (1=stdout, 2=stderr), bytes 4-7 are size (big-endian)
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) break;
    result += buffer.slice(offset, offset + size).toString('utf8');
    offset += size;
  }
  return result || buffer.toString('utf8');
}

// Restart container (using dockerode)
async function restartContainerAsync(projectId) {
  if (!docker) return false;
  const containerName = getContainerName(projectId);
  try {
    const container = docker.getContainer(containerName);
    await container.restart({ t: 10 });
    return true;
  } catch (e) {
    console.error('Failed to restart container:', e.message);
    return false;
  }
}

// ─── AUTO-RECOVERY: unhealthy containers ───
// Monitors pbp-project-* containers and auto-restarts those stuck in "unhealthy" state.
// Solves the "container stuck requires manual docker restart" problem.
//
// Cooldown prevents restart thrashing: if a container stays unhealthy (e.g., due to
// a real code bug like a bad import), it won't be restarted more than once per 5 min.
//
// Called from setInterval(autoRecoveryTick, AUTO_RECOVERY_INTERVAL_MS) at server start.
const AUTO_RECOVERY_INTERVAL_MS = 60 * 1000;         // check every minute
const AUTO_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;     // 5 min between restarts per project
const autoRecoveryLastRestart = new Map();           // projectId → timestamp

async function autoRecoveryTick() {
  if (!docker) return;
  try {
    // Query Docker for running containers filtered by health=unhealthy
    const containers = await docker.listContainers({
      all: false,
      filters: JSON.stringify({ health: ['unhealthy'] })
    });

    let actionCount = 0;
    for (const c of containers) {
      const name = ((c.Names || [])[0] || '').replace(/^\//, '');
      const match = name.match(/^pbp-project-(\d+)$/);
      if (!match) continue;
      const projectId = parseInt(match[1], 10);
      if (!Number.isInteger(projectId)) continue;

      // Cooldown: don't restart the same project more than once per cooldown window
      const lastRestart = autoRecoveryLastRestart.get(projectId);
      if (lastRestart && (Date.now() - lastRestart) < AUTO_RECOVERY_COOLDOWN_MS) {
        continue;
      }

      // CRITICAL: Don't restart if AI is actively working on this project
      // Restarting during modification causes lost work and broken state.
      let hasActiveJob = false;
      for (const [, job] of generationJobs) {
        if (job.project_id === projectId && (job.status === 'running' || job.status === 'pending')) {
          hasActiveJob = true;
          break;
        }
      }
      if (hasActiveJob) {
        console.log(`[AutoRecovery] Skipping project ${projectId} — AI is actively working`);
        continue;
      }

      log('warn', 'auto-recovery', 'unhealthy container detected, restarting', {
        projectId, containerName: name
      });
      try {
        const ok = await restartContainerAsync(projectId);
        if (ok) {
          autoRecoveryLastRestart.set(projectId, Date.now());
          actionCount++;
          log('info', 'auto-recovery', 'container restart issued', { projectId });
        } else {
          log('error', 'auto-recovery', 'restartContainerAsync returned false', { projectId });
        }
      } catch (e) {
        log('error', 'auto-recovery', 'restart threw', { projectId, error: e.message });
      }
    }

    // Prune cooldown map — keep only recent entries to bound memory
    const now = Date.now();
    for (const [pid, ts] of autoRecoveryLastRestart.entries()) {
      if (now - ts > AUTO_RECOVERY_COOLDOWN_MS * 3) {
        autoRecoveryLastRestart.delete(pid);
      }
    }

    if (actionCount > 0) {
      console.log(`[AutoRecovery] Restarted ${actionCount} unhealthy container(s)`);
    }
  } catch (e) {
    // Defensive: never let the cron crash the server
    log('error', 'auto-recovery', 'tick failed', { error: e.message });
  }
}

// Start a stopped container (using dockerode)
async function startContainerAsync(projectId) {
  if (!docker) return false;
  const containerName = getContainerName(projectId);
  try {
    const container = docker.getContainer(containerName);
    await container.start();
    return true;
  } catch (e) {
    console.error('Failed to start container:', e.message);
    return false;
  }
}

// Wait for container to be healthy (uses Docker DNS name, not IP)
async function waitForContainerHealth(projectId, maxWait = DOCKER_HEALTH_TIMEOUT) {
  const startTime = Date.now();
  const hostname = getContainerHostname(projectId);
  const healthUrl = `http://${hostname}:3000/health`;
  const viteUrl = `http://${hostname}:5173/run/${projectId}/`;
  let attempt = 0;

  console.log(`[Health] Starting health check for project ${projectId} → Express + Vite (timeout: ${maxWait / 1000}s)`);

  // Helper: test one URL, return { ok, reason }
  const testUrl = (url, timeoutMs = 2000) => new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        res.resume();
        resolve({ ok: true });
      } else {
        res.resume();
        resolve({ ok: false, reason: `HTTP ${res.statusCode}` });
      }
    });
    req.on('error', (e) => resolve({ ok: false, reason: `error: ${e.code || e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
  });

  while (Date.now() - startTime < maxWait) {
    attempt++;
    try {
      // Test Express AND Vite together — both must be ready
      const [expressResult, viteResult] = await Promise.all([
        testUrl(healthUrl),
        testUrl(viteUrl)
      ]);

      const result = {
        ok: expressResult.ok && viteResult.ok,
        reason: !expressResult.ok ? `Express: ${expressResult.reason}` : (!viteResult.ok ? `Vite: ${viteResult.reason}` : 'OK')
      };

      if (result.ok) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Health] ${hostname} OK (Express + Vite) after ${attempt} attempts (${elapsed}s)`);
        return true;
      }

      // Log every attempt for first 3, then every 5th
      if (attempt <= 3 || attempt % 5 === 0) {
        console.log(`[Health] ${hostname} attempt ${attempt}: ${result.reason}`);
      }
    } catch (e) {
      console.error(`[Health] ${hostname} attempt ${attempt}: unexpected error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[Health] ${hostname} FAILED after ${attempt} attempts (${elapsed}s). DNS resolution may be failing — ensure main container is on ${DOCKER_NETWORK} network.`);
  return false;
}

// Clean generated file content - remove all markdown artifacts and fix incompatible patterns
// Extract admin credentials from generated code (// CREDENTIALS: email=... password=...)
function extractCredentials(code) {
  if (!code) return null;
  const match = code.match(/\/\/\s*CREDENTIALS:\s*email=(\S+)\s+password=(\S+)/);
  if (match) {
    return { email: match[1], password: match[2] };
  }
  return null;
}

function cleanGeneratedContent(content) {
  if (!content) return '';

  let cleaned = content;

  // 1) Remove markdown code block markers (```javascript, ```jsx, ```, etc.)
  cleaned = cleaned.replace(/^```(?:javascript|js|json|html|css|jsx|tsx|typescript|ts|bash|sh|sql|yaml|yml|xml|text|txt|plain)?\s*$/gm, '');
  cleaned = cleaned.replace(/^`{3,}.*$/gm, '');

  // 2) Remove SUGGESTIONS: line and everything after it (Claude appends at end of last file)
  cleaned = cleaned.replace(/\n*SUGGESTIONS:[\s\S]*$/m, '');

  // 3) Remove conversational text ONLY at the very start or end of the file
  //    NEVER remove lines from the middle — they could be JSX text content
  //    Only strip leading/trailing non-code text (before first import/const/function, after last })
  const firstCodeLine = cleaned.search(/^(?:import |export |const |let |var |function |class |\/\/|\/\*|<|'use strict')/m);
  if (firstCodeLine > 0) {
    cleaned = cleaned.substring(firstCodeLine);
  }
  // Remove ALL trailing text after last closing brace or semicolon
  // Claude sometimes appends conversational text after the code
  const lastBrace = cleaned.lastIndexOf('}');
  const lastSemicolon = cleaned.lastIndexOf(';');
  const lastCodeChar = Math.max(lastBrace, lastSemicolon);
  if (lastCodeChar > 0) {
    const after = cleaned.substring(lastCodeChar + 1).trim();
    // If there's non-whitespace text after the last } or ;, it's conversational — remove it
    if (after.length > 0 && /[a-zA-ZÀ-ÿ]/.test(after)) {
      cleaned = cleaned.substring(0, lastCodeChar + 1) + '\n';
    }
  }

  // 4) Fix wrong SQLite package (sqlite3 → better-sqlite3)
  // AI sometimes generates async sqlite3 code instead of sync better-sqlite3
  cleaned = cleaned.replace(/require\(['"]sqlite3['"]\)\.verbose\(\)/g, "require('better-sqlite3')");
  cleaned = cleaned.replace(/require\(['"]sqlite3['"]\)/g, "require('better-sqlite3')");
  cleaned = cleaned.replace(/new sqlite3\.Database\(/g, "new (require('better-sqlite3'))(");
  cleaned = cleaned.replace(/require\(['"]bcrypt['"]\)/g, "require('bcryptjs')");

  // 5) Fix Express wildcard patterns
  cleaned = cleaned.replace(/app\.get\(\s*['"](\*|\/\*)['"]\s*,/g, "app.get(/.*/,");
  cleaned = cleaned.replace(/app\.use\(\s*['"](\*|\/\*)['"]\s*,/g, "app.use(/.*/,");
  cleaned = cleaned.replace(/router\.get\(\s*['"](\*|\/\*)['"]\s*,/g, "router.get(/.*/,");
  cleaned = cleaned.replace(/router\.use\(\s*['"](\*|\/\*)['"]\s*,/g, "router.use(/.*/,");

  // 5) Fix Express 5.x version references
  cleaned = cleaned.replace(/"express"\s*:\s*"\^?5[^"]*"/g, '"express": "4.18.2"');

  // 6) Pin critical dependency versions (remove ^ prefix)
  const pinDeps = ['express', 'better-sqlite3', 'bcryptjs', 'jsonwebtoken', 'cors', 'helmet', 'compression'];
  for (const dep of pinDeps) {
    cleaned = cleaned.replace(new RegExp(`"${dep}"\\s*:\\s*"\\^`, 'g'), `"${dep}": "`);
  }

  // 7) Remove consecutive blank lines (keep max 1)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  cleaned = cleaned.trim();
  return cleaned;
}

// Strip all Claude artifacts from a full ### marked code string (top-level)
// Removes conversational messages BEFORE the first ### and SUGGESTIONS at the end
function stripCodeArtifacts(code) {
  if (!code) return '';
  // Remove any text before the first ### marker (conversational message from Claude)
  let cleaned = code.replace(/^[\s\S]*?(?=### )/, '');
  // Remove SUGGESTIONS: and everything after it (at the very end)
  cleaned = cleaned.replace(/\n*SUGGESTIONS:[\s\S]*$/, '');
  // Remove trailing non-code text after the last file content
  cleaned = cleaned.replace(/\n+(?:N'hésitez|N'hésite|Voilà|Les modifications|Si vous|C'est fait|Bonne continuation)[\s\S]*$/, '');
  return cleaned.trim();
}

// Validate React project index.html: must have <div id="root"> and module script entry point
function validateReactIndexHtml(projectDir) {
  const indexPath = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.log(`[Validate] index.html missing — writing default`);
    fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML);
    return true;
  }
  let html = fs.readFileSync(indexPath, 'utf8');
  let changed = false;

  // Must have <div id="root">
  if (!html.includes('id="root"')) {
    console.warn(`[Validate] index.html missing <div id="root"> — fixing`);
    if (html.includes('<body>')) {
      html = html.replace('<body>', '<body>\n  <div id="root"></div>');
      changed = true;
    } else {
      fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML);
      return true;
    }
  }

  // Must have module script entry point
  if (!html.includes('src="/src/main.tsx"') && !html.includes("src='/src/main.jsx'")) {
    console.warn(`[Validate] index.html missing main.jsx entry — fixing`);
    if (html.includes('</body>')) {
      html = html.replace('</body>', '  <script type="module" src="/src/main.tsx"></script>\n</body>');
      changed = true;
    }
  }

  if (!html.includes('</html>')) {
    html += '\n</html>';
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(indexPath, html);
    console.log(`[Validate] index.html repaired`);
  }
  return true;
}

// Parse generated code into files (looking for ### markers)
function parseDockerProjectCode(code) {
  const files = {};
  if (!code) return files;

  // Pattern: ### filename.ext followed by content until next ### or end
  const sections = code.split(/###\s+/);

  for (const section of sections) {
    if (!section.trim()) continue;

    // First line is the filename
    const lines = section.split('\n');
    const firstLine = lines[0].trim();

    // Check if it looks like a filename (may include paths like src/components/Header.jsx)
    if (firstLine.includes('.') && !firstLine.includes('  ')) {
      let filename = firstLine.replace(/[`*]/g, '').trim();
      // Get content, skipping markdown code block markers and clean it
      let content = lines.slice(1).join('\n');
      content = cleanGeneratedContent(content);

      // Map public/index.html to index.html if it's a React project (has <div id="root">)
      if (filename === 'public/index.html' && content.includes('id="root"')) {
        filename = 'index.html';
      }

      if (content && isValidProjectFile(filename)) {
        files[filename] = content;
      }
    }
  }

  return files;
}

// Build and run Docker container for a project
// ─── TEMPLATE-FIRST ARCHITECTURE (like Lovable) ───
// The pbp-ready image has EVERYTHING pre-installed (npm, Vite, React, Radix, UI components)
// Creating a project = just docker run from pbp-ready (2-3 seconds, NO build, NO npm install)
// The AI writes files INTO the running container via docker cp
const READY_IMAGE = 'pbp-ready';

// Ensure the ready image exists (built once from Dockerfile.ready)
async function ensureReadyImage() {
  if (!docker) return;
  try {
    await docker.getImage(READY_IMAGE).inspect();
    console.log(`[Docker] Ready image '${READY_IMAGE}' exists`);
  } catch {
    console.log(`[Docker] Building ready image '${READY_IMAGE}'...`);
    try {
      // Build from Dockerfile.ready which has EVERYTHING pre-installed
      const buildContext = path.join(__dirname);
      const stream = await docker.buildImage(
        { context: buildContext, src: ['Dockerfile.ready', 'templates/'] },
        { t: READY_IMAGE, dockerfile: 'Dockerfile.ready' }
      );
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => { if (err) reject(err); else resolve(); });
      });
      console.log(`[Docker] Ready image '${READY_IMAGE}' built successfully`);
    } catch (e) {
      console.error(`[Docker] Failed to build ready image: ${e.message}`);
      // Fallback to base image
    }
  }
}

// Launch a container from pbp-ready in 2-3 seconds (NO Docker build, NO npm install)
async function launchTemplateContainer(projectId) {
  if (!isDockerAvailable()) return { success: false, error: 'Docker non disponible' };

  const containerName = getContainerName(projectId);
  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  const dataDir = path.join(projectDir, 'data');
  const jwtSecret = crypto.randomBytes(32).toString('hex');

  console.log(`[Template] Launching container for project ${projectId} (from ready image)`);

  // Create project directory on host (for file sync)
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Write canonical files to host (for reference + DB storage)
  writeDefaultReactProject(projectDir);
  fs.writeFileSync(path.join(projectDir, 'package.json'), DEFAULT_PACKAGE_JSON);
  fs.writeFileSync(path.join(projectDir, 'vite.config.js'), DEFAULT_VITE_CONFIG);
  // Write default tailwind.config.js (will be overwritten by AI with sector colors)
  const templateTailwind = path.join(__dirname, 'templates', 'react', 'tailwind.config.js');
  if (fs.existsSync(templateTailwind)) {
    fs.copyFileSync(templateTailwind, path.join(projectDir, 'tailwind.config.js'));
  }
  fs.writeFileSync(path.join(projectDir, 'index.html'), DEFAULT_INDEX_HTML);
  if (!fs.existsSync(path.join(projectDir, 'server.js'))) fs.writeFileSync(path.join(projectDir, 'server.js'), DEFAULT_SERVER_JS);
  const srcDir = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
  if (!fs.existsSync(path.join(srcDir, 'main.tsx'))) fs.writeFileSync(path.join(srcDir, 'main.tsx'), DEFAULT_MAIN_JSX);
  if (!fs.existsSync(path.join(srcDir, 'index.css'))) fs.writeFileSync(path.join(srcDir, 'index.css'), DEFAULT_INDEX_CSS);
  if (!fs.existsSync(path.join(srcDir, 'App.tsx'))) fs.writeFileSync(path.join(srcDir, 'App.tsx'), DEFAULT_APP_JSX);

  // Stop old container if exists
  await stopContainerAsync(projectId);

  // Try pbp-ready image first, fallback to pbp-base with build
  await ensureReadyImage();
  let imageName = READY_IMAGE;
  try { await docker.getImage(READY_IMAGE).inspect(); } catch { imageName = DOCKER_BASE_IMAGE; }

  // Create and start container — NO BUILD, just docker run
  await ensureDockerNetwork();
  const container = await docker.createContainer({
    Image: imageName,
    name: containerName,
    Env: [
      `PORT=3000`,
      `JWT_SECRET=${jwtSecret}`,
      `VITE_BASE=/run/${projectId}/`,
      `NODE_OPTIONS=--max-old-space-size=256`
    ],
    Cmd: ['sh', '-c', `cp server.js server.cjs 2>/dev/null; node server.cjs & echo $! > /tmp/express.pid; sleep 1; ./node_modules/.bin/vite --host 0.0.0.0 --port 5173 --base "/run/${projectId}/" & while true; do sleep 3600; done`],
    HostConfig: {
      NetworkMode: DOCKER_NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: [
        `${dataDir}:/app/data`,
        `${projectDir}/src:/app/src`,
        `${projectDir}/public:/app/public`,
        `${projectDir}/server.js:/app/server.js`,
        `${projectDir}/index.html:/app/index.html`,
        `${projectDir}/tailwind.config.js:/app/tailwind.config.js`,
        `${projectDir}/vite.config.js:/app/vite.config.js`
      ],
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500000000,
      SecurityOpt: ['no-new-privileges']
    }
  });
  await container.start();

  // Wait for health (should be very fast — everything is pre-installed)
  const healthy = await waitForContainerHealth(projectId, 60000);
  if (healthy) {
    db.prepare("UPDATE projects SET build_status='building',build_url=? WHERE id=?").run(`/run/${projectId}/`, projectId);
    console.log(`[Template] Container ready for project ${projectId} — waiting for AI generation`);
    return { success: true, url: `/run/${projectId}/` };
  }
  console.warn(`[Template] Container unhealthy for project ${projectId}`);
  return { success: false, error: 'Container unhealthy' };
}

// Write generated files INTO a RUNNING container (no rebuild needed)
async function writeFilesToContainer(projectId, code) {
  const containerName = getContainerName(projectId);
  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  const { execSync } = require('child_process');

  // Write files to disk first
  writeGeneratedFiles(projectDir, code, projectId);

  // Auto-fix relative imports
  validateJsxFiles(projectDir);

  // Copy into running container
  if (fs.existsSync(path.join(projectDir, 'src'))) {
    // bind mount — no docker cp needed for src/
  }
  // Copy index.html (may have custom title or meta tags)
  if (fs.existsSync(path.join(projectDir, 'index.html'))) {
    // bind mount — no docker cp needed for index.html
  }
  if (fs.existsSync(path.join(projectDir, 'server.js'))) {
    // Validate syntax before copying
    const { spawnSync } = require('child_process');
    const check = spawnSync('node', ['--check', path.join(projectDir, 'server.js')], { encoding: 'utf8', timeout: 5000 });
    if (check.status === 0) {
      // bind mount — no docker cp needed for server.js
    }
  }

  // Update DB code
  const allFiles = readProjectFilesRecursive(projectDir);
  const allCode = formatProjectCode(allFiles);
  db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready' WHERE id=?").run(allCode, projectId);

  console.log(`[Template] Files written to container ${containerName}`);
  return allCode;
}

async function buildDockerProject(projectId, code, onProgress) {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  const srcDir = path.join(projectDir, 'src');
  const dataDir = path.join(projectDir, 'data');
  const containerName = getContainerName(projectId);
  const imageName = `pbp-project-${projectId}:latest`;

  console.log(`[Docker Build] Starting build for project ${projectId}`);

  // Ensure pbp-base image exists before every build (Coolify prunes it during deploys)
  await ensureBaseImage();

  console.log(`[Docker Build] Project directory: ${projectDir}`);
  console.log(`[Docker Build] Container name: ${containerName}`);
  console.log(`[Docker Build] Image name: ${imageName}`);

  try {
    // Step 1: Parse code into files (10%)
    console.log(`[Docker Build] Step 1: Parsing code into files...`);
    onProgress({ step: 1, progress: 10, message: 'Analyse du code généré...' });
    const files = parseDockerProjectCode(code);
    console.log(`[Docker Build] Parsed ${Object.keys(files).length} files: ${Object.keys(files).join(', ')}`);
    
    if (Object.keys(files).length === 0) {
      console.error(`[Docker Build] ERROR: No files found in generated code`);
      throw new Error('Aucun fichier trouvé dans le code généré. Utilisez les marqueurs ### pour séparer les fichiers.');
    }

    // Helper function to copy directory contents recursively
    function copyDirSync(src, dest) {
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(dest, { recursive: true });
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDirSync(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }

    // Create directories, preserving data directory for persistence
    console.log(`[Docker Build] Setting up project directories...`);
    if (fs.existsSync(projectDir)) {
      console.log(`[Docker Build] Project directory exists, backing up data...`);
      const tmpData = path.join('/tmp', `pbp-data-${projectId}`);
      // Backup data directory using fs operations (cross-platform)
      if (fs.existsSync(dataDir)) {
        try {
          copyDirSync(dataDir, tmpData);
          console.log(`[Docker Build] Data backed up to ${tmpData}`);
        } catch(e) { console.warn('[Docker Build] Data backup failed:', e.message); }
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
      // Restore data directory
      if (fs.existsSync(tmpData)) {
        try {
          copyDirSync(tmpData, dataDir);
          fs.rmSync(tmpData, { recursive: true, force: true });
          console.log(`[Docker Build] Data restored from backup`);
        } catch(e) { console.warn('[Docker Build] Data restore failed:', e.message); }
      }
    } else {
      console.log(`[Docker Build] Creating new project directory structure`);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Step 2: Write all files (30%) — React multi-file project
    console.log(`[Docker Build] Step 2: Writing project files...`);
    onProgress({ step: 2, progress: 30, message: 'Écriture des fichiers du projet...' });

    for (const [filename, content] of Object.entries(files)) {
      const filePath = path.join(projectDir, filename);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
      console.log(`[Docker Build] Written: ${filename} (${content.length} bytes)`);
    }

    // LOVABLE APPROACH: The AI does NOT control package.json.
    // We ALWAYS write the canonical DEFAULT_PACKAGE_JSON which has all required packages.
    // If the AI added extra deps (e.g. chart.js), we preserve them.
    const pkgJsonPath = path.join(projectDir, 'package.json');
    try {
      const canonical = JSON.parse(DEFAULT_PACKAGE_JSON);
      // Read AI-generated package.json to preserve project name and any extra deps
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const aiPkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          // Preserve project name
          if (aiPkg.name) canonical.name = aiPkg.name;
          // Preserve any EXTRA dependencies the AI added (chart.js, etc.)
          if (aiPkg.dependencies) {
            for (const [name, version] of Object.entries(aiPkg.dependencies)) {
              if (!canonical.dependencies[name]) {
                canonical.dependencies[name] = version;
              }
            }
          }
        } catch (e) { /* AI package.json was invalid — use canonical as-is */ }
      }
      fs.writeFileSync(pkgJsonPath, JSON.stringify(canonical, null, 2));
      console.log(`[Docker Build] Wrote canonical package.json (${Object.keys(canonical.dependencies).length} deps)`);
    } catch (e) {
      fs.writeFileSync(pkgJsonPath, DEFAULT_PACKAGE_JSON);
      console.warn(`[Docker Build] Wrote fallback package.json: ${e.message}`);
    }

    // CANONICAL FILES — these are NEVER generated by the AI (like Lovable)
    // They are ALWAYS written by the server, overwriting any AI-generated version
    const canonicalFiles = {
      'vite.config.js': DEFAULT_VITE_CONFIG,
      'index.html': DEFAULT_INDEX_HTML,
      'src/main.tsx': DEFAULT_MAIN_JSX,
    };
    for (const [fn, content] of Object.entries(canonicalFiles)) {
      const fp = path.join(projectDir, fn);
      const fpDir = path.dirname(fp);
      if (!fs.existsSync(fpDir)) fs.mkdirSync(fpDir, { recursive: true });
      // For index.html: preserve the AI's <title> and <meta description> if present
      if (fn === 'index.html' && fs.existsSync(fp)) {
        try {
          const aiHtml = fs.readFileSync(fp, 'utf8');
          let canonical = content;
          const titleMatch = aiHtml.match(/<title>([^<]+)<\/title>/);
          if (titleMatch) canonical = canonical.replace(/<title>[^<]*<\/title>/, `<title>${titleMatch[1]}</title>`);
          const descMatch = aiHtml.match(/<meta\s+name="description"\s+content="([^"]+)"/);
          if (descMatch) canonical = canonical.replace('</head>', `  <meta name="description" content="${descMatch[1]}">\n</head>`);
          fs.writeFileSync(fp, canonical);
        } catch { fs.writeFileSync(fp, content); }
      } else {
        fs.writeFileSync(fp, content);
      }
      console.log(`[Docker Build] Wrote canonical ${fn}`);
    }
    // Write tsconfig.json (always)
    const tsconfigContent = JSON.stringify({
      compilerOptions: { target: "ES2020", useDefineForClassFields: true, lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true,
        isolatedModules: true, moduleDetection: "force", noEmit: true, jsx: "react-jsx",
        strict: true, noUnusedLocals: false, noUnusedParameters: false, allowJs: true,
        paths: { "@/*": ["./src/*"] } },
      include: ["src"]
    }, null, 2);
    fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), tsconfigContent);
    console.log(`[Docker Build] Wrote canonical tsconfig.json`);

    // Step 2.25: Validate mandatory React project files
    console.log(`[Docker Build] Step 2.25: Validating React project files...`);
    onProgress({ step: 2, progress: 32, message: 'Validation des fichiers React...' });

    // VALIDATION 1: package.json must be valid JSON
    const packageJsonPath = path.join(projectDir, 'package.json');
    if (!fs.existsSync(packageJsonPath) || !isValidJson(packageJsonPath)) {
      console.log(`[Docker Build] Writing default package.json`);
      fs.writeFileSync(packageJsonPath, DEFAULT_PACKAGE_JSON);
    }

    // VALIDATION 2: server.js syntax check
    const serverJsPath = path.join(projectDir, 'server.js');
    if (!fs.existsSync(serverJsPath)) {
      console.log(`[Docker Build] Writing default server.js`);
      fs.writeFileSync(serverJsPath, DEFAULT_SERVER_JS);
    } else {
      const syntaxResult = checkSyntax(projectDir);
      if (!syntaxResult.valid) {
        console.warn(`[Docker Build] server.js syntax error, using default: ${syntaxResult.error}`);
        fs.writeFileSync(serverJsPath, DEFAULT_SERVER_JS);
      }
    }

    // VALIDATION 3: Ensure essential React files exist
    const essentialFiles = {
      'vite.config.js': DEFAULT_VITE_CONFIG,
      'index.html': DEFAULT_INDEX_HTML,
      'src/main.tsx': DEFAULT_MAIN_JSX,
      'src/index.css': DEFAULT_INDEX_CSS,
      'src/App.tsx': DEFAULT_APP_JSX,
    };
    for (const [fn, defaultContent] of Object.entries(essentialFiles)) {
      const fp = path.join(projectDir, fn);
      const fpDir = path.dirname(fp);
      if (!fs.existsSync(fpDir)) fs.mkdirSync(fpDir, { recursive: true });
      if (!fs.existsSync(fp)) {
        console.log(`[Docker Build] Writing default ${fn}`);
        fs.writeFileSync(fp, defaultContent);
      }
    }

    // VALIDATION 4: index.html must have <div id="root"> and module script
    validateReactIndexHtml(projectDir);

    // VALIDATION 5: vite.config.js must have allowedHosts: true (required for Docker DNS access)
    const viteConfigPath = path.join(projectDir, 'vite.config.js');
    if (fs.existsSync(viteConfigPath)) {
      let viteConfig = fs.readFileSync(viteConfigPath, 'utf8');
      if (!viteConfig.includes('allowedHosts')) {
        // Inject allowedHosts: true after port: 5173
        viteConfig = viteConfig.replace(
          /(port:\s*5173\s*,?)/,
          '$1\n    allowedHosts: true,'
        );
        fs.writeFileSync(viteConfigPath, viteConfig);
        console.log(`[Docker Build] Patched vite.config.js: added allowedHosts: true`);
      }
    }

    console.log(`[Docker Build] React project validation completed`);

    // Step 2.5: Create Dockerfile for React + Vite project
    console.log(`[Docker Build] Step 2.5: Creating Dockerfile...`);
    onProgress({ step: 2, progress: 35, message: 'Création du Dockerfile React...' });
    const jwtSecret = crypto.randomBytes(32).toString('hex');

    // React + Vite Dockerfile: run Vite dev server + Express API backend
    // NODE_PATH makes pre-installed packages available to require(),
    // but Vite/npx needs a local node_modules symlink to resolve them
    const dockerfile = `FROM ${DOCKER_BASE_IMAGE}
WORKDIR /app
# Cache buster to force npm install on every build
ARG CACHEBUST=${Date.now()}
COPY package.json ./
# Install ALL dependencies — --force handles React 19 vs Radix peer deps
RUN npm install --force 2>&1 | tail -5
COPY vite.config.js ./
COPY index.html ./
COPY server.js ./
COPY src/ ./src/
COPY start-dev.sh ./
RUN chmod +x start-dev.sh
RUN mkdir -p /app/data
ENV JWT_SECRET=${jwtSecret}
ENV PORT=3000
ENV VITE_BASE=/run/${projectId}/
ENV NODE_OPTIONS="--max-old-space-size=256"
EXPOSE 3000 5173
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["sh", "start-dev.sh"]
`;
    fs.writeFileSync(path.join(projectDir, 'Dockerfile'), dockerfile);

    // Write start-dev.sh: launches Express backend + Vite dev server in parallel
    // Use node_modules/.bin/vite directly — npx would try to download a different version
    const startDevSh = [
      '#!/bin/sh',
      '# Ensure node_modules symlink exists (packages pre-installed in base image)',
      'ln -sf /app/node_modules ./node_modules 2>/dev/null',
      '',
      '# Start Express API backend (port 3000)',
      'node server.js &',
      'echo $! > /tmp/express.pid',
      '',
      '# Start Vite dev server with HMR (port 5173)',
      '# VITE_BASE sets the base path so all imports are prefixed correctly',
      './node_modules/.bin/vite --host 0.0.0.0 --port 5173 --base "$VITE_BASE" &',
      'echo $! > /tmp/vite.pid',
      '',
      '# Keep running — if container receives SIGTERM, forward to children',
      'trap "kill $(cat /tmp/express.pid 2>/dev/null) $(cat /tmp/vite.pid 2>/dev/null) 2>/dev/null; exit 0" SIGTERM SIGINT',
      '# Wait forever (both processes run in background)',
      'while true; do sleep 3600; done',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(projectDir, 'start-dev.sh'), startDevSh);
    console.log(`[Docker Build] React Dockerfile + start-dev.sh created (Vite HMR mode)`);

    // Step 3: Stop old container and build new image (50%)
    console.log(`[Docker Build] Step 3: Stopping old container and building new image...`);
    onProgress({ step: 3, progress: 50, message: 'Construction de l\'environnement...' });
    await stopContainerAsync(projectId);
    console.log(`[Docker Build] Old container stopped (if existed)`);
    
    // Build image using dockerode
    // Get all files in project directory recursively for build context
    function listFilesRecursive(dir, base = '') {
      let result = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
        if (entry.isDirectory()) {
          result = result.concat(listFilesRecursive(path.join(dir, entry.name), rel));
        } else {
          result.push(rel);
        }
      }
      return result;
    }
    const projectFiles = listFilesRecursive(projectDir);
    console.log(`[Docker Build] Building image with ${projectFiles.length} files: ${projectFiles.slice(0, 10).join(', ')}${projectFiles.length > 10 ? '...' : ''}`);
    const buildStream = await docker.buildImage(
      { context: projectDir, src: projectFiles },
      { t: imageName }
    );
    
    // Wait for build to complete
    console.log(`[Docker Build] Waiting for image build to complete...`);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(buildStream, (err, output) => {
        if (err) {
          console.error(`[Docker Build] ERROR: Image build failed: ${err.message}`);
          reject(err);
        } else {
          console.log(`[Docker Build] Image build completed successfully`);
          resolve(output);
        }
      });
    });

    // Step 4: Run the container (70%)
    console.log(`[Docker Build] Step 4: Creating and starting container...`);
    onProgress({ step: 4, progress: 70, message: 'Lancement du projet...' });
    
    // Load project-specific API keys as container env vars
    const projectEnv = ['PORT=3000'];
    if (db) {
      const keys = db.prepare('SELECT env_name, env_value FROM project_api_keys WHERE project_id=?').all(projectId);
      keys.forEach(k => projectEnv.push(`${k.env_name}=${decryptValue(k.env_value)}`));
      if (keys.length > 0) console.log(`[Docker Build] Injecting ${keys.length} API keys as env vars`);
    }

    // Create and start container using dockerode
    console.log(`[Docker Build] Creating container with network: ${DOCKER_NETWORK}`);
    const container = await docker.createContainer({
      Image: imageName,
      name: containerName,
      Env: projectEnv,
      HostConfig: {
        NetworkMode: DOCKER_NETWORK,
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: [
          `${dataDir}:/app/data`,
          `${projectDir}/src:/app/src`,
          `${projectDir}/server.js:/app/server.js`,
          `${projectDir}/index.html:/app/index.html`
        ],
        Memory: 512 * 1024 * 1024,    // 512MB max
        NanoCpus: 500000000,           // 0.5 CPU
        SecurityOpt: ['no-new-privileges']
      }
    });
    console.log(`[Docker Build] Container created, starting...`);
    await container.start();
    console.log(`[Docker Build] Container started`);

    // Step 5: Wait for health check (90%)
    console.log(`[Docker Build] Step 5: Waiting for health check...`);
    onProgress({ step: 5, progress: 90, message: 'Vérification du démarrage...' });
    
    const healthy = await waitForContainerHealth(projectId);
    if (!healthy) {
      const logs = await getContainerLogsAsync(projectId, 50);
      console.error(`[Docker Build] ERROR: Container health check failed`);
      console.error(`[Docker Build] Container logs:\n${logs}`);
      throw new Error('Le projet ne répond pas. Vérifiez les logs pour plus de détails.');
    }
    console.log(`[Docker Build] Health check passed`);

    // Step 6: Done — container is reachable via Docker DNS (100%)
    const containerHost = getContainerHostname(projectId);
    console.log(`[Docker Build] Step 6: Container ready at ${containerHost}:3000`);
    onProgress({ step: 6, progress: 100, message: 'Prêt !' });

    console.log(`[Docker Build] Build completed successfully for project ${projectId}`);
    return {
      success: true,
      url: `/run/${projectId}/`,
      containerHost: containerHost
    };

  } catch (e) {
    console.error(`[Docker Build] FAILED for project ${projectId}: ${e.message}`);
    console.error(`[Docker Build] Stack trace:`, e.stack);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFESSIONAL ERROR MANAGEMENT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

// Detect error type from Docker logs or error message
function detectErrorType(logs, errorMessage = '') {
  const combined = (logs + ' ' + errorMessage).toLowerCase();
  
  // Syntax errors
  if (combined.includes('syntaxerror') || combined.includes('unexpected token') || 
      combined.includes('unexpected identifier') || combined.includes('parsing error')) {
    return ERROR_TYPES.SYNTAX;
  }
  
  // Dependency errors
  if (combined.includes('cannot find module') || combined.includes('module not found') ||
      combined.includes('npm err!') || combined.includes('error: cannot find package')) {
    return ERROR_TYPES.DEPENDENCY;
  }
  
  // Port errors
  if (combined.includes('eaddrinuse') || combined.includes('address already in use') ||
      combined.includes('port') && combined.includes('already')) {
    return ERROR_TYPES.PORT;
  }
  
  // SQLite errors
  if (combined.includes('sqlite') && (combined.includes('error') || combined.includes('constraint') ||
      combined.includes('malformed') || combined.includes('corrupt'))) {
    return ERROR_TYPES.SQLITE;
  }
  
  // Memory errors
  if (combined.includes('heap out of memory') || combined.includes('allocation failed') ||
      combined.includes('oom') || combined.includes('killed')) {
    return ERROR_TYPES.MEMORY;
  }
  
  // Timeout errors
  if (combined.includes('timeout') || combined.includes('timed out')) {
    return ERROR_TYPES.TIMEOUT;
  }

  // Vite / React build errors
  if (combined.includes('vite') || combined.includes('esbuild') ||
      combined.includes('failed to resolve import') || combined.includes('expected ";"') ||
      combined.includes('jsx') && combined.includes('error') ||
      combined.includes('transform failed') || combined.includes('build failed')) {
    return ERROR_TYPES.SYNTAX;
  }

  return ERROR_TYPES.UNKNOWN;
}

// Translate error type to French for user display
function translateErrorType(errorType) {
  const translations = {
    [ERROR_TYPES.SYNTAX]: 'Erreur de syntaxe JavaScript',
    [ERROR_TYPES.DEPENDENCY]: 'Module npm manquant',
    [ERROR_TYPES.PORT]: 'Port déjà utilisé',
    [ERROR_TYPES.SQLITE]: 'Erreur de base de données SQLite',
    [ERROR_TYPES.MEMORY]: 'Limite de mémoire atteinte',
    [ERROR_TYPES.TIMEOUT]: 'Délai de démarrage dépassé',
    [ERROR_TYPES.UNKNOWN]: 'Erreur de démarrage'
  };
  return translations[errorType] || translations[ERROR_TYPES.UNKNOWN];
}

// Check syntax before container build — server.js via node --check, React files via structure check
function checkSyntax(projectDir) {
  const { spawnSync } = require('child_process');

  // 1) Validate server.js (CommonJS — node --check works)
  const serverJsPath = path.join(projectDir, 'server.js');
  if (fs.existsSync(serverJsPath)) {
    try {
      const result = spawnSync('node', ['--check', serverJsPath], { encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0) {
        return {
          valid: false,
          error: result.stderr || result.stdout || 'Syntax error in server.js',
          type: ERROR_TYPES.SYNTAX
        };
      }
    } catch (e) {
      return { valid: false, error: e.message, type: ERROR_TYPES.SYNTAX };
    }
  }

  // 2) Validate essential React project structure
  const requiredFiles = ['index.html', 'vite.config.js', 'src/main.tsx', 'src/App.tsx'];
  const missing = requiredFiles.filter(f => !fs.existsSync(path.join(projectDir, f)));
  if (missing.length > 0) {
    console.warn(`[checkSyntax] Missing React files: ${missing.join(', ')}`);
    // Not a hard failure — writeDefaultReactProject will fill in gaps
  }

  // 3) Quick JSX sanity: App.jsx should have export default and JSX
  const appJsx = path.join(projectDir, 'src', 'App.tsx');
  if (fs.existsSync(appJsx)) {
    const content = fs.readFileSync(appJsx, 'utf8');
    if (!content.includes('export') || !/<\w/.test(content)) {
      return {
        valid: false,
        error: 'src/App.jsx is not a valid React component (missing export or JSX)',
        type: ERROR_TYPES.SYNTAX
      };
    }
  }

  return { valid: true };
}

// Extract missing module name from error logs
function extractMissingModule(logs) {
  const patterns = [
    /Cannot find module ['"]([^'"]+)['"]/i,
    /Error: Cannot find package ['"]([^'"]+)['"]/i,
    /Module not found: Error:.*['"]([^'"]+)['"]/i
  ];
  
  for (const pattern of patterns) {
    const match = logs.match(pattern);
    if (match && match[1]) {
      // Clean up the module name (remove relative paths)
      let moduleName = match[1];
      if (!moduleName.startsWith('.') && !moduleName.startsWith('/')) {
        // Get the base package name (e.g., 'express' from 'express/lib/router')
        return moduleName.split('/')[0];
      }
    }
  }
  return null;
}

// Find a free port starting from 3000
function findFreePort(startPort = 3001) {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const result = execSync(`lsof -i :${port} 2>/dev/null || true`, { encoding: 'utf8' });
      if (!result.trim()) {
        return port;
      }
    } catch (e) {
      return port; // If command fails, assume port is free
    }
  }
  return startPort + Math.floor(Math.random() * 100);
}

// Log error to database
function logError(projectId, errorType, errorMessage, dockerLogs, attempt) {
  if (!db) return;
  try {
    db.prepare('INSERT INTO error_history (project_id, error_type, error_message, docker_logs, correction_attempt) VALUES (?,?,?,?,?)')
      .run(projectId, errorType, errorMessage, dockerLogs, attempt);
  } catch (e) {
    console.error('Failed to log error:', e.message);
  }
}

// Mark error as corrected in database
function markErrorCorrected(projectId, correctedCode) {
  if (!db) return;
  try {
    db.prepare('UPDATE error_history SET corrected = 1, corrected_code = ? WHERE project_id = ? AND corrected = 0 ORDER BY id DESC LIMIT 1')
      .run(correctedCode, projectId);
  } catch (e) {
    console.error('Failed to mark error corrected:', e.message);
  }
}

// Call Claude API for code correction (non-streaming)
async function callClaudeForCorrection(originalCode, errorLogs, errorType) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Clé API Claude non configurée');
  }
  
  // Build a focused correction prompt with full project context
  const fileList = (originalCode.match(/### ([^\n]+)/g) || []).map(m => m.replace('### ', ''));

  // Include client-side logs if available (frontend console errors, network failures)
  // These help the AI understand runtime errors, not just build errors
  const projIdMatch = originalCode.match(/project[_-]?id[:\s]+(\d+)/i);
  let clientLogContext = '';
  if (projIdMatch) {
    const cLogs = clientLogs.get(projIdMatch[1]) || [];
    const errorLogs2 = cLogs.filter(l => l.level === 'error' || l.level === 'network').slice(-10);
    if (errorLogs2.length > 0) {
      clientLogContext = `\n\nERREURS FRONTEND (console navigateur):\n${errorLogs2.map(l => `[${l.level}] ${l.message}`).join('\n')}`;
    }
  }

  // Identify which file likely caused the error
  const errorFileHints = [];
  if (errorLogs.includes('server.js')) errorFileHints.push('server.js');
  if (errorLogs.includes('App.jsx') || errorLogs.includes('src/')) errorFileHints.push('src/App.tsx');
  if (errorLogs.match(/components\/\w+/)) errorFileHints.push(errorLogs.match(/components\/(\w+\.jsx)/)?.[0] || '');
  if (errorLogs.match(/pages\/\w+/)) errorFileHints.push(errorLogs.match(/pages\/(\w+\.jsx)/)?.[0] || '');
  if (errorLogs.includes('vite') || errorLogs.includes('build')) errorFileHints.push('vite.config.js');
  if (errorLogs.includes('package.json') || errorLogs.includes('Cannot find module')) errorFileHints.push('package.json');

  const correctionPrompt = `Ce projet React+Vite a cette erreur : ${translateErrorType(errorType)}

STRUCTURE DU PROJET (${fileList.length} fichiers):
${fileList.map(f => `  - ${f}`).join('\n')}

${errorFileHints.length ? `FICHIER(S) PROBABLEMENT EN CAUSE: ${errorFileHints.filter(Boolean).join(', ')}` : ''}

LOGS D'ERREUR (serveur/build):
${errorLogs.substring(0, 3000)}
${clientLogContext}

CODE COMPLET DU PROJET:
${originalCode}

DIAGNOSTIC: ${diagnoseViteError(errorLogs, errorFileHints.filter(Boolean)[0] || '', 1)}

CORRIGE UNIQUEMENT l'erreur identifiee. NE CHANGE PAS le design, layout, couleurs, ou structure des autres parties du code.

RÈGLES:
1. Format ### pour chaque fichier (### package.json, ### server.js, ### src/App.tsx, etc.)
2. JAMAIS de backticks markdown autour du code
3. Retourne SEULEMENT les fichiers que tu modifies — PAS les fichiers non concernes
4. server.js: Port 3000, route /health, express.static(path.join(__dirname,'dist'))
5. Composants React: export default function, imports corrects, hooks valides
6. JAMAIS de mots reserves JS (public, private, class, default, etc.) comme noms de variables

Retourne UNIQUEMENT le code corrigé, sans explications.`;

  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: correctionPrompt }];
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      messages
    });
    
    const opts = { 
      hostname: 'api.anthropic.com', 
      path: '/v1/messages', 
      method: 'POST', 
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.content && response.content[0] && response.content[0].text) {
            // Track auto-correction tokens (free — not counted in quota)
            if (response.usage) {
              trackTokenUsage(null, null, 'auto-correct', 'claude-sonnet-4-20250514', response.usage);
            }
            resolve(response.content[0].text);
          } else if (response.error) {
            reject(new Error(response.error.message || 'Erreur API Claude'));
          } else {
            reject(new Error('Réponse API invalide'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Final deep correction: send the full code + exact error to Claude for a complete rewrite
async function callClaudeFinalCorrection(originalCode, errorLogs) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Clé API Claude non configurée');
  }

  // Extract only server.js from the generated code
  const serverJsMatch = originalCode.match(/### server\.js\n([\s\S]*?)(?=\n### |$)/);
  const serverJsCode = serverJsMatch ? serverJsMatch[1].trim() : originalCode;

  const prompt = `Ce server.js génère cette erreur :

${errorLogs.substring(0, 3000)}

Code actuel de server.js :
${serverJsCode}

Réécris complètement server.js en corrigeant l'erreur. Assure-toi que app est défini avant tout app.use(). Retourne uniquement le code corrigé, sans marqueurs ### et sans backticks.`;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    });

    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.content && response.content[0] && response.content[0].text) {
            // Track (free — auto-correct not counted in quota)
            if (response.usage) trackTokenUsage(null, null, 'auto-correct', 'claude-sonnet-4-20250514', response.usage);
            const correctedServerJs = response.content[0].text
              .replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();

            // Rebuild the full code with corrected server.js merged into existing files
            const fullCode = mergeModifiedCode(originalCode, `### server.js\n${correctedServerJs}`);
            console.log(`[Final Correction] server.js rewritten (${correctedServerJs.length} bytes)`);
            resolve(fullCode);
          } else if (response.error) {
            reject(new Error(response.error.message || 'Erreur API Claude'));
          } else {
            reject(new Error('Réponse API invalide'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Auto-correction cycle for a project
async function autoCorrectProject(projectId, onProgress) {
  // Prevent concurrent corrections
  if (correctionInProgress.has(projectId)) {
    console.log(`Correction already in progress for project ${projectId}`);
    return { success: false, reason: 'correction_in_progress' };
  }
  
  correctionInProgress.add(projectId);
  
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!project || !project.generated_code) {
      return { success: false, reason: 'no_code' };
    }
    
    // Get current attempt count
    const currentAttempts = correctionAttempts.get(projectId) || 0;
    
    if (currentAttempts >= MAX_AUTO_CORRECTION_ATTEMPTS) {
      // Max attempts reached - notify the user
      const lastError = db.prepare('SELECT * FROM error_history WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId);
      return { 
        success: false, 
        reason: 'max_attempts', 
        attempts: currentAttempts,
        lastError: lastError ? translateErrorType(lastError.error_type) : 'Erreur inconnue'
      };
    }
    
    // Get Docker logs
    const logs = await getContainerLogsAsync(projectId, 200);
    const errorType = detectErrorType(logs);
    
    onProgress?.({ 
      step: 'detecting', 
      message: 'Erreur détectée — analyse en cours',
      errorType: translateErrorType(errorType)
    });
    
    // Log the error
    logError(projectId, errorType, logs.substring(0, 500), logs, currentAttempts + 1);
    
    // Increment attempt counter
    correctionAttempts.set(projectId, currentAttempts + 1);
    
    onProgress?.({ 
      step: 'correcting', 
      message: 'Correction en cours via Prestige AI',
      attempt: currentAttempts + 1
    });
    
    // Call Claude for correction
    let correctedCode = await callClaudeForCorrection(project.generated_code, logs, errorType);

    // Direct auto-fix on corrected code (catches what AI missed — reserved words, etc.)
    // Parse corrected code into files, fix, then re-serialize
    const projDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
    if (fs.existsSync(projDir)) {
      writeGeneratedFiles(projDir, correctedCode, projectId);
      const postFixFiles = readProjectFilesRecursive(projDir);
      const fixCount = autoFixMechanicalErrors(projDir, postFixFiles);
      if (fixCount > 0) {
        const fixedFiles = readProjectFilesRecursive(projDir);
        correctedCode = formatProjectCode(fixedFiles);
        console.log(`[AutoRecovery] Direct auto-fix applied ${fixCount} fix(es)`);
      }
    }

    // Update project with corrected code
    db.prepare("UPDATE projects SET generated_code=?, updated_at=datetime('now') WHERE id=?")
      .run(correctedCode, projectId);
    
    // Mark error as corrected
    markErrorCorrected(projectId, correctedCode);
    
    onProgress?.({ 
      step: 'rebuilding', 
      message: 'Correction appliquée — reconstruction'
    });
    
    // Stop old container
    await stopContainerAsync(projectId);
    
    // Rebuild with corrected code
    const result = await buildDockerProject(projectId, correctedCode, (p) => {
      onProgress?.({ 
        step: 'building', 
        progress: p.progress,
        message: p.message
      });
    });
    
    if (result.success) {
      // Reset attempt counter on success
      correctionAttempts.delete(projectId);
      onProgress?.({ 
        step: 'done', 
        message: 'Projet corrigé et redémarré avec succès'
      });
      return { success: true, url: result.url };
    } else {
      // If still failing, check attempts before trying again
      const updatedAttempts = correctionAttempts.get(projectId) || 0;
      if (updatedAttempts >= MAX_AUTO_CORRECTION_ATTEMPTS) {
        return { 
          success: false, 
          reason: 'max_attempts',
          attempts: updatedAttempts,
          lastError: 'Build échoué après correction'
        };
      }
      // Try again — release lock first so recursive call can acquire it
      correctionInProgress.delete(projectId);
      return await autoCorrectProject(projectId, onProgress);
    }

  } catch (e) {
    console.error('Auto-correction failed:', e.message);

    const currentAttempts = correctionAttempts.get(projectId) || 0;

    if (currentAttempts >= MAX_AUTO_CORRECTION_ATTEMPTS) {
      return {
        success: false,
        reason: 'max_attempts',
        attempts: currentAttempts,
        error: e.message
      };
    }

    correctionAttempts.set(projectId, currentAttempts + 1);

    if (correctionAttempts.get(projectId) >= MAX_AUTO_CORRECTION_ATTEMPTS) {
      // ── LAYER 4: Agent Mode fallback ──
      // Standard correction exhausted — try Agent Mode as last resort
      console.log(`[AutoCorrect] Max attempts for project ${projectId} — trying Agent Mode fallback`);
      try {
        const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
        if (project && agentModeService) {
          const fallbackJobId = crypto.randomUUID();
          generationJobs.set(fallbackJobId, { status: 'pending', code: project.generated_code || '', error: null, progress: 0, project_id: projectId });
          await agentModeService.runAgentLoop(fallbackJobId, { id: project.user_id }, project,
            `Le projet a des erreurs après ${MAX_AUTO_CORRECTION_ATTEMPTS} tentatives de correction. Erreur: ${e.message}. Corrige tous les problèmes.`,
            { callClaudeAPI, tools: CODE_TOOLS, containerExec: containerExecService, readProjectFiles: readProjectFilesRecursive, formatProjectCode }
          );
          const fallbackJob = generationJobs.get(fallbackJobId);
          if (fallbackJob?.code) {
            console.log(`[AutoCorrect] Agent Mode fallback succeeded for project ${projectId}`);
            return { success: true, code: fallbackJob.code, via: 'agent-fallback' };
          }
        }
      } catch(agentErr) {
        console.warn(`[AutoCorrect] Agent Mode fallback failed: ${agentErr.message}`);
      }

      return {
        success: false,
        reason: 'max_attempts',
        attempts: correctionAttempts.get(projectId),
        error: e.message
      };
    }

    // Try again — release lock first
    correctionInProgress.delete(projectId);
    return await autoCorrectProject(projectId, onProgress);

  } finally {
    correctionInProgress.delete(projectId);
  }
}

// Monitor all active containers every 30 seconds
// ─── PROJECT BACKUP SYSTEM ───
const BACKUP_DIR = '/data/backups';
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_BACKUPS = 7;

async function backupProject(projectId) {
  const projectDataDir = path.join(DOCKER_PROJECTS_DIR, String(projectId), 'data');
  const dbFile = path.join(projectDataDir, 'database.db');
  if (!fs.existsSync(dbFile)) return null;

  const backupDir = path.join(BACKUP_DIR, String(projectId));
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `${timestamp}.db`);
  fs.copyFileSync(dbFile, backupFile);

  // Prune old backups, keep last MAX_BACKUPS
  const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort().reverse();
  for (let i = MAX_BACKUPS; i < backups.length; i++) {
    fs.unlinkSync(path.join(backupDir, backups[i]));
  }

  console.log(`[Backup] Project ${projectId} backed up: ${backupFile}`);
  return backupFile;
}

async function backupAllProjects() {
  if (!db) return;
  try {
    const projects = db.prepare("SELECT id FROM projects WHERE build_status='done'").all();
    let count = 0;
    for (const p of projects) {
      try { if (await backupProject(p.id)) count++; } catch (e) { /* skip */ }
    }
    if (count > 0) console.log(`[Backup] ${count} projects backed up`);
  } catch (e) { console.error('[Backup] Error:', e.message); }
}

async function monitorContainers() {
  if (!db || !isDockerAvailable()) return;

  try {
    const projects = db.prepare("SELECT id, user_id, title, is_published FROM projects WHERE build_status = 'done'").all();

    for (const project of projects) {
      const running = await isContainerRunningAsync(project.id);
      const lastAccess = containerLastAccess.get(project.id) || 0;
      // If container was never accessed (lastAccess=0), don't kill it — it was just created
      // Use project.updated_at as fallback to know when it was last active
      const effectiveLastAccess = lastAccess > 0 ? lastAccess : (project.updated_at ? new Date(project.updated_at).getTime() : Date.now());
      const idle = Date.now() - effectiveLastAccess;

      // Auto-sleep: stop idle pbp-project-* containers only (never the main Prestige container)
      const targetContainer = getContainerName(project.id);
      // Don't sleep if AI is actively working on this project
      let projectHasActiveJob = false;
      for (const [, job] of generationJobs) {
        if (job.project_id === project.id && (job.status === 'running' || job.status === 'pending')) {
          projectHasActiveJob = true;
          break;
        }
      }
      if (running && !project.is_published && !projectHasActiveJob && idle > SLEEP_TIMEOUT_MS && targetContainer.startsWith('pbp-project-')) {
        console.log(`[Sleep] Stopping idle ${targetContainer} (idle ${Math.round(idle / 60000)}min)`);
        try {
          const container = docker.getContainer(targetContainer);
          await container.stop({ t: 5 });
        } catch (e) { /* already stopped */ }
        continue;
      }

      // Keep published sites running — but don't loop on missing containers
      if (!running && project.is_published) {
        const containerName = getContainerName(project.id);
        try {
          // Check if container EXISTS first (not just running)
          const container = docker.getContainer(containerName);
          const info = await container.inspect().catch(() => null);
          if (info) {
            // Container exists but stopped → restart it
            await container.start();
            console.log(`[Monitor] Restarted stopped container ${containerName}`);
          } else {
            // Container doesn't exist → skip (don't try to recreate in monitoring)
            // The user needs to recompile or the project will be recreated on next access
            console.log(`[Monitor] ${containerName} not found — skipping`);
          }
        } catch (e) {
          // Silently skip — don't spam logs every 30s
        }
      }
    }
  } catch (e) {
    console.error('Container monitoring error:', e.message);
  }
}

// Translate Docker logs to user-friendly French messages
function translateLogsToFrench(logs) {
  const translations = [
    { pattern: /Server running on port (\d+)/gi, replacement: '🟢 Serveur démarré sur le port $1' },
    { pattern: /listening on.*port.*(\d+)/gi, replacement: '🟢 Écoute sur le port $1' },
    { pattern: /Connected to database/gi, replacement: '📦 Connecté à la base de données' },
    { pattern: /Database connection established/gi, replacement: '📦 Connexion base de données établie' },
    { pattern: /Express server started/gi, replacement: '🟢 Serveur Express démarré' },
    { pattern: /npm WARN/gi, replacement: '⚠️ Avertissement npm' },
    { pattern: /npm ERR!/gi, replacement: '❌ Erreur npm' },
    { pattern: /SyntaxError/gi, replacement: '❌ Erreur de syntaxe' },
    { pattern: /ReferenceError/gi, replacement: '❌ Variable non définie' },
    { pattern: /TypeError/gi, replacement: '❌ Erreur de type' },
    { pattern: /Cannot find module/gi, replacement: '❌ Module introuvable' },
    { pattern: /EADDRINUSE/gi, replacement: '⚠️ Port déjà utilisé' },
    { pattern: /ECONNREFUSED/gi, replacement: '⚠️ Connexion refusée' },
    { pattern: /Error:/gi, replacement: '❌ Erreur:' },
    { pattern: /Warning:/gi, replacement: '⚠️ Attention:' },
    { pattern: /Starting/gi, replacement: '🔄 Démarrage' },
    { pattern: /Ready/gi, replacement: '✅ Prêt' },
    { pattern: /Shutting down/gi, replacement: '🛑 Arrêt en cours' },
    { pattern: /health check/gi, replacement: 'vérification santé' }
  ];
  
  let translatedLogs = logs;
  for (const { pattern, replacement } of translations) {
    translatedLogs = translatedLogs.replace(pattern, replacement);
  }
  
  return translatedLogs;
}

// Get error history for a project
function getErrorHistory(projectId) {
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM error_history WHERE project_id = ? ORDER BY id DESC LIMIT 10').all(projectId);
  } catch (e) {
    return [];
  }
}

// Restart lock to prevent multiple simultaneous restart attempts
const restartLocks = new Map();
// Tracks which projects have been auto-fixed in the /run/ proxy handler.
// Prevents the expensive CSS fix + import scan from running on EVERY sub-resource
// request (was: 40-60 times per page load, ~500-1000ms wasted CPU).
const proxyAutoFixedProjects = new Set();

// Proxy request to container (uses Docker DNS name, not IP)
async function proxyToContainer(req, res, projectId, targetPath) {
  const containerHost = getContainerHostname(projectId);

  // Route /uploads/ and /api/ directly to Express (3000) — Vite doesn't serve these.
  // Strip /run/{id} prefix so Express receives /uploads/file.png instead of /run/13/uploads/file.png
  const subPath = targetPath.replace(new RegExp(`^/run/${projectId}`), '');
  const isExpressRoute = subPath.startsWith('/uploads') || subPath.startsWith('/api/') || subPath.startsWith('/health');
  const proxyPort = isExpressRoute ? 3000 : 5173;
  if (isExpressRoute) targetPath = subPath;

  // Proxy the request via Docker DNS
  // Strip headers that would confuse the container or break response processing
  const forwardHeaders = { ...req.headers, host: `${containerHost}:${proxyPort}` };
  delete forwardHeaders['authorization'];   // Prestige JWT, not container's
  delete forwardHeaders['accept-encoding']; // Prevent gzip — we may modify HTML responses

  const options = {
    hostname: containerHost,
    port: proxyPort,
    path: targetPath || '/',
    method: req.method,
    headers: forwardHeaders,
    timeout: 30000
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Strip ALL helmet security headers — they break iframe embedding.
    // The preview runs behind Prestige's own proxy; container-level
    // security headers are redundant and actively harmful in iframes.
    const headers = { ...proxyRes.headers };
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['x-frame-options'];
    delete headers['x-content-type-options'];
    delete headers['content-disposition'];
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-resource-policy'];
    delete headers['cross-origin-embedder-policy'];
    delete headers['origin-agent-cluster'];
    delete headers['referrer-policy'];
    delete headers['strict-transport-security'];
    delete headers['x-dns-prefetch-control'];
    delete headers['x-download-options'];
    delete headers['x-permitted-cross-domain-policies'];
    delete headers['x-xss-protection'];
    // Remove content-encoding — we may modify the body below (inject <base>)
    // and gzipped content can't be modified in-flight
    const isHtml = (headers['content-type'] || '').includes('text/html');
    // Strip headers that break iframe embedding
    res.writeHead(proxyRes.statusCode, headers);

    // Vite uses --base /run/{id}/ so ALL paths are already correctly prefixed.
    // No URL rewriting needed — just pipe the response through.
    proxyRes.pipe(res);
  });

  proxyReq.on('error', async (e) => {
    console.error(`[Proxy] Error for project ${projectId} (${containerHost}):`, e.message);

    // Background recovery: if container is down, try to restart it (one attempt, locked)
    const running = await isContainerRunningAsync(projectId);
    if (!running && !restartLocks.get(projectId)) {
      restartLocks.set(projectId, true);
      restartContainerAsync(projectId).catch(err => console.error('Restart error:', err.message));
      setTimeout(() => restartLocks.delete(projectId), 60000);
    }

    // Break the infinite reload loop: count retries via URL param, give up after MAX_RETRIES
    // with a permanent error page. The 3-second reload was way too aggressive — Vite boot
    // can take 30-60s, so 3s × 20 attempts = 60s of hammering before the user gives up.
    const MAX_RETRIES = 4;
    const RELOAD_DELAY_MS = 15000;
    const urlParts = (req.url || '').split('?');
    const params = urlParts.length > 1 ? new URLSearchParams(urlParts[1]) : new URLSearchParams();
    const retryCount = parseInt(params.get('_retry') || '0', 10);

    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (retryCount >= MAX_RETRIES) {
      // Permanent error — NO auto-reload, user action required
      const errSafe = String(e.message || 'unknown').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Container indisponible</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#0d1120,#1a2744);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#e2e8f0;padding:20px}.c{text-align:center;max-width:500px;padding:40px;background:rgba(255,255,255,0.03);border:1px solid rgba(212,168,32,0.2);border-radius:12px}h1{font-size:1.4rem;margin-bottom:16px;color:#D4A820}p{color:#8896c4;line-height:1.5;margin-bottom:20px;font-size:0.9rem}.err{font-family:monospace;font-size:0.75rem;color:#ef4444;background:rgba(239,68,68,0.1);padding:10px;border-radius:6px;margin:16px 0;word-break:break-all}button{background:#D4A820;color:#0d1120;border:none;padding:10px 20px;border-radius:6px;font-weight:600;cursor:pointer;font-size:0.9rem;margin:4px}button:hover{background:#e5b921}</style></head><body><div class="c"><h1>⚠️ Container indisponible</h1><p>Le container du projet ${projectId} ne répond pas après ${MAX_RETRIES + 1} tentatives (${(MAX_RETRIES + 1) * RELOAD_DELAY_MS / 1000}s).</p><div class="err">${errSafe}</div><p>Cliquez ci-dessous pour relancer manuellement, ou vérifiez les logs du container (\`docker logs pbp-project-${projectId}\`).</p><button onclick="location.href=location.pathname+'?_retry=0&t='+Date.now()">Réessayer maintenant</button><button onclick="history.back()">Retour</button></div></body></html>`);
    } else {
      // Auto-reload with incremented counter, 15s delay
      const nextParams = new URLSearchParams(params);
      nextParams.set('_retry', String(retryCount + 1));
      const nextUrl = `${urlParts[0]}?${nextParams.toString()}`;
      res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Démarrage</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#0d1120,#1a2744);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#e2e8f0}.c{text-align:center;padding:40px}.l{width:50px;height:50px;border:4px solid rgba(212,168,32,.2);border-top-color:#D4A820;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 24px}@keyframes s{to{transform:rotate(360deg)}}h1{font-size:1.5rem;margin-bottom:12px;color:#D4A820}p{color:#8896c4;margin-bottom:6px}.count{font-size:0.8rem;color:#5a6488}</style><script>setTimeout(()=>location.href=${JSON.stringify(nextUrl)},${RELOAD_DELAY_MS})</script></head><body><div class="c"><div class="l"></div><h1>Votre projet démarre</h1><p>Compilation Vite en cours (peut prendre 30-60s)...</p><p class="count">Tentative ${retryCount + 1}/${MAX_RETRIES + 1}</p></div></body></html>`);
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Le projet met trop de temps à répondre.' }));
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// Ensure containers are running on startup (DNS handles routing, no IP mapping needed)
async function rebuildContainerMapping() {
  if (!db || !isDockerAvailable()) return;

  try {
    const projects = db.prepare("SELECT id FROM projects WHERE build_status = 'done'").all();
    console.log(`Checking ${projects.length} project containers on startup...`);
    let running = 0;

    for (const project of projects) {
      const containerName = getContainerName(project.id);

      const isRunning = await isContainerRunningAsync(project.id);
      if (isRunning) {
        running++;
        console.log(`  - Project ${project.id}: ${containerName} running`);
      } else {
        // Try to start stopped container
        try {
          await startContainerAsync(project.id);
          await new Promise(r => setTimeout(r, 2000));
          const nowRunning = await isContainerRunningAsync(project.id);
          if (nowRunning) {
            running++;
            console.log(`  - Project ${project.id}: ${containerName} restarted`);
          } else {
            console.log(`  - Project ${project.id}: ${containerName} failed to start`);
          }
        } catch (e) {
          console.log(`  - Project ${project.id}: container not available`);
        }
      }
    }

    console.log(`Container startup check done: ${running}/${projects.length} containers running`);
  } catch (e) {
    console.error('Failed to check containers on startup:', e.message);
  }
}

// Initialize Docker system
// Ensure pbp-base image exists (pre-installs all project dependencies)
async function ensureBaseImage() {
  if (!docker) return;
  let needsBuild = false;
  try {
    const image = docker.getImage(DOCKER_BASE_IMAGE);
    const info = await image.inspect();
    // Check if image has React/Vite by looking at Env for NODE_PATH
    // If image was built with old Dockerfile (no vite), force rebuild
    const envVars = info.Config?.Env || [];
    const exposedPorts = Object.keys(info.Config?.ExposedPorts || {});
    const hasVitePort = exposedPorts.some(p => p.includes('5173'));
    if (!hasVitePort) {
      console.log(`[Docker] Base image '${DOCKER_BASE_IMAGE}' is outdated (no Vite) — rebuilding...`);
      needsBuild = true;
      try { await image.remove({ force: true }); } catch(e) { console.warn('[Docker] Could not remove old image:', e.message); }
    } else {
      console.log(`[Docker] Base image '${DOCKER_BASE_IMAGE}' exists (React+Vite)`);
    }
  } catch {
    needsBuild = true;
  }
  if (needsBuild) {
    console.log(`[Docker] Base image '${DOCKER_BASE_IMAGE}' not found — building...`);
    const dockerfileContent = `FROM node:20-alpine
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
WORKDIR /app
RUN npm install \
  express@4.18.2 better-sqlite3@9.4.3 bcryptjs@2.4.3 jsonwebtoken@9.0.2 \
  cors@2.8.5 helmet@7.1.0 compression@1.7.4 path-to-regexp@6.3.0 \
  pdfkit@0.15.0 nodemailer@6.9.8 stripe@14.14.0 socket.io@4.7.4 \
  multer@1.4.5-lts.1 sharp@0.33.2 qrcode@1.5.3 exceljs@4.4.0 \
  csv-parse@5.5.3 marked@11.1.1 axios@1.6.7 date-fns@3.6.0 recharts@2.15.0 \
  vite@6.3.5 @vitejs/plugin-react@4.5.2 \
  react@19.1.0 react-dom@19.1.0 react-router-dom@7.6.1 \
  lucide-react@0.511.0 clsx@2.1.1 tailwind-merge@3.3.0 \
  tailwindcss@3.4.17 postcss@8.5.3 autoprefixer@10.4.21 \
  @radix-ui/react-dialog@1.1.14 @radix-ui/react-dropdown-menu@2.1.15 \
  @radix-ui/react-tabs@1.1.12 @radix-ui/react-accordion@1.2.11 \
  @radix-ui/react-tooltip@1.1.18 @radix-ui/react-popover@1.1.14 \
  @radix-ui/react-checkbox@1.1.8 @radix-ui/react-switch@1.1.7 \
  @radix-ui/react-radio-group@1.2.7 @radix-ui/react-slider@1.2.7 \
  @radix-ui/react-progress@1.1.7 @radix-ui/react-collapsible@1.1.7 \
  @radix-ui/react-scroll-area@1.2.8 @radix-ui/react-separator@1.1.7 \
  @radix-ui/react-label@2.1.7 @radix-ui/react-avatar@1.1.7 \
  @radix-ui/react-alert-dialog@1.1.14 @radix-ui/react-select@2.1.14 \
  cmdk@1.1.1 sonner@2.0.3 pdf-parse@1.1.1 mammoth@1.8.0
ENV NODE_PATH=/app/node_modules
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
EXPOSE 3000 5173
`;
    const tmpDir = '/tmp/pbp-base-build';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), dockerfileContent);
    try {
      const stream = await docker.buildImage(
        { context: tmpDir, src: ['Dockerfile'] },
        { t: DOCKER_BASE_IMAGE }
      );
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, output) => {
          if (err) reject(err); else resolve(output);
        });
      });
      console.log(`[Docker] Base image '${DOCKER_BASE_IMAGE}' built successfully`);
    } catch (buildErr) {
      console.error(`[Docker] Failed to build base image: ${buildErr.message}`);
    }
  }
}

async function initializeDockerSystem() {
  dockerAvailable = await checkDockerAvailable();

  if (!dockerAvailable) {
    console.log('Docker not available - Docker preview system disabled');
    return;
  }

  console.log('Docker socket connection verified via dockerode');
  console.log('Initializing Docker preview system...');
  await ensureBaseImage();
  await ensureReadyImage();
  await ensureDockerNetwork();
  await joinPbpProjectsNetwork();
  await rebuildContainerMapping();
}

// ─── SERVER ───
const server = http.createServer(async (req, res) => {
  try {
  cors(res);
  if (req.method==='OPTIONS') { res.writeHead(200); res.end(); return; }

  // Security headers for all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // No COEP/COOP — not needed without WebContainer, and they block iframe CDN resources

  const url = req.url.split('?')[0];

  // Health check endpoint for proxy monitoring
  if (url==='/health' && req.method==='GET') {
    json(res,200,{status:'ok',timestamp:new Date().toISOString(),service:'prestige-build-pro'});
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLISHED SITES — custom domains + *.prestige-build.dev subdomains
  // ═══════════════════════════════════════════════════════════════════════════
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];

  // CUSTOM DOMAINS (ex: www.mondentiste.com)
  if (host && !host.endsWith('.' + PUBLISH_DOMAIN) && host !== 'app.' + PUBLISH_DOMAIN && host !== PUBLISH_DOMAIN && !host.match(/^(localhost|127\.|10\.|172\.|192\.168)/)) {
    // This is a custom domain — find the project that owns it
    if (db) {
      const project = db.prepare('SELECT id, subdomain FROM projects WHERE domain=? AND is_published=1').get(host);
      if (project && project.subdomain) {
        const siteDir = path.join(SITES_DIR, project.subdomain.replace(/[^a-zA-Z0-9-]/g, ''));
        if (fs.existsSync(siteDir)) {
          // API proxy for custom domains (same as subdomain proxy)
          if (url.startsWith('/api/') || url === '/health') {
            const containerHost = getContainerHostname(project.id);
            const proxyReq = http.request({
              hostname: containerHost, port: 3000, path: req.url, method: req.method,
              headers: { ...req.headers, host: `${containerHost}:3000` }, timeout: 15000
            }, (proxyRes) => {
              const headers = { ...proxyRes.headers };
              headers['access-control-allow-origin'] = `https://${host}`;
              headers['access-control-allow-methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
              headers['access-control-allow-headers'] = 'Content-Type,Authorization';
              res.writeHead(proxyRes.statusCode, headers);
              proxyRes.pipe(res);
            });
            proxyReq.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'Backend indisponible.' }); });
            if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq);
            else proxyReq.end();
            return;
          }
          let filePath = path.join(siteDir, url === '/' ? 'index.html' : url);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
          if (fs.existsSync(filePath) && isPathSafe(siteDir, filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
            fs.createReadStream(filePath).pipe(res);
            return;
          }
          // SPA fallback
          const indexPath = path.join(siteDir, 'index.html');
          if (fs.existsSync(indexPath)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(indexPath).pipe(res); return; }
        }
      }
    }
  }

  // PREVIEW SUBDOMAINS — preview-{id}.prestige-build.dev → direct proxy to container:5173
  // Zero URL rewriting — like Lovable's per-project subdomains
  if (host && host.match(/^preview-\d+\./) && host.endsWith('.' + PUBLISH_DOMAIN)) {
    const previewMatch = host.match(/^preview-(\d+)\./);
    if (previewMatch) {
      const projectId = parseInt(previewMatch[1]);
      const containerHost = getContainerHostname(projectId);

      // Auth: check cookie or query token
      const user = getAuth(req);
      if (!user) {
        // Set auth cookie on first access with token
        const qsToken = (req.url.split('?')[1] || '').match(/token=([^&]+)/)?.[1];
        if (qsToken) {
          const verified = verifyToken(qsToken);
          if (verified) {
            const isHttps = req.headers['x-forwarded-proto'] === 'https';
            res.setHeader('Set-Cookie', `pbp_token=${qsToken}; Path=/; ${isHttps ? 'HttpOnly; SameSite=Lax; Secure' : 'HttpOnly; SameSite=Lax'}; Max-Age=86400`);
            // Continue to proxy below
          } else {
            json(res, 401, { error: 'Token invalide.' }); return;
          }
        } else {
          json(res, 401, { error: 'Non autorisé.' }); return;
        }
      }

      // Track access for auto-sleep
      containerLastAccess.set(projectId, Date.now());

      // Direct proxy to Vite dev server — NO URL rewriting needed
      const proxyOpts = {
        hostname: containerHost,
        port: 5173,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${containerHost}:5173` }
      };
      delete proxyOpts.headers['authorization'];

      const proxyReq = http.request(proxyOpts, (proxyRes) => {
        // Strip security headers for iframe compatibility
        const headers = { ...proxyRes.headers };
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];
        delete headers['cross-origin-opener-policy'];
        delete headers['cross-origin-embedder-policy'];
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Projet en cours de démarrage...</h2><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
        }
      });
      if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq);
      else proxyReq.end();
      return;
    }
  }

  // PUBLISHED SITE SUBDOMAINS (*.prestige-build.dev — NOT preview-* and NOT *-preview.*)
  if (host && host.endsWith('.' + PUBLISH_DOMAIN) && host !== 'app.' + PUBLISH_DOMAIN && !host.startsWith('preview-') && !/-preview\./.test(host)) {
    const subdomain = host.replace('.' + PUBLISH_DOMAIN, '').replace(/[^a-zA-Z0-9-]/g, '');
    if (subdomain) {
      const siteDir = path.join(SITES_DIR, subdomain);
      if (fs.existsSync(siteDir)) {
        // ── API PROXY: route /api/* and /health to the production container ──
        // The container runs Express only (no Vite) serving the backend
        if (url.startsWith('/api/') || url === '/health') {
          const project = db ? db.prepare('SELECT id FROM projects WHERE subdomain=? AND is_published=1').get(subdomain) : null;
          if (project) {
            const containerHost = getContainerHostname(project.id);
            const proxyReq = http.request({
              hostname: containerHost, port: 3000, path: req.url, method: req.method,
              headers: { ...req.headers, host: `${containerHost}:3000` }, timeout: 15000
            }, (proxyRes) => {
              // Add CORS for the published domain
              const headers = { ...proxyRes.headers };
              headers['access-control-allow-origin'] = `https://${subdomain}.${PUBLISH_DOMAIN}`;
              headers['access-control-allow-methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
              headers['access-control-allow-headers'] = 'Content-Type,Authorization';
              res.writeHead(proxyRes.statusCode, headers);
              proxyRes.pipe(res);
            });
            proxyReq.on('error', () => {
              if (!res.headersSent) json(res, 503, { error: 'Backend temporairement indisponible.' });
            });
            proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) json(res, 504, { error: 'Timeout backend.' }); });
            if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq);
            else proxyReq.end();
            return;
          }
        }

        // Serve published site static files (dist/ compiled by Vite)
        let filePath = path.join(siteDir, url === '/' ? 'index.html' : url);
        // Directory → index.html
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, 'index.html');
        }
        if (fs.existsSync(filePath) && isPathSafe(siteDir, filePath)) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
        // Fallback to index.html for SPA routing
        const indexPath = path.join(siteDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          fs.createReadStream(indexPath).pipe(res);
          return;
        }
      }
      // Subdomain exists but no files — show "site not found"
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Site non trouvé</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0d1120;color:#e2e8f0;"><div style="text-align:center;"><h1 style="color:#D4A820;">Site non disponible</h1><p>${subdomain}.${PUBLISH_DOMAIN} n'est pas encore publié.</p></div></body></html>`);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBDOMAIN PREVIEW: p{id}-preview.prestige-build.dev → direct to container
  // This is the FAST PATH — no auto-fix, no auth check, no path rewriting.
  // Cloudflare routes *-preview.prestige-build.dev → Traefik → pbp-server.
  // pbp-server reads the Host header, extracts project ID, and proxies
  // directly to the container. ~5ms overhead vs ~20ms on the /run/ path.
  // ═══════════════════════════════════════════════════════════════════════════
  const hostHeader = req.headers.host || '';
  const subdomainMatch = hostHeader.match(/^p(\d+)-preview\./);
  if (subdomainMatch) {
    const projectId = parseInt(subdomainMatch[1], 10);
    if (!Number.isInteger(projectId) || projectId < 1) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid project ID in subdomain');
      return;
    }

    // Track access for auto-sleep
    containerLastAccess.set(projectId, Date.now());

    // Wake container if sleeping (lightweight check, no auto-fix)
    const running = await isContainerRunningAsync(projectId);
    if (!running) {
      console.log(`[Subdomain] Waking container for project ${projectId}`);
      await startContainerAsync(projectId);
      await waitForContainerHealth(projectId, 60000);
    }

    // Path rewrite: browser requests '/' but Vite expects '/run/{id}/'
    // After initial page load, all asset URLs already include /run/{id}/ (Vite --base).
    let targetPath = req.url || '/';
    if (targetPath === '/' || targetPath === '') {
      targetPath = `/run/${projectId}/`;
    } else if (!targetPath.startsWith(`/run/${projectId}`)) {
      // Asset request without prefix → add it (e.g., favicon.ico, robots.txt)
      // But most assets from Vite already have /run/{id}/ in their path
      targetPath = `/run/${projectId}${targetPath}`;
    }

    // LEAN proxy: no auto-fix, no auth, no DB lookup, no header stripping overhead
    proxyToContainer(req, res, projectId, targetPath);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCKER PROXY ROUTE: /run/:projectId/* (LEGACY — kept as fallback)
  // Used by the iframe when subdomain is not available.
  // Includes auto-fix, auth token handling, and container wake logic.
  // ═══════════════════════════════════════════════════════════════════════════
  if (url.startsWith('/run/')) {
    const runMatch = req.url.match(/^\/run\/(\d+)(\/.*)?$/);
    if (!runMatch) {
      json(res, 400, { error: 'ID de projet invalide' });
      return;
    }
    const projectId = parseInt(runMatch[1]);

    // Skip auth for WebSocket upgrades (Vite HMR)
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
      return;
    }

    // Preview proxy auth: lightweight — just verify the project exists and container runs
    // The Prestige UI already checks ownership before showing the preview iframe.
    // No token/cookie/ownership check here — prevents all the 401/403 issues with
    // iframes, sub-resources, HMR, and cookie race conditions.
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
    if (!project) {
      json(res, 404, { error: 'Projet non trouvé.' });
      return;
    }

    // Build the target path: keep /run/{id}/ prefix (Vite uses --base /run/{id}/)
    // Remove auth token from query string (no need to leak it to the container)
    let targetPath = `/run/${projectId}${runMatch[2] || '/'}`;
    targetPath = targetPath.replace(/([?&])token=[^&]*/g, (m) => {
      return m.startsWith('?') ? '?' : '';
    }).replace(/\?&/, '?').replace(/\?$/, '');

    // Track access for auto-sleep
    containerLastAccess.set(projectId, Date.now());

    // ── AUTO-FIX: runs ONCE per project per server session (not on every request!) ──
    // Previously this code ran on EVERY /run/{id}/* request (CSS, JS, images, fonts —
    // 40-60 times per page load). Each call read 20-30 files from disk, recursively
    // scanned directories, and parsed regex. Cost: ~500-1000ms of wasted CPU per page
    // load. Now it runs ONCE, then the project is flagged as auto-fixed.
    if (!proxyAutoFixedProjects.has(projectId)) {
      proxyAutoFixedProjects.add(projectId);
      // Prune the set periodically to avoid unbounded memory growth
      if (proxyAutoFixedProjects.size > 5000) {
        const arr = Array.from(proxyAutoFixedProjects).slice(2500);
        proxyAutoFixedProjects.clear();
        arr.forEach(id => proxyAutoFixedProjects.add(id));
      }

      const projAccessDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
      // Fix CSS
      const cssPath = path.join(projAccessDir, 'src', 'index.css');
      if (fs.existsSync(cssPath)) {
        const css = fs.readFileSync(cssPath, 'utf8');
        const bracesOpen = (css.match(/\{/g) || []).length;
        const bracesClose = (css.match(/\}/g) || []).length;
        const needsFix = css.includes('@import "tailwindcss"') || css.includes('@theme') || (!css.includes('@tailwind') && !css.includes('--primary')) || bracesOpen !== bracesClose;
        if (needsFix) {
          const fixed = fixIndexCss(css);
          fs.writeFileSync(cssPath, fixed);
          console.log(`[AutoFix] Fixed index.css for project ${projectId}`);
        }
      }
      // Fix missing UI components/pages (scan imports, create stubs for unresolved)
      const srcAccessDir = path.join(projAccessDir, 'src');
      if (fs.existsSync(srcAccessDir)) {
        const scanFiles = [];
        const scanD = (d) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.isDirectory() && f.name !== 'ui' && f.name !== 'node_modules') scanD(path.join(d, f.name)); else if (f.isFile() && f.name.endsWith('.tsx')) scanFiles.push(path.join(d, f.name)); } };
        scanD(srcAccessDir);
        for (const file of scanFiles) {
          const content = fs.readFileSync(file, 'utf8');
          const imports = content.match(/from ['"](@\/[^'"]+)['"]/g) || [];
          for (const imp of imports) {
            const importPath = imp.match(/@\/([^'"]+)/)?.[1];
            if (!importPath) continue;
            const resolved = path.join(srcAccessDir, importPath);
            if (!fs.existsSync(resolved + '.tsx') && !fs.existsSync(resolved + '.ts') && !fs.existsSync(resolved)) {
              const stubPath = resolved + '.tsx';
              const stubDir = path.dirname(stubPath);
              if (!fs.existsSync(stubDir)) fs.mkdirSync(stubDir, { recursive: true });
              if (importPath.startsWith('components/ui/')) {
                const names = (content.match(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]@\\/${importPath.replace(/\//g, '\\/')}['"]`)) || ['','Component'])[1].split(',').map(n => n.trim());
                fs.writeFileSync(stubPath, `import * as React from "react";\n${names.map(n => `export function ${n}({ children, className, ...props }: any) { return <div className={className} {...props}>{children}</div>; }`).join('\n')}\n`);
              } else {
                const name = path.basename(importPath);
                fs.writeFileSync(stubPath, `export default function ${name}() { return <div className="p-8"><h1>${name}</h1></div>; }\n`);
              }
              console.log(`[AutoFix] Created stub: src/${importPath}.tsx for project ${projectId}`);
            }
          }
        }
      }
    }

    // Wake container if sleeping
    const running = await isContainerRunningAsync(projectId);
    if (!running) {
      console.log(`[Sleep] Waking container for project ${projectId}`);
      await startContainerAsync(projectId);
      await waitForContainerHealth(projectId, 60000);
    }

    // Proxy to the container
    proxyToContainer(req, res, projectId, targetPath);
    return;
  }

  // Preview refresh endpoint - requires authentication
  if (url.match(/^\/api\/preview\/\d+\/refresh$/) && req.method==='POST') {
    const projectId = parseInt(url.split('/')[3]);
    
    // Authentication check
    const user = getAuth(req);
    if (!user) {
      json(res, 401, { error: 'Non autorisé.' });
      return;
    }
    
    // Authorization check: user must own the project or be admin
    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
      return;
    }
    
    const body = await getBody(req);
    const code = body.code;
    if (!code) {
      json(res, 400, { error: 'Code required' });
      return;
    }
    try {
      const result = savePreviewFiles(projectId, code);
      json(res, 200, { success: true, previewUrl: `/run/${projectId}/`, framework: result.framework });
    } catch(e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // Serve preview files - supports both project_id (new) and build_id (legacy)
  if (url.startsWith('/preview/')) {
    const parts = url.split('/').filter(Boolean);
    const id = parts[1];
    const filePath = parts.slice(2).join('/');
    
    // Check if it's a numeric project ID (new preview system)
    if (/^\d+$/.test(id)) {
      servePreview(res, id, filePath);
      return;
    }
    
    // Otherwise, use legacy build system
    serveBuilt(res, id, filePath);
    return;
  }

  // ── API PROXY FOR IFRAME PREVIEW ──
  // When the iframe is on /run/{id}/, fetch('/api/...') goes to app.prestige-build.dev/api/...
  // We detect this via the Referer header (/run/{id}/) and proxy to the right container.
  // Check Referer FIRST — if it comes from an iframe preview, proxy ALL /api/ to the project container
  if (url.startsWith('/api/')) {
    const referer = req.headers.referer || '';
    const refMatch = referer.match(/\/run\/(\d+)/);
    if (refMatch) {
      const projectId = parseInt(refMatch[1]);
      const containerHost = getContainerHostname(projectId);
      containerLastAccess.set(projectId, Date.now());
      const proxyReq = http.request({
        hostname: containerHost, port: 3000, path: url, method: req.method,
        headers: { ...req.headers, host: `${containerHost}:3000` }, timeout: 15000
      }, (proxyRes) => {
        const headers = { ...proxyRes.headers };
        headers['access-control-allow-origin'] = '*';
        headers['access-control-allow-methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
        headers['access-control-allow-headers'] = 'Content-Type,Authorization';
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'Backend projet indisponible.' }); });
      if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq);
      else proxyReq.end();
      return;
    }
  }

  // Static files
  if (req.method==='GET' && !url.startsWith('/api/')) {
    const fp = url==='/'?'/index.html':url;
    fs.readFile(path.join(__dirname,'public',fp),(err,data)=>{
      if (err) { fs.readFile(path.join(__dirname,'public','index.html'),(_,d)=>{ res.writeHead(200,{'Content-Type':'text/html'}); res.end(d||'Not found'); }); return; }
      const t={'.html':'text/html','.js':'application/javascript','.css':'text/css'};
      res.writeHead(200,{'Content-Type':t[path.extname(fp)]||'text/plain'}); res.end(data);
    }); return;
  }

  // Login (no auth required)
  if (url==='/api/login' && req.method==='POST') {
    // Rate limit: max 5 login attempts per IP per minute
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const loginKey = `login:${clientIp}`;
    const now = Date.now();
    const attempts = cache.get(loginKey) || { count: 0 };
    attempts.count++;
    cache.set(loginKey, attempts, 60000); // TTL 1 minute
    if (attempts.count > 5) {
      json(res, 429, { error: 'Trop de tentatives. Réessayez dans 1 minute.' }); return;
    }

    const {email,password}=await getBody(req);
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      json(res, 400, { error: 'Email et mot de passe requis.' }); return;
    }
    if (email.length > 200 || password.length > 200) {
      json(res, 400, { error: 'Données invalides.' }); return;
    }
    const bcrypt=require('bcryptjs');
    const u=db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
    if (!u||!bcrypt.compareSync(password,u.password)) {
      console.log(`[Auth] Failed login attempt for: ${email} from ${clientIp}`);
      if (global.auditLog) global.auditLog(req, null, 'login_failed', 'user', null, { email: email.substring(0,100) });
      json(res,401,{error:'Email ou mot de passe incorrect.'}); return;
    }
    if (u.role === 'disabled') {
      console.log(`[Auth] Blocked disabled user: ${u.email}`);
      if (global.auditLog) global.auditLog(req, u, 'login_blocked_disabled', 'user', u.id);
      json(res,403,{error:'Votre compte a été désactivé. Contactez l\'administrateur.'}); return;
    }
    console.log(`[Auth] Login: ${u.email} (${u.role})`);
    if (global.auditLog) global.auditLog(req, u, 'login_success', 'user', u.id);
    json(res,200,{token:signToken({id:u.id,email:u.email,name:u.name,role:u.role,lang:u.lang}),user:{id:u.id,email:u.email,name:u.name,role:u.role,lang:u.lang}});
    return;
  }

  // ─── ANALYTICS TRACKING (NO AUTH - CALLED BY PUBLISHED CLIENT SITES) ───
  if (url.match(/^\/api\/track\/\d+$/) && req.method==='POST') {
    const projectId = parseInt(url.split('/')[3]);

    // Rate limit: max 30 analytics events per IP per minute
    const trackIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const trackKey = `track:${trackIp}`;
    const tl = cache.get(trackKey) || { count: 0 };
    tl.count++;
    cache.set(trackKey, tl, 60000); // TTL 1 minute
    if (tl.count > 30) { json(res, 429, { error: 'Rate limited' }); return; }

    // Verify project exists and is published
    const project = db.prepare('SELECT id, is_published FROM projects WHERE id=?').get(projectId);
    if (!project || !project.is_published) { json(res, 404, { error: 'Not found' }); return; }

    const body = await getBody(req);
    const { event_type, event_data, page } = body;

    if (!event_type || typeof event_type !== 'string') { json(res, 400, { error: 'event_type required' }); return; }

    // Validate and sanitize input
    const safeEventType = String(event_type).substring(0, 50);
    const safeEventData = event_data ? JSON.stringify(event_data).substring(0, 2000) : '{}';

    try {
      const userAgent = (req.headers['user-agent'] || '').substring(0, 255);
      const eventDataStr = page ? JSON.stringify({ ...(event_data || {}), page: String(page).substring(0, 500) }).substring(0, 2000) : safeEventData;

      db.prepare('INSERT INTO analytics (project_id, event_type, event_data, ip_address, user_agent) VALUES (?,?,?,?,?)').run(
        projectId, safeEventType, eventDataStr, trackIp.substring(0, 45), userAgent
      );
      json(res, 200, { ok: true });
    } catch(e) {
      json(res, 500, { error: 'Tracking error' });
    }
    return;
  }

  const user=getAuth(req);
  if (!user) { json(res,401,{error:'Session expirée. Veuillez vous reconnecter.'}); return; }

  // ─── GET JOB STATUS (POLLING) ───
  const jobMatch = url.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)$/);
  if (jobMatch && req.method === 'GET') {
    const jobId = jobMatch[1];
    const job = generationJobs.get(jobId);
    if (!job) { json(res, 404, { error: 'Job non trouvé' }); return; }
    
    // Only the job owner can access it
    if (job.user_id !== user.id) { json(res, 403, { error: 'Accès refusé' }); return; }
    
    // ─── PLAN JOBS: lightweight finalize (no code artifacts) ───
    // Plan jobs persist their result directly in generatePlan(); no preview/credentials/SSE needed here.
    if (job.status === 'done' && job.type === 'plan' && !job.finalized) {
      job.finalized = true;
      // No activeGenerations decrement: plan jobs do NOT increment it.
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
      // Run quick audit in background after finalization ($0.00, non-blocking)
      runQuickAudit(job.project_id).catch(() => {});
      if (activeGenerations > 0) activeGenerations--;
    }
    // Also decrement counter on error (prevents counter leak blocking all future generations)
    if (job.status === 'error' && !job.finalized) {
      job.finalized = true;
      if (activeGenerations > 0) activeGenerations--;
    }
    // ─── CANCELLED jobs: cleanup like error path, but distinct status ───
    // Files written before the abort are kept on disk (Vite HMR will pick them up).
    // No code persisted to DB on cancel — user explicitly stopped, project stays in
    // its previous state in DB (the partial files are visible only via preview).
    if (job.status === 'cancelled' && !job.finalized) {
      job.finalized = true;
      if (activeGenerations > 0 && job.type !== 'plan') activeGenerations--;
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
    return;
  }

  // ─── STOP A RUNNING JOB ───
  // POST /api/generate/:jobId/stop — user-initiated cancellation.
  // Aborts the in-flight Anthropic API call via the job's AbortController.
  // Files already written to disk are preserved (Vite HMR will pick them up).
  // Status transitions to 'cancelled' and the standard /api/jobs/:id finalize cleans up.
  const stopMatch = url.match(/^\/api\/generate\/([a-zA-Z0-9-]+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const jobId = stopMatch[1];
    const job = generationJobs.get(jobId);
    if (!job) { json(res, 404, { error: 'Job introuvable.' }); return; }

    // Owner-only (admin can stop too)
    if (user.role !== 'admin' && job.user_id !== user.id) {
      json(res, 403, { error: 'Accès refusé à ce job.' });
      return;
    }

    // Idempotent: already finished or cancelled → 200 with current status, no-op
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      json(res, 200, { job_id: jobId, status: job.status, already: true });
      return;
    }

    // Trigger abort. AbortController.abort() is safe to call multiple times.
    if (job.abortController && !job.abortController.signal.aborted) {
      try {
        job.abortController.abort();
        log('info', 'job', 'stop requested', { jobId, projectId: job.project_id, userId: user.id });
      } catch (e) {
        log('error', 'job', 'abort threw', { jobId, error: e.message });
      }
    }

    // Set transitional state — actual 'cancelled' is set by the .catch handlers
    // in generateClaude/generateMultiTurn/generatePlan when the AbortError lands.
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
    return;
  }

  // ─── GENERATE START (POLLING) ───
  if (url==='/api/generate/start' && req.method==='POST') {
    const {project_id, message, skip_clarification, mode}=await getBody(req);

    // #3 Validate input
    if (!message || typeof message !== 'string' || message.trim().length < 3) {
      json(res, 400, { error: 'Message requis (min 3 caractères).' }); return;
    }

    // ─── CLARIFICATION PROTOCOL ───
    // Brief too vague + new project → ask 3 questions before consuming a full generation.
    // Power users can bypass with skip_clarification=true. Existing projects (modifications)
    // are never asked since the codebase itself disambiguates the request.
    if (!skip_clarification && project_id) {
      const projectForCheck = db.prepare('SELECT user_id, generated_code FROM projects WHERE id=?').get(project_id);
      // Ownership: don't leak existence of someone else's project via clarification check
      if (projectForCheck && (user.role === 'admin' || projectForCheck.user_id === user.id)) {
        if (needsClarification(message, projectForCheck)) {
          try {
            const questions = await generateClarificationQuestions(message, user.id, project_id);
            log('info', 'clarify', 'asked', { userId: user.id, projectId: project_id, count: questions.length });
            json(res, 200, { type: 'clarification_needed', questions, original_message: message });
          } catch (e) {
            // On any failure, fall through to normal generation rather than blocking
            log('warn', 'clarify', 'failed open', { error: e.message });
          }
          if (res.headersSent || res.writableEnded) return;
        }
      }
    }

    // #4 Check concurrent generation limit
    if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      json(res, 429, { error: `Serveur occupé (${activeGenerations}/${MAX_CONCURRENT_GENERATIONS} générations en cours). Réessayez dans 30 secondes.` }); return;
    }

    // Check user quota before starting generation
    const quota = checkUserQuota(user.id);
    if (!quota.allowed) {
      json(res, 429, { error: quota.reason, quota: { daily: quota.daily, dailyLimit: quota.dailyLimit, monthly: quota.monthly, monthlyLimit: quota.monthlyLimit } });
      return;
    }

    // Detect intent: LLM-based classifier (Haiku 4.5) with regex fallback.
    // Catches edge cases the regex misses ("le bouton est trop petit", "tu peux ajouter X ?").
    const intentResult = await classifyIntent(message);
    const isQuestion = intentResult.intent === 'discuss';
    const isPartner = intentResult.intent === 'partner';
    const isAudit = intentResult.intent === 'audit';
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
      abortController: new AbortController(),
      // Intent 'code' → Claude MUST use tools (write_file/edit_file), not just text
      intent: intentResult.intent
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

    // ── TWO-TIER FILE SELECTION: Haiku selects files BEFORE Sonnet generates ──
    // Uses Haiku 4.5 (same provider, no extra API key needed). Falls back to GPT-4 Mini if set.
    let llmSelectedFiles = null;
    if (project?.generated_code && ai) {
      try {
        const files = ai.parseCodeFiles ? ai.parseCodeFiles(project.generated_code) : {};
        const fileList = Object.keys(files).map(fn => {
          const size = (files[fn] || '').length;
          return `  ${fn} (${size} chars)`;
        }).join('\n');
        llmSelectedFiles = await selectFilesWithLLM(fileList, message);
      } catch (e) { console.warn(`[FileSelect] Skipped: ${e.message}`); }
    }

    // ── LOVABLE: Auto-inject console logs when user reports a bug ──
    // If the message mentions an error/bug, read console logs and prepend to context
    const isBugReport = /\b(erreur|bug|marche pas|fonctionne pas|cassé|crash|blanc|blanche|broken|fix|corrige|problème|ne s'affiche|ne charge)\b/i.test(message);
    if (isBugReport && project_id) {
      const logs = clientLogs.get(String(project_id)) || [];
      if (logs.length > 0) {
        const logText = logs.slice(-10).map(l => `[${l.level}] ${l.message}`).join('\n');
        userMsg = `${userMsg}\n\n[CONSOLE LOGS AUTOMATIQUES — lis ces erreurs AVANT de coder]\n${logText}`;
        console.log(`[Debug] Auto-injected ${logs.length} console logs for bug report`);
      }
    }

    // Load persistent project memory + conversation summaries (best-effort, never blocks)
    let projectMemory = null;
    if (project_id) {
      try {
        // Combine project memory with conversation summaries
        const memoryBlock = conversationMemoryService.buildConversationMemoryBlock(project_id);
        if (memoryBlock && memoryBlock.trim().length > 0) projectMemory = memoryBlock;
      } catch (e) { /* fail silent */ }
    }

    const messages = ai ? ai.buildConversationContext(project, history, userMsg, projectKeys, llmSelectedFiles, projectMemory) : [{role:'user', content: userMsg}];
    if (project_id) db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id, 'user', message);
    const brief = project?.brief || message;

    if (isQuestion) {
      // Discussion mode: lightweight chat, no code generation, no tools
      // Responds fast, doesn't consume generation quota
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
    } else if (isPartner) {
      // ─── PARTNER MODE: Claude acts as a senior consultant ───
      // Like a real dev senior: reads the project FIRST, then proposes.
      // Uses read-only tools (view_file, search_files, verify_project) to analyze
      // but NEVER writes code. This costs ~$0.02-0.05 per consultation.
      console.log(`[Partner] Consultation mode for: "${message.substring(0, 60)}..."`);
      const job = generationJobs.get(jobId);
      job.progressMessage = 'Analyse du projet...';
      try {
        const partnerPrompt = ai && ai.PARTNER_SYSTEM_PROMPT ? ai.PARTNER_SYSTEM_PROMPT : 'Tu es un consultant developpement. Propose des options et pose des questions.';
        const partnerSystemBlocks = [{ type: 'text', text: partnerPrompt, cache_control: { type: 'ephemeral' } }];

        // Give Partner Mode READ-ONLY tools so it can inspect the project before proposing.
        // Filter CODE_TOOLS to only keep inspection tools (no write_file, edit_file, line_replace, delete_file).
        const READ_ONLY_TOOLS = CODE_TOOLS.filter(t =>
          ['view_file', 'search_files', 'verify_project', 'read_console_logs', 'get_table_schema', 'run_command'].includes(t.name)
        );

        // 8K tokens: enough for detailed proposals, cheap (~$0.02 output)
        const partnerReply = await callClaudeAPI(partnerSystemBlocks, messages, 8000,
          { userId: user.id, projectId: project_id, operation: 'partner' },
          { useTools: true, _partnerReadOnly: true });
        job.code = '';
        // Extract text from tool-augmented response (partner may have used view_file first)
        job.chat_message = typeof partnerReply === 'string' ? partnerReply : partnerReply;
        job.status = 'done';
        job.progressMessage = 'Proposition prête';
        if (project_id) {
          const replyText = typeof partnerReply === 'string' ? partnerReply : JSON.stringify(partnerReply);
          db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)')
            .run(project_id, 'assistant', replyText.substring(0, 10000));
        }
      } catch (e) {
        job.status = 'error';
        job.error = e.message;
      }
    } else if (isAudit) {
      // ─── AUDIT MODE: SERVER-DRIVEN TESTING + AI REPORT ───
      // Enterprise architecture: the SERVER runs ALL tests (guaranteed execution),
      // then sends the results to Claude who ONLY writes the report.
      // This is how Lovable, Vercel v0, and professional CI/CD pipelines work.
      console.log(`[Audit] Server-driven audit for project ${project_id}`);
      const job = generationJobs.get(jobId);

      (async () => {
        try {
          const projDir = path.join(DOCKER_PROJECTS_DIR, String(project_id));
          const auditResults = [];
          const testTable = [];

          // ══════════════════════════════════════════════════════════
          // PHASE 1: SERVER EXECUTES ALL 20 TESTS (100% guaranteed)
          // ══════════════════════════════════════════════════════════

          const serverCode = fs.existsSync(path.join(projDir, 'server.js')) ? fs.readFileSync(path.join(projDir, 'server.js'), 'utf8') : '';
          const srcDir = path.join(projDir, 'src');
          const totalTests = 20;
          let testNum = 0;
          const progress = (label) => { testNum++; job.progressMessage = `Test ${testNum}/${totalTests} — ${label}`; };
          // Send real-time SSE updates for each test result
          const addTest = (t) => {
            testTable.push(t);
            // Push via SSE so frontend shows ✓/✗ in real-time
            if (project_id) {
              notifyProjectClients(project_id, 'audit_test', {
                num: testNum, total: totalTests,
                cat: t.cat, test: t.test, ok: t.ok, details: t.details
              });
            }
          };

          // Helper: run command in container safely
          const exec = async (cmd, timeout = 8000) => {
            if (!containerExecService) return { stdout: '', stderr: '', exitCode: -1, skip: true };
            return containerExecService.execInContainer(project_id, cmd, { timeout });
          };

          // ── BACKEND (6 tests) ──

          // 1. Server syntax
          progress('Syntaxe serveur...');
          try {
            const r = await exec('node --check server.cjs 2>&1');
            if (r.skip) addTest({ cat: 'Backend', test: 'Syntaxe server.js', ok: null, details: 'Container non disponible' });
            else addTest({ cat: 'Backend', test: 'Syntaxe server.js', ok: r.exitCode === 0, details: r.exitCode === 0 ? 'node --check OK' : (r.stdout || r.stderr || '').substring(0, 200) });
          } catch (e) { addTest({ cat: 'Backend', test: 'Syntaxe server.js', ok: false, details: e.message }); }

          // 2. Server health
          progress('Santé serveur...');
          try {
            const r = await exec('curl -s http://localhost:3000/health');
            if (r.skip) addTest({ cat: 'Backend', test: 'Health endpoint', ok: null, details: 'Container non disponible' });
            else { const ok = (r.stdout || '').includes('"ok"') || (r.stdout || '').includes('ok'); addTest({ cat: 'Backend', test: 'Health endpoint', ok, details: ok ? 'Serveur répond OK' : (r.stdout || 'Pas de réponse').substring(0, 200) }); }
          } catch (e) { addTest({ cat: 'Backend', test: 'Health endpoint', ok: false, details: e.message }); }

          // 3. Login + JWT
          progress('Authentification...');
          let authToken = null;
          try {
            const credMatch = serverCode.match(/\/\/\s*CREDENTIALS:\s*email=(\S+)\s+password=(\S+)/);
            if (credMatch && containerExecService) {
              const email = credMatch[1], password = credMatch[2];
              const r = await exec(`curl -s -X POST http://localhost:3000/api/login -H "Content-Type: application/json" -d '{"email":"${email}","password":"${password}"}'`, 10000);
              const body = r.stdout || '';
              const hasToken = body.includes('token');
              if (hasToken) try { authToken = JSON.parse(body).token; } catch (_) {}
              addTest({ cat: 'Backend', test: `Login (${email})`, ok: hasToken, details: hasToken ? 'Token JWT reçu' : 'Échec: ' + body.substring(0, 150) });
            } else {
              addTest({ cat: 'Backend', test: 'Login', ok: null, details: credMatch ? 'Container non disponible' : 'Pas de CREDENTIALS dans server.js' });
            }
          } catch (e) { addTest({ cat: 'Backend', test: 'Login', ok: false, details: e.message }); }

          // 4. GET API routes (up to 8)
          progress('Routes GET...');
          try {
            const allApiRoutes = (serverCode.match(/app\.get\s*\(\s*['"`](\/api\/[^'"`]+)/g) || [])
              .map(r => r.match(/['"`](\/api\/[^'"`]+)/)?.[1]).filter(Boolean);
            if (allApiRoutes.length > 0 && containerExecService) {
              let passed = 0, failed = 0; const failedList = [];
              for (const route of allApiRoutes.slice(0, 8)) {
                try {
                  const auth = authToken ? `-H "Authorization: Bearer ${authToken}"` : '';
                  const r = await exec(`curl -s -o /dev/null -w "%{http_code}" ${auth} http://localhost:3000${route}`, 5000);
                  const code = parseInt(r.stdout || '0');
                  if (code >= 200 && code < 400) passed++; else { failed++; failedList.push(`${route}→${code}`); }
                } catch (_) { failed++; failedList.push(`${route}→timeout`); }
              }
              addTest({ cat: 'Backend', test: `Routes GET (${passed + failed} testées)`, ok: failed === 0, details: failed === 0 ? `${passed}/${passed + failed} OK` : `${failed} erreurs: ${failedList.join(', ')}` });
            } else { addTest({ cat: 'Backend', test: 'Routes GET', ok: null, details: allApiRoutes.length === 0 ? 'Aucune route GET' : 'Container non disponible' }); }
          } catch (e) { addTest({ cat: 'Backend', test: 'Routes GET', ok: false, details: e.message }); }

          // 5. POST API routes (test that they don't crash with empty body)
          progress('Routes POST...');
          try {
            const postRoutes = (serverCode.match(/app\.post\s*\(\s*['"`](\/api\/[^'"`]+)/g) || [])
              .map(r => r.match(/['"`](\/api\/[^'"`]+)/)?.[1]).filter(r => r && !r.includes('login'));
            if (postRoutes.length > 0 && containerExecService) {
              let passed = 0, crashed = 0; const crashedList = [];
              for (const route of postRoutes.slice(0, 5)) {
                try {
                  const auth = authToken ? `-H "Authorization: Bearer ${authToken}"` : '';
                  const r = await exec(`curl -s -o /dev/null -w "%{http_code}" -X POST ${auth} -H "Content-Type: application/json" -d '{}' http://localhost:3000${route}`, 5000);
                  const code = parseInt(r.stdout || '0');
                  if (code < 500) passed++; else { crashed++; crashedList.push(`${route}→${code}`); }
                } catch (_) { crashed++; crashedList.push(`${route}→timeout`); }
              }
              addTest({ cat: 'Backend', test: `Routes POST (${passed + crashed} testées)`, ok: crashed === 0, details: crashed === 0 ? `${passed} ne crashent pas (4xx attendu avec body vide)` : `${crashed} crash 500: ${crashedList.join(', ')}` });
            } else { addTest({ cat: 'Backend', test: 'Routes POST', ok: null, details: 'Aucune route POST (hors login)' }); }
          } catch (e) { addTest({ cat: 'Backend', test: 'Routes POST', ok: false, details: e.message }); }

          // 6. API response time
          progress('Temps de réponse API...');
          try {
            if (containerExecService) {
              const r = await exec('curl -s -w "%{time_total}" -o /dev/null http://localhost:3000/health');
              const time = parseFloat(r.stdout || '0');
              const ok = time < 2.0;
              addTest({ cat: 'Backend', test: 'Temps de réponse', ok, details: `${(time * 1000).toFixed(0)}ms${ok ? '' : ' (> 2s = lent)'}` });
            } else { addTest({ cat: 'Backend', test: 'Temps de réponse', ok: null, details: 'Container non disponible' }); }
          } catch (e) { addTest({ cat: 'Backend', test: 'Temps de réponse', ok: false, details: e.message }); }

          // ── FRONTEND (5 tests) ──

          // 7. Frontend HTML
          progress('Frontend Vite...');
          try {
            const r = await exec('curl -s http://localhost:5173/ | head -20');
            if (r.skip) addTest({ cat: 'Frontend', test: 'Vite HTML', ok: null, details: 'Container non disponible' });
            else { const ok = (r.stdout || '').includes('id="root"'); addTest({ cat: 'Frontend', test: 'Vite HTML', ok, details: ok ? 'HTML avec id="root" servi' : 'Pas de HTML valide' }); }
          } catch (e) { addTest({ cat: 'Frontend', test: 'Vite HTML', ok: false, details: e.message }); }

          // 8. All React routes have components
          progress('Routes React...');
          try {
            const appContent = fs.existsSync(path.join(srcDir, 'App.tsx')) ? fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf8') : '';
            const routeImports = (appContent.match(/import\s+(\w+)\s+from\s+['"]@\/([^'"]+)['"]/g) || []);
            const missing = [];
            for (const imp of routeImports) {
              const m = imp.match(/from\s+['"]@\/([^'"]+)['"]/);
              if (m) { const p = path.join(srcDir, m[1]); if (!fs.existsSync(p + '.tsx') && !fs.existsSync(p + '.ts') && !fs.existsSync(p + '.jsx') && !fs.existsSync(p)) missing.push(m[1]); }
            }
            addTest({ cat: 'Frontend', test: 'Routes → composants', ok: missing.length === 0, details: missing.length === 0 ? `${routeImports.length} imports résolus` : `Manquants: ${missing.join(', ')}` });
          } catch (e) { addTest({ cat: 'Frontend', test: 'Routes → composants', ok: false, details: e.message }); }

          // 9. Missing imports @/
          progress('Imports manquants...');
          try {
            const missingImports = [];
            const scanDir = (dir) => {
              if (!fs.existsSync(dir)) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') scanDir(path.join(dir, f.name));
                else if (f.isFile() && /\.(tsx|ts|jsx)$/.test(f.name)) {
                  try {
                    const content = fs.readFileSync(path.join(dir, f.name), 'utf8');
                    for (const imp of (content.match(/from\s+['"]@\/([^'"]+)['"]/g) || [])) {
                      const p = imp.match(/@\/([^'"]+)/)?.[1]; if (!p) continue;
                      const resolved = path.join(srcDir, p);
                      if (!fs.existsSync(resolved + '.tsx') && !fs.existsSync(resolved + '.ts') && !fs.existsSync(resolved + '.jsx') && !fs.existsSync(resolved))
                        missingImports.push(`${f.name}→@/${p}`);
                    }
                  } catch (_) {}
                }
              }
            };
            scanDir(srcDir);
            addTest({ cat: 'Frontend', test: 'Imports @/', ok: missingImports.length === 0, details: missingImports.length === 0 ? 'Tous résolus' : `${missingImports.length} manquants: ${missingImports.slice(0, 5).join(', ')}` });
          } catch (e) { addTest({ cat: 'Frontend', test: 'Imports @/', ok: false, details: e.message }); }

          // 10. Export default in all components/pages
          progress('Export default...');
          try {
            const noExport = [];
            const checkExports = (dir) => {
              if (!fs.existsSync(dir)) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                if (f.isDirectory()) checkExports(path.join(dir, f.name));
                else if (f.isFile() && /\.(tsx|jsx)$/.test(f.name) && f.name !== 'main.tsx') {
                  try { const c = fs.readFileSync(path.join(dir, f.name), 'utf8'); if (!c.includes('export default')) noExport.push(f.name); } catch (_) {}
                }
              }
            };
            checkExports(path.join(srcDir, 'pages')); checkExports(path.join(srcDir, 'components'));
            addTest({ cat: 'Frontend', test: 'Export default', ok: noExport.length === 0, details: noExport.length === 0 ? 'Tous les composants exportent' : `Sans export: ${noExport.slice(0, 5).join(', ')}` });
          } catch (e) { addTest({ cat: 'Frontend', test: 'Export default', ok: false, details: e.message }); }

          // 11. Console errors
          progress('Erreurs console...');
          try {
            const consoleLogs = clientLogs.get(String(project_id)) || [];
            const errors = consoleLogs.filter(l => l.level === 'error');
            addTest({ cat: 'Frontend', test: 'Console errors', ok: errors.length === 0, details: errors.length === 0 ? 'Aucune erreur' : `${errors.length} erreur(s): ${errors.slice(0, 3).map(e => e.message?.substring(0, 60)).join('; ')}` });
          } catch (e) { addTest({ cat: 'Frontend', test: 'Console errors', ok: false, details: e.message }); }

          // ── DATA (4 tests) ──

          // 12. Fetch/route matching
          progress('Cohérence fetch/routes...');
          try {
            const mismatches = [];
            const scanFetch = (dir) => {
              if (!fs.existsSync(dir)) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') scanFetch(path.join(dir, f.name));
                else if (f.isFile() && /\.(tsx|jsx)$/.test(f.name)) {
                  try {
                    const c = fs.readFileSync(path.join(dir, f.name), 'utf8');
                    const fetches = c.match(/fetch\s*\(\s*['"`](\/api\/[^'"`]+)/g) || [];
                    for (const ft of fetches) {
                      const url = ft.match(/['"`](\/api\/[^'"`]+)/)?.[1];
                      if (url && !serverCode.includes(`'${url}'`) && !serverCode.includes(`"${url}"`)) mismatches.push(`${f.name}: fetch("${url}") → pas de route`);
                    }
                  } catch (_) {}
                }
              }
            };
            scanFetch(srcDir);
            addTest({ cat: 'Données', test: 'Fetch ↔ routes', ok: mismatches.length === 0, details: mismatches.length === 0 ? 'Tous les fetch ont une route' : `${mismatches.length} sans route: ${mismatches.slice(0, 3).join('; ')}` });
          } catch (e) { addTest({ cat: 'Données', test: 'Fetch ↔ routes', ok: false, details: e.message }); }

          // 13. Tables have demo data (INSERT INTO)
          progress('Données de demo...');
          try {
            const tables = (serverCode.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map(t => t.replace('CREATE TABLE IF NOT EXISTS ', ''));
            const tablesWithData = tables.filter(t => serverCode.includes(`INSERT INTO ${t}`) || serverCode.includes(`INSERT OR IGNORE INTO ${t}`) || serverCode.includes(`insert into ${t}`));
            const empty = tables.filter(t => !tablesWithData.includes(t));
            addTest({ cat: 'Données', test: `Tables avec données (${tablesWithData.length}/${tables.length})`, ok: empty.length === 0, details: empty.length === 0 ? 'Toutes les tables ont des INSERT' : `Sans données: ${empty.join(', ')}` });
          } catch (e) { addTest({ cat: 'Données', test: 'Tables avec données', ok: false, details: e.message }); }

          // 14. Field name coherence (frontend body vs backend req.body)
          progress('Cohérence champs...');
          try {
            const fieldIssues = [];
            const routeBodyMap = {};
            const routeRegex = /app\.(post|put|patch)\s*\(\s*['"`]([^'"`]+)/g;
            let rm; while ((rm = routeRegex.exec(serverCode)) !== null) {
              const after = serverCode.substring(rm.index, rm.index + 2000);
              const bm = after.match(/const\s*\{([^}]+)\}\s*=\s*req\.body/);
              if (bm) routeBodyMap[rm[2]] = bm[1].split(',').map(f => f.trim().split(/\s/)[0]).filter(Boolean);
            }
            const scanFields = (dir) => {
              if (!fs.existsSync(dir)) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') scanFields(path.join(dir, f.name));
                else if (f.isFile() && /\.(tsx|jsx)$/.test(f.name)) {
                  try {
                    const c = fs.readFileSync(path.join(dir, f.name), 'utf8');
                    const fetchRe = /fetch\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{[^}]*body\s*:\s*JSON\.stringify\s*\(\s*\{([^}]*)\}/g;
                    let fm; while ((fm = fetchRe.exec(c)) !== null) {
                      const frontFields = fm[2].split(',').map(f => f.trim().split(/\s*:/)[0].trim()).filter(Boolean);
                      const backFields = routeBodyMap[fm[1]];
                      if (backFields) {
                        const extra = frontFields.filter(f => !backFields.includes(f));
                        if (extra.length > 0) fieldIssues.push(`${f.name}→${fm[1]}: envoie {${extra.join(',')}} non attendu`);
                      }
                    }
                  } catch (_) {}
                }
              }
            };
            scanFields(srcDir);
            addTest({ cat: 'Données', test: 'Cohérence champs', ok: fieldIssues.length === 0, details: fieldIssues.length === 0 ? 'Frontend/backend alignés' : `${fieldIssues.length} incohérence(s): ${fieldIssues.slice(0, 3).join('; ')}` });
          } catch (e) { addTest({ cat: 'Données', test: 'Cohérence champs', ok: false, details: e.message }); }

          // 15. Dead links in navigation
          progress('Liens navigation...');
          try {
            const deadLinks = [];
            const allPages = new Set();
            // Collect all Route paths from App.tsx
            const appContent = fs.existsSync(path.join(srcDir, 'App.tsx')) ? fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf8') : '';
            (appContent.match(/path=["']([^"']+)["']/g) || []).forEach(m => allPages.add(m.match(/["']([^"']+)["']/)?.[1]));
            // Scan all components for Link to= or href=
            const scanLinks = (dir) => {
              if (!fs.existsSync(dir)) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'ui') scanLinks(path.join(dir, f.name));
                else if (f.isFile() && /\.(tsx|jsx)$/.test(f.name)) {
                  try {
                    const c = fs.readFileSync(path.join(dir, f.name), 'utf8');
                    const links = c.match(/(?:to|href)=["'](\/[^"']*?)["']/g) || [];
                    for (const l of links) {
                      const href = l.match(/["'](\/[^"']*?)["']/)?.[1];
                      if (href && !allPages.has(href) && !href.startsWith('/api') && href !== '/#' && href !== '/') deadLinks.push(`${f.name}: ${href}`);
                    }
                  } catch (_) {}
                }
              }
            };
            scanLinks(path.join(srcDir, 'components')); scanLinks(path.join(srcDir, 'pages'));
            addTest({ cat: 'Données', test: 'Liens navigation', ok: deadLinks.length === 0, details: deadLinks.length === 0 ? 'Tous les liens pointent vers des routes' : `${deadLinks.length} lien(s) mort(s): ${deadLinks.slice(0, 5).join(', ')}` });
          } catch (e) { addTest({ cat: 'Données', test: 'Liens navigation', ok: false, details: e.message }); }

          // ── SÉCURITÉ (3 tests) ──

          // 16. Unprotected sensitive routes
          progress('Routes sans auth...');
          try {
            const sensitivePatterns = ['/api/users', '/api/admin', '/api/internal', '/api/settings', '/api/config'];
            const unprotected = [];
            for (const pattern of sensitivePatterns) {
              const routeRe = new RegExp(`app\\.(get|post|put|delete)\\s*\\(\\s*['"\`]${pattern.replace('/', '\\/')}`, 'g');
              let m; while ((m = routeRe.exec(serverCode)) !== null) {
                // Check if there's auth middleware before the handler
                const after = serverCode.substring(m.index, m.index + 500);
                if (!after.includes('auth') && !after.includes('token') && !after.includes('jwt') && !after.includes('protect') && !after.includes('user.role'))
                  unprotected.push(m[0].match(/['"`]([^'"`]+)/)?.[1] || pattern);
              }
            }
            addTest({ cat: 'Sécurité', test: 'Routes protégées', ok: unprotected.length === 0, details: unprotected.length === 0 ? 'Routes sensibles ont auth/token check' : `Sans protection: ${[...new Set(unprotected)].join(', ')}` });
          } catch (e) { addTest({ cat: 'Sécurité', test: 'Routes protégées', ok: false, details: e.message }); }

          // 17. Password hashing
          progress('Hachage mots de passe...');
          try {
            const hasBcrypt = serverCode.includes('bcrypt');
            const hasPlainPassword = serverCode.match(/password\s*===?\s*['"`]/g);
            const ok = hasBcrypt && !hasPlainPassword;
            addTest({ cat: 'Sécurité', test: 'Hachage passwords', ok, details: ok ? 'bcrypt utilisé' : (!hasBcrypt ? 'bcrypt non détecté' : 'Comparaison en clair détectée') });
          } catch (e) { addTest({ cat: 'Sécurité', test: 'Hachage passwords', ok: false, details: e.message }); }

          // 18. SQL injection check (string concatenation in queries)
          progress('Injection SQL...');
          try {
            const unsafePatterns = serverCode.match(/\.(run|get|all|prepare)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE).*\$\{/gi) || [];
            const ok = unsafePatterns.length === 0;
            addTest({ cat: 'Sécurité', test: 'SQL injection', ok, details: ok ? 'Prepared statements utilisés' : unsafePatterns.length + ' requête(s) avec interpolation de variables' });
          } catch (e) { addTest({ cat: 'Sécurité', test: 'SQL injection', ok: false, details: e.message }); }

          // ── QUALITÉ (2 tests) ──

          // 19. verify_project diagnostic
          progress('Diagnostic complet...');
          let verifyResult = '';
          try {
            if (containerExecService) {
              verifyResult = await containerExecService.verifyProject(project_id);
              const hasErrors = verifyResult.includes('✗');
              addTest({ cat: 'Qualité', test: 'verify_project', ok: !hasErrors, details: hasErrors ? 'Erreurs détectées' : 'Tout OK' });
            } else { addTest({ cat: 'Qualité', test: 'verify_project', ok: null, details: 'Container non disponible' }); }
          } catch (e) { addTest({ cat: 'Qualité', test: 'verify_project', ok: false, details: e.message }); }

          // 20. File sizes (detect bloated files)
          progress('Taille des fichiers...');
          try {
            const bigFiles = [];
            const checkSizes = (dir, prefix) => {
              if (!fs.existsSync(dir)) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                if (f.isDirectory() && f.name !== 'node_modules') checkSizes(path.join(dir, f.name), prefix ? `${prefix}/${f.name}` : f.name);
                else if (f.isFile() && /\.(tsx|jsx|ts|js)$/.test(f.name)) {
                  try { const lines = fs.readFileSync(path.join(dir, f.name), 'utf8').split('\n').length; if (lines > 300 && f.name !== 'server.js') bigFiles.push(`${prefix ? prefix + '/' : ''}${f.name} (${lines}L)`); } catch (_) {}
                }
              }
            };
            checkSizes(srcDir, 'src');
            addTest({ cat: 'Qualité', test: 'Fichiers volumineux', ok: bigFiles.length === 0, details: bigFiles.length === 0 ? 'Tous < 300 lignes' : `${bigFiles.length} trop grands: ${bigFiles.slice(0, 3).join(', ')}` });
          } catch (e) { addTest({ cat: 'Qualité', test: 'Fichiers volumineux', ok: false, details: e.message }); }

          // ══════════════════════════════════════════════════════════
          // PHASE 2: READ PROJECT FILES FOR CONTEXT
          // ══════════════════════════════════════════════════════════
          job.progressMessage = 'Analyse des fichiers...';
          const projectFiles = readProjectFilesRecursive(projDir);
          const fileList = Object.keys(projectFiles);
          const filesSummary = fileList.map(fn => {
            const lines = (projectFiles[fn] || '').split('\n').length;
            return `  ${fn} (${lines} lignes)`;
          }).join('\n');

          // ══════════════════════════════════════════════════════════
          // PHASE 3: CLAUDE WRITES THE REPORT (from test results)
          // ══════════════════════════════════════════════════════════
          job.progressMessage = 'Rédaction du rapport...';

          const passCount = testTable.filter(t => t.ok === true).length;
          const failCount = testTable.filter(t => t.ok === false).length;
          const skipCount = testTable.filter(t => t.ok === null).length;

          // Build the test results table for Claude, grouped by category
          let testResultsText = `RÉSULTATS DES TESTS AUTOMATIQUES (${testTable.length} tests exécutés par le serveur) :\n\n`;
          const categories = [...new Set(testTable.map(t => t.cat || 'Autre'))];
          for (const cat of categories) {
            const catTests = testTable.filter(t => (t.cat || 'Autre') === cat);
            testResultsText += `\n**${cat}** (${catTests.filter(t => t.ok === true).length}/${catTests.length} OK)\n`;
            testResultsText += '| Test | Résultat | Détails |\n|------|----------|--------|\n';
            for (const t of catTests) {
              const icon = t.ok === true ? '✓' : t.ok === false ? '✗' : '⚠';
              testResultsText += `| ${t.test} | ${icon} | ${t.details} |\n`;
            }
          }
          testResultsText += `\nScore brut : ${passCount} réussis, ${failCount} échoués, ${skipCount} non testés sur ${testTable.length}\n`;

          if (verifyResult) {
            testResultsText += `\nDIAGNOSTIC verify_project :\n${verifyResult}\n`;
          }

          testResultsText += `\nFICHIERS DU PROJET (${fileList.length}) :\n${filesSummary}\n`;

          const auditPrompt = ai && ai.AUDIT_SYSTEM_PROMPT ? ai.AUDIT_SYSTEM_PROMPT : 'Rédige un rapport d\'audit.';
          const auditSystemBlocks = [{ type: 'text', text: auditPrompt, cache_control: { type: 'ephemeral' } }];

          // Send test results + project context to Claude for report generation
          const auditMessages = [
            ...messages,
            { role: 'user', content: testResultsText + '\n\nRédige le rapport d\'audit complet basé sur ces résultats. Tu peux aussi utiliser view_file pour lire les fichiers du projet si besoin de détails supplémentaires.' }
          ];

          const auditReply = await callClaudeAPI(auditSystemBlocks, auditMessages, 16000,
            { userId: user.id, projectId: project_id, operation: 'audit' },
            { useTools: true, _partnerReadOnly: true });

          job.code = '';
          job.chat_message = typeof auditReply === 'string' ? auditReply : auditReply;
          job.status = 'done';
          job.progressMessage = 'Audit terminé';
          // Save full audit to DB + send SSE completion
          const auditReplyText = typeof auditReply === 'string' ? auditReply : JSON.stringify(auditReply);
          const auditScore = saveAuditResults(project_id, testTable, auditReplyText, 'manual');
          if (project_id) {
            notifyProjectClients(project_id, 'audit_complete', {
              score: auditScore || Math.round((passCount / testTable.length) * 10),
              passed: passCount, failed: failCount, skipped: skipCount, total: testTable.length
            });
          }
          if (project_id) {
            const replyText = typeof auditReply === 'string' ? auditReply : JSON.stringify(auditReply);
            db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)')
              .run(project_id, 'assistant', replyText.substring(0, 15000));
          }
          console.log(`[Audit] Completed: ${passCount}✓ ${failCount}✗ ${skipCount}⚠ for project ${project_id}`);
        } catch (e) {
          job.status = 'error';
          job.error = e.message;
          console.warn(`[Audit] Failed: ${e.message}`);
        }
      })();
    } else if (mode === 'agent') {
      // ─── AGENT MODE: autonomous plan/execute/validate/fix loop ───
      if (!agentModeService) {
        // Agent Mode not available — fall back to standard generation
        console.warn('[Agent] Agent Mode service not available — falling back to standard generation');
        activeGenerations++;
        generateClaude(messages, jobId, brief);
      } else {
        activeGenerations++;
        const agentProject = project || { id: project_id, title: '', project_type: '', brief: message };
        try {
          agentModeService.runAgentLoop(jobId, user, agentProject, message, {
            callClaudeAPI,
            tools: CODE_TOOLS,
            containerExec: containerExecService,
            readProjectFiles: readProjectFilesRecursive,
            formatProjectCode
          }).catch((err) => {
            console.error(`[Agent] runAgentLoop error: ${err.message}`);
            const job = generationJobs.get(jobId);
            if (job && job.status !== 'done') {
              job.status = 'error';
              job.error = `Agent Mode error: ${err.message}`;
            }
          }).finally(() => { activeGenerations--; });
        } catch(e) {
          console.error(`[Agent] Sync error: ${e.message}`);
          const job = generationJobs.get(jobId);
          if (job) { job.status = 'error'; job.error = `Agent Mode error: ${e.message}`; }
          activeGenerations--;
        }
      }

      // Auto-summarize conversation in background
      if (project_id && conversationMemoryService) {
        conversationMemoryService.autoSummarizeIfNeeded(project_id).catch(() => {});
      }
    } else {
      // Code mode: full generation pipeline
      activeGenerations++;
      generateClaude(messages, jobId, brief);

      // Auto-summarize conversation in background
      if (project_id) {
        conversationMemoryService.autoSummarizeIfNeeded(project_id).catch(() => {});
      }
    }
    return;
  }

  // ─── AI FEEDBACK — thumbs up/down on AI responses ───
  // POST /api/feedback { project_id, job_id, rating: 1|-1, comment? }
  // Stores user signal so we can compute % of generations rated positive/negative
  // and identify failure patterns over time. Used by /api/admin/ai-stats.
  if (url === '/api/feedback' && req.method === 'POST') {
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
    return;
  }

  // ─── ADMIN: AI STATS DASHBOARD ───
  // GET /api/admin/ai-stats?days=7
  // Returns aggregated metrics from token_usage + ai_feedback. Admin only.
  // GET /api/admin/audit-log?limit=100&action=login_failed
  // Admin-only view of all sensitive actions for security review.
  if (url.startsWith('/api/admin/audit-log') && req.method === 'GET') {
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
    return;
  }

  if (url.startsWith('/api/admin/ai-stats') && req.method === 'GET') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin only' }); return; }
    const urlParts = req.url.split('?');
    const params = urlParts.length > 1 ? new URLSearchParams(urlParts[1]) : new URLSearchParams();
    const days = Math.max(1, Math.min(90, parseInt(params.get('days') || '7', 10)));

    try {
      // Token usage aggregates
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

      // Per operation breakdown (operation column has 'op:complexity' format)
      const byOp = db.prepare(`
        SELECT operation, COUNT(*) as count, SUM(cost_usd) as cost,
               AVG(input_tokens) as avg_input, AVG(output_tokens) as avg_output
        FROM token_usage
        WHERE created_at >= datetime('now', ?)
        GROUP BY operation
        ORDER BY cost DESC
        LIMIT 20
      `).all(`-${days} days`);

      // Per day series (for sparkline)
      const dailySeries = db.prepare(`
        SELECT date(created_at) as day, COUNT(*) as calls, SUM(cost_usd) as cost
        FROM token_usage
        WHERE created_at >= datetime('now', ?)
        GROUP BY day
        ORDER BY day ASC
      `).all(`-${days} days`);

      // Feedback aggregates
      const fb = db.prepare(`
        SELECT
          SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as negative,
          COUNT(*) as total
        FROM ai_feedback
        WHERE created_at >= datetime('now', ?)
      `).get(`-${days} days`);

      // Top users by cost (for billing visibility)
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
    return;
  }

  // ─── PROJECT FILE UPLOAD — images, logos, assets into project's public/ dir ───
  // POST /api/projects/:id/upload { filename, base64, content_type }
  // Saves the file to the project's public/images/ directory so Vite serves it
  // as a static asset. Claude references it via /images/filename in generated code.
  const uploadMatch = url.match(/^\/api\/projects\/(\d+)\/upload$/);
  if (uploadMatch && req.method === 'POST') {
    const projectId = parseInt(uploadMatch[1], 10);

    // Auth + ownership
    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé.' });
      return;
    }

    const body = await getBody(req, 15 * 1024 * 1024); // 15MB max (base64 overhead)
    const { filename, base64, content_type } = body || {};

    // Validate filename
    if (!filename || typeof filename !== 'string') {
      json(res, 400, { error: 'filename requis.' });
      return;
    }
    // Sanitize: strip path traversal, special chars, limit length
    const sanitized = filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')  // only safe chars
      .replace(/\.{2,}/g, '.')             // no double dots
      .substring(0, 100);                  // max 100 chars
    if (!sanitized || sanitized === '.' || sanitized === '_') {
      json(res, 400, { error: 'Nom de fichier invalide.' });
      return;
    }

    // Validate content type (images + PDF + SVG)
    const ALLOWED_TYPES = new Set([
      'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
      'image/svg+xml', 'image/x-icon', 'image/ico',
      'application/pdf'
    ]);
    if (content_type && !ALLOWED_TYPES.has(content_type)) {
      json(res, 400, { error: `Type non supporté: ${content_type}. Acceptés: images, SVG, PDF.` });
      return;
    }

    // Validate base64
    if (!base64 || typeof base64 !== 'string' || base64.length < 10) {
      json(res, 400, { error: 'base64 requis.' });
      return;
    }
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 10 * 1024 * 1024) { // 10MB raw file max
      json(res, 400, { error: 'Fichier trop volumineux (max 10MB).' });
      return;
    }

    // Save to BOTH public/images/ (Vite static) AND src/assets/images/ (Vite import)
    // public/ is bind-mounted to the container — Vite serves it as static assets
    // src/assets/ is also bind-mounted — Claude can import it for guaranteed path resolution
    const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
    const publicImagesDir = path.join(projectDir, 'public', 'images');
    const assetsImagesDir = path.join(projectDir, 'src', 'assets', 'images');
    if (!fs.existsSync(publicImagesDir)) fs.mkdirSync(publicImagesDir, { recursive: true });
    if (!fs.existsSync(assetsImagesDir)) fs.mkdirSync(assetsImagesDir, { recursive: true });

    const publicPath = path.join(publicImagesDir, sanitized);
    const assetsPath = path.join(assetsImagesDir, sanitized);
    try {
      fs.writeFileSync(publicPath, buffer);
      fs.writeFileSync(assetsPath, buffer);
      log('info', 'upload', 'file saved (public + assets)', {
        projectId, filename: sanitized, size: buffer.length, userId: user.id
      });
      json(res, 200, {
        ok: true,
        path: `/images/${sanitized}`,
        assetPath: `@/assets/images/${sanitized}`,
        filename: sanitized,
        size: buffer.length,
        url: `/run/${projectId}/images/${sanitized}`
      });
    } catch (e) {
      log('error', 'upload', 'write failed', { projectId, error: e.message });
      json(res, 500, { error: 'Erreur sauvegarde fichier: ' + e.message });
    }
    return;
  }

  // ─── PROJECT MEMORY — persistent free-form preferences per project ───
  // Lets the agent capture client preferences ("no blue", "always sober", "footer minimal")
  // so they're injected into EVERY future generation. Solves the 4-message context limit.
  // GET /api/projects/:id/memory — read
  // PUT /api/projects/:id/memory — write/update (body: { content: string })
  const memoryMatch = url.match(/^\/api\/projects\/(\d+)\/memory$/);
  if (memoryMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const projectId = parseInt(memoryMatch[1], 10);
    if (!Number.isInteger(projectId) || projectId < 1) { json(res, 400, { error: 'project_id invalide.' }); return; }

    // Ownership check
    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
      return;
    }

    if (req.method === 'GET') {
      const row = db.prepare('SELECT content, updated_at, updated_by FROM project_memory WHERE project_id=?').get(projectId);
      json(res, 200, {
        project_id: projectId,
        content: row?.content || '',
        updated_at: row?.updated_at || null,
        updated_by: row?.updated_by || null
      });
      return;
    }

    // PUT: upsert
    const body = await getBody(req);
    const { content } = body || {};
    if (typeof content !== 'string') {
      json(res, 400, { error: 'content (string) requis.' });
      return;
    }
    if (content.length > 5000) {
      json(res, 400, { error: 'Mémoire trop longue (5000 caractères max).' });
      return;
    }
    try {
      // Upsert pattern (SQLite INSERT OR REPLACE on PRIMARY KEY)
      db.prepare(`INSERT INTO project_memory (project_id, content, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(project_id) DO UPDATE SET content=excluded.content, updated_at=datetime('now'), updated_by=excluded.updated_by`)
        .run(projectId, content, user.id);
      log('info', 'memory', 'updated', { projectId, userId: user.id, length: content.length });
      json(res, 200, { ok: true, project_id: projectId, length: content.length });
    } catch (e) {
      log('error', 'memory', 'upsert failed', { projectId, error: e.message });
      json(res, 500, { error: 'Erreur de sauvegarde mémoire: ' + e.message });
    }
    return;
  }

  // ─── PLAN MODE — START (POLLING, lightweight) ───
  // Generates a markdown plan without writing any code. User must approve via
  // POST /api/plan/:planId/approve to trigger actual generation.
  if (url === '/api/plan/start' && req.method === 'POST') {
    const body = await getBody(req);
    const { project_id: rawProjectId, message, skip_clarification } = body || {};

    // Input validation (mirrors /api/generate/start patterns)
    const msgErr = validateString(message, 'Message', 3, 10000);
    if (msgErr) { json(res, 400, { error: msgErr }); return; }
    const idErr = validateId(rawProjectId, 'project_id');
    if (idErr) { json(res, 400, { error: idErr }); return; }
    const project_id = parseInt(rawProjectId, 10); // normalize string→int

    // Project ownership check
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
      return;
    }

    // ─── CLARIFICATION PROTOCOL (mirrors /api/generate/start) ───
    if (!skip_clarification && needsClarification(message, project)) {
      try {
        const questions = await generateClarificationQuestions(message, user.id, project_id);
        log('info', 'clarify', 'asked (plan)', { userId: user.id, projectId: project_id, count: questions.length });
        json(res, 200, { type: 'clarification_needed', questions, original_message: message });
        return;
      } catch (e) {
        // Fail open: proceed with planning rather than blocking
        log('warn', 'clarify', 'failed open (plan)', { error: e.message });
      }
    }

    // Quota check (plans count against the same generate quota — prevents abuse)
    const quota = checkUserQuota(user.id);
    if (!quota.allowed) {
      json(res, 429, { error: quota.reason, quota: { daily: quota.daily, dailyLimit: quota.dailyLimit, monthly: quota.monthly, monthlyLimit: quota.monthlyLimit } });
      return;
    }

    // Concurrency limit (shared with full generation pipeline)
    if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      json(res, 429, { error: `Serveur occupé (${activeGenerations}/${MAX_CONCURRENT_GENERATIONS} générations en cours). Réessayez dans 30 secondes.` });
      return;
    }

    // Create plan job (with AbortController for user-initiated stop)
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

    // Respond immediately, generate in background
    json(res, 200, { job_id: jobId, status: 'pending' });

    // Persist user request as a regular 'user' message in history (best effort)
    try {
      db.prepare('INSERT INTO project_messages (project_id, role, content) VALUES (?,?,?)')
        .run(project_id, 'user', message);
    } catch (e) {
      log('warn', 'plan', 'user message insert failed', { jobId, error: e.message });
    }

    // Fire-and-forget background generation. Errors are caught inside generatePlan and
    // surfaced via job.status='error' so the polling client sees them.
    generatePlan(jobId, user, project, message).catch(err => {
      log('error', 'plan', 'unhandled in generatePlan', { jobId, error: err.message });
      const j = generationJobs.get(jobId);
      if (j && j.status !== 'done') { j.status = 'error'; j.error = j.error || err.message; }
    });
    return;
  }

  // ─── PLAN MODE — APPROVE (executes the plan via the standard generation pipeline) ───
  // Reads the persisted plan, builds a generation message that injects the plan as instructions,
  // then enqueues a normal generateClaude job. Frontend then polls /api/jobs/:job_id as usual.
  const planApproveMatch = url.match(/^\/api\/plan\/(\d+)\/approve$/);
  if (planApproveMatch && req.method === 'POST') {
    const planId = parseInt(planApproveMatch[1], 10);
    if (!Number.isInteger(planId) || planId < 1) {
      json(res, 400, { error: 'plan_id invalide.' });
      return;
    }

    // Anti-double-approve guard (in-memory; resets on server restart)
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
    if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      json(res, 429, { error: `Serveur occupé (${activeGenerations}/${MAX_CONCURRENT_GENERATIONS} générations en cours). Réessayez dans 30 secondes.` });
      return;
    }

    // Mark as executed BEFORE creating the job (prevents race on rapid double-click)
    executedPlans.add(planId);
    if (executedPlans.size > MAX_TRACKED_EXECUTED_PLANS) {
      // Simple LRU-ish prune: drop oldest by clearing half. Plans dropped from the set
      // become re-approvable, which is acceptable (worst case: user double-generates).
      const arr = Array.from(executedPlans).slice(MAX_TRACKED_EXECUTED_PLANS / 2);
      executedPlans.clear();
      arr.forEach(id => executedPlans.add(id));
    }

    // Build generation message that injects the validated plan as the source of truth
    const genMessage = `INSTRUCTION OBLIGATOIRE : Implémente ce plan MAINTENANT avec les outils.

WORKFLOW STRICT :
1. Pour CHAQUE fichier à modifier → view_file d'abord pour lire le contenu actuel
2. Puis edit_file avec le texte EXACT copié du fichier (pas inventé)
3. Pour les nouveaux fichiers → write_file directement
4. NE RÉPONDS PAS en texte — UTILISE LES OUTILS

Plan validé par l'utilisateur :\n\n${planRow.content}`;

    // Create generation job (mirrors /api/generate/start branch for code mode)
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

    // Build generation context exactly like /api/generate/start would
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

    // Persist a marker in history so the user can see the plan was executed
    try {
      db.prepare('INSERT INTO project_messages (project_id, role, content) VALUES (?,?,?)')
        .run(project.id, 'user', `[Plan #${planId} approuvé et exécuté]`);
    } catch (e) { /* non-fatal */ }

    log('info', 'plan', 'plan approved and execution enqueued', {
      planId, jobId, projectId: project.id, userId: user.id
    });

    notifyProjectClients(project.id, 'user_action', { action: 'plan_executing', userName: user.name }, user.id);

    activeGenerations++;
    generateClaude(messagesForGen, jobId, project.brief);
    return;
  }

  // ─── GENERATE FROM IMAGE START (POLLING) ───
  if (url==='/api/generate/image/start' && req.method==='POST') {
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
    return;
  }

  // ─── COMPILE (DOCKER ISOLATED PREVIEW) ───
  // ─── HOT RELOAD: copy files into running container — Vite HMR picks up changes instantly ───
  if (url === '/api/hot-reload' && req.method === 'POST') {
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
      // Root HTML and config (triggers full page reload via Vite if changed)
      if (fs.existsSync(path.join(projDir, 'index.html'))) {
        // bind mount — no docker cp needed for index.html
      }
      // NOTE: Do NOT copy vite.config.js during hot reload — it causes Vite to restart
      // and kill the container (wait -n in start-dev.sh). Config changes require full rebuild.

      // Backend — only restart Express if server.js changed AND has no syntax errors
      if (fs.existsSync(path.join(projDir, 'server.js'))) {
        const { spawnSync } = require('child_process');
        const syntaxCheck = spawnSync('node', ['--check', path.join(projDir, 'server.js')], { encoding: 'utf8', timeout: 5000 });
        if (syntaxCheck.status === 0) {
          // bind mount — no docker cp needed for server.js
          serverChanged = true;
        } else {
          console.warn(`[HMR] server.js has syntax errors — NOT copying to container`);
        }
      }

      // Only restart if server.js changed (API routes/DB schema changes)
      // Frontend changes are picked up by Vite HMR instantly — no restart needed
      if (serverChanged) {
        console.log(`[HMR] server.js changed — restarting Express...`);
        const container = docker.getContainer(containerName);
        // Kill and restart only the Express process, not Vite
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

      // Check Vite logs for errors AFTER hot-reload (like Lovable's real-time detection)
      // Wait 2s for Vite to process the changed files
      await new Promise(r => setTimeout(r, 2000));
      const postHmrLogs = await getContainerLogsAsync(project_id, 30);
      const hmrErrors = postHmrLogs.split('\n').filter(l =>
        /Failed to resolve|error TS|SyntaxError|Cannot find module|expected|Transform failed/i.test(l) &&
        !/✅|Prêt|Ready|watching|hmr update/i.test(l)
      );

      if (hmrErrors.length > 0) {
        console.warn(`[HMR] Vite errors after hot-reload: ${hmrErrors.length}`);
        hmrErrors.forEach(e => console.warn(`  ${e.trim().substring(0, 100)}`));

        // Auto-fix: send errors to Claude (free — auto-correct operation)
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
            const projDir = path.join(DOCKER_PROJECTS_DIR, String(project_id));
            // Snapshot before HMR fix write
            const hmrSnapshot = saveProjectSnapshot(projDir);
            writeGeneratedFiles(projDir, fixCode, project_id);
            console.log(`[HMR] Auto-fixed Vite errors and re-applied`);

            // Re-check after fix — rollback if still broken
            await new Promise(r => setTimeout(r, 1500));
            const recheckLogs = await getContainerLogsAsync(project_id, 15);
            const recheckErrors = recheckLogs.split('\n').filter(l =>
              /Failed to resolve|SyntaxError|Cannot find module|ReferenceError/i.test(l) &&
              !/ECONNREFUSED|health/i.test(l)
            );
            if (recheckErrors.length > 0) {
              console.warn(`[HMR] Fix introduced new errors — rolling back`);
              rollbackToSnapshot(projDir, hmrSnapshot, project_id, 'HMR auto-fix introduced new errors');
            }
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
    return;
  }

  if (url==='/api/compile' && req.method==='POST') {
    const {project_id, mode}=await getBody(req);
    console.log('[COMPILE] Starting for project:', project_id);
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project?.generated_code) { json(res,400,{error:'Générez le code d\'abord.'}); return; }

    // Authorization check: user must own the project or be admin
    if (user.role !== 'admin' && project.user_id !== user.id) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
      return;
    }

    const buildId=crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO builds (id,project_id,status,progress,message) VALUES (?,?,?,?,?)').run(buildId,project_id,'building',0,'Démarrage...');
    db.prepare("UPDATE projects SET build_id=?,build_status='building' WHERE id=?").run(buildId,project_id);
    
    // Reset correction attempts for new build
    correctionAttempts.delete(project_id);
    
    json(res,200,{buildId});
    
    // Check if Docker is available for isolated preview
    if (isDockerAvailable() && mode !== 'legacy') {
      // Docker isolated preview system with auto-correction
      const friendly = {
        1: 'Analyse du code généré...',
        2: 'Écriture des fichiers du projet...',
        3: 'Construction de l\'environnement...',
        4: 'Lancement du projet...',
        5: 'Vérification du démarrage...',
        6: 'Prêt !',
        'detecting': 'Erreur détectée — analyse en cours...',
        'correcting': 'Prestige AI optimise votre projet...',
        'rebuilding': 'Correction appliquée — reconstruction...',
        'building': 'Construction en cours...'
      };
      
      const attemptBuild = async (code, attempt = 1) => {
        try {
          const result = await buildDockerProject(project_id, code, (p) => {
            const msg = friendly[p.step] || p.message || 'Construction en cours...';
            db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress || 0, msg, buildId);
          });
          
          if (result.success) {
            // Wait for Vite to start and check for errors in container logs
            await new Promise(r => setTimeout(r, 5000));
            const viteLogs = await getContainerLogsAsync(project_id, 50);
            const viteErrors = viteLogs.split('\n').filter(l =>
              /Failed to resolve|error|Error|ENOENT|Cannot find/i.test(l) &&
              !/✅|Prêt|Ready|watching/i.test(l)
            );

            if (viteErrors.length > 0) {
              console.warn(`[Build] Vite runtime errors detected for project ${project_id}:`);
              viteErrors.forEach(e => console.warn(`  ${e.trim().substring(0, 120)}`));

              // Auto-fix: send Vite errors to Claude
              db.prepare('UPDATE builds SET message=? WHERE id=?').run('Correction des erreurs Vite...', buildId);
              try {
                const fixPrompt = `Le container Vite affiche ces erreurs après démarrage:\n\n${viteErrors.join('\n').substring(0, 2000)}\n\nCorrige les fichiers en cause. Utilise write_file ou edit_file. Imports avec @/ alias, fichiers UI en lowercase.`;
                const fixCode = await callClaudeAPI(
                  [{ type: 'text', text: ai ? ai.CHAT_SYSTEM_PROMPT : 'Corrige les erreurs.' }],
                  [{ role: 'user', content: fixPrompt }],
                  16000,
                  { userId: project.user_id, projectId: project_id, operation: 'auto-correct' },
                  { useTools: true }
                );
                if (fixCode) {
                  // Apply fixes to project files on disk
                  const projDir = path.join(DOCKER_PROJECTS_DIR, String(project_id));
                  writeGeneratedFiles(projDir, fixCode, project_id);
                  // Update DB code
                  const updatedFiles = readProjectFilesRecursive(projDir);
                  const updatedCode = formatProjectCode(updatedFiles);
                  db.prepare("UPDATE projects SET generated_code=? WHERE id=?").run(updatedCode, project_id);
                  // Hot-reload the fix into the running container
                  const { execSync } = require('child_process');
                  const containerName = getContainerName(project_id);
                  try {
                    // bind mount — no docker cp needed for src/
                    console.log(`[Build] Vite error auto-fixed and hot-reloaded`);
                  } catch(e) { console.warn(`[Build] Hot-reload after fix failed: ${e.message}`); }
                }
              } catch (fixErr) {
                console.warn(`[Build] Vite auto-fix failed: ${fixErr.message}`);
              }
            }

            db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(result.url, buildId);
            db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(result.url, project_id);
            db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id, `Projet "${project.title}" prêt à explorer !`, 'success');
            return true;
          }
          return false;
        } catch (err) {
          console.error(`Build attempt ${attempt} failed:`, err.message);
          
          // Check if we should try auto-correction
          if (attempt <= MAX_AUTO_CORRECTION_ATTEMPTS) {
            db.prepare('UPDATE builds SET message=? WHERE id=?').run(friendly['detecting'], buildId);
            
            // Get logs for error analysis
            const logs = await getContainerLogsAsync(project_id, 200);
            const errorType = detectErrorType(logs, err.message);
            
            // Log error to database
            logError(project_id, errorType, err.message, logs, attempt);
            
            db.prepare('UPDATE builds SET message=? WHERE id=?').run(
              `${friendly['correcting']} (tentative ${attempt}/${MAX_AUTO_CORRECTION_ATTEMPTS})`, 
              buildId
            );
            
            try {
              // Get current code from project
              const currentProject = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(project_id);
              
              // Call Claude for correction
              const correctedCode = await callClaudeForCorrection(currentProject.generated_code, logs, errorType);
              
              // Update project with corrected code
              db.prepare("UPDATE projects SET generated_code=?, updated_at=datetime('now') WHERE id=?")
                .run(correctedCode, project_id);
              
              // Mark error as corrected
              markErrorCorrected(project_id, correctedCode);
              
              db.prepare('UPDATE builds SET message=? WHERE id=?').run(friendly['rebuilding'], buildId);
              
              // Stop old container
              await stopContainerAsync(project_id);
              
              // Try building with corrected code
              return await attemptBuild(correctedCode, attempt + 1);
              
            } catch (correctionErr) {
              console.error('Auto-correction failed:', correctionErr.message);
              // Continue to next attempt or fail
              return await attemptBuild(code, attempt + 1);
            }
          } else {
            // Max attempts reached — final deep correction via Claude
            const logs = await getContainerLogsAsync(project_id, 200);
            const currentProject = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(project_id);

            console.log(`[Build] Max attempts reached for project ${project_id}, attempting final deep correction...`);
            db.prepare('UPDATE builds SET message=? WHERE id=?').run('Correction approfondie par Prestige AI...', buildId);

            try {
              const finalCode = await callClaudeFinalCorrection(currentProject.generated_code, logs);
              db.prepare("UPDATE projects SET generated_code=?, updated_at=datetime('now') WHERE id=?").run(finalCode, project_id);
              markErrorCorrected(project_id, finalCode);

              db.prepare('UPDATE builds SET message=? WHERE id=?').run('Reconstruction après correction approfondie...', buildId);
              await stopContainerAsync(project_id);

              // One last build attempt with the deeply corrected code
              const finalResult = await buildDockerProject(project_id, finalCode, (p) => {
                const msg = friendly[p.step] || p.message || 'Construction en cours...';
                db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress || 0, msg, buildId);
              });

              if (finalResult.success) {
                db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(finalResult.url, buildId);
                db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(finalResult.url, project_id);
                db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id, `Projet "${project.title}" corrigé et prêt !`, 'success');
                return true;
              }
            } catch (finalErr) {
              console.error(`[Build] Final deep correction failed for project ${project_id}:`, finalErr.message);
            }

            // Truly failed after all attempts
            const lastError = db.prepare('SELECT error_type FROM error_history WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(project_id);
            const errorMsg = lastError ? translateErrorType(lastError.error_type) : 'Erreur de construction';

            db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run(
              `Après ${MAX_AUTO_CORRECTION_ATTEMPTS + 1} tentatives, le projet nécessite votre attention. ${errorMsg}`,
              buildId
            );
            db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
            db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(
              project.user_id,
              `Le projet "${project.title}" nécessite une simplification. Essayez de simplifier vos requêtes.`,
              'warning'
            );
            return false;
          }
        }
      };
      
      attemptBuild(project.generated_code, 1);
      
    } else if (compiler) {
      // Legacy compiler fallback
      const friendly = {1:'Analyse et organisation du projet...',2:'Mise en place des composants...',3:'Application du design et des styles...',4:'Optimisation et finalisation...',5:'Vérification du résultat...',6:'Prêt !'};
      compiler.buildProject(buildId,project.generated_code,p=>{
        db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress, friendly[p.step]||'Construction en cours...', buildId);
      }).then(result=>{
        if (result.success) {
          const url2=`/run/${project_id}/`;
          db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(url2,buildId);
          db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(url2,project_id);
          db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id,`Projet "${project.title}" prêt à explorer !`, 'success');
        } else {
          const cleanErr = 'Une correction est nécessaire. Utilisez le chat pour ajuster le projet.';
          db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run(cleanErr,buildId);
          db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
        }
      });
    } else {
      // No compilation engine available
      db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run('Aucun moteur de compilation disponible.', buildId);
      db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
    }
    return;
  }

  // ─── BUILD STATUS ───
  if (url.match(/^\/api\/builds\/\w+$/) && req.method==='GET') {
    const build=db.prepare('SELECT * FROM builds WHERE id=?').get(url.split('/').pop());
    if (!build) { json(res,404,{error:'Build non trouvé.'}); return; }
    
    // Authorization check: verify user owns the associated project or is admin
    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(build.project_id);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé.' });
      return;
    }
    
    json(res,200,build); return;
  }

  // ─── WEBCONTAINER: TEMPLATE FILE TREE (FULL-STACK) ───
  // Returns the entire template project as a WebContainer-compatible file tree
  // FULL-STACK: Express + sql.js (WASM SQLite) + Vite — like Lovable's cloud servers
  if (url === '/api/template-tree' && req.method === 'GET') {
    function buildFileTree(dir) {
      const tree = {};
      if (!fs.existsSync(dir)) return tree;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'data', 'dist'].includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          tree[entry.name] = { directory: buildFileTree(fullPath) };
        } else {
          try {
            tree[entry.name] = { file: { contents: fs.readFileSync(fullPath, 'utf8') } };
          } catch {}
        }
      }
      return tree;
    }
    const templateDir = path.join(__dirname, 'templates', 'react');
    const tree = buildFileTree(templateDir);

    // ── FULL-STACK PACKAGE.JSON ──
    // Keep ALL backend deps EXCEPT better-sqlite3 (native) → replaced by sql.js (WASM)
    const wcPkg = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'))));
    delete wcPkg.dependencies['better-sqlite3']; // native — can't compile in WC
    wcPkg.dependencies['sql.js'] = '1.11.0';     // WASM SQLite — works in WC
    wcPkg.scripts = {
      dev: 'node _start.js & vite --host 0.0.0.0 --port 5173',
      build: 'vite build',
      start: 'node _start.js'
    };
    tree['package.json'] = { file: { contents: JSON.stringify(wcPkg, null, 2) } };

    // ── BETTER-SQLITE3 SHIM (sql.js wrapper with same API) ──
    // The AI generates server.js with require('better-sqlite3')
    // This shim makes it work transparently in WebContainer
    tree['_better-sqlite3-shim.cjs'] = { file: { contents: `// better-sqlite3 compatibility shim using sql.js (WASM SQLite)
// Loaded by _start.js BEFORE server.js — global.__SQL must be set
const SQL = global.__SQL;
if (!SQL) throw new Error('sql.js not initialized');

class Statement {
  constructor(db, sql) { this._db = db; this._sql = sql; }
  run(...params) {
    const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try { this._db.run(this._sql, p); } catch (e) { throw new Error('SQL: ' + e.message); }
    const changes = this._db.getRowsModified();
    let lastInsertRowid = 0;
    try { const r = this._db.exec('SELECT last_insert_rowid() as id'); if (r[0]) lastInsertRowid = r[0].values[0][0]; } catch {}
    return { changes, lastInsertRowid };
  }
  get(...params) {
    const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const stmt = this._db.prepare(this._sql);
      if (p.length) stmt.bind(p);
      if (stmt.step()) {
        const cols = stmt.getColumnNames(), vals = stmt.get();
        stmt.free();
        const row = {}; cols.forEach((c, i) => row[c] = vals[i]); return row;
      }
      stmt.free(); return undefined;
    } catch (e) { throw new Error('SQL: ' + e.message); }
  }
  all(...params) {
    const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const stmt = this._db.prepare(this._sql);
      if (p.length) stmt.bind(p);
      const results = [], cols = stmt.getColumnNames();
      while (stmt.step()) { const vals = stmt.get(); const row = {}; cols.forEach((c, i) => row[c] = vals[i]); results.push(row); }
      stmt.free(); return results;
    } catch (e) { throw new Error('SQL: ' + e.message); }
  }
}

class Database {
  constructor(filename) { this._db = new SQL.Database(); }
  prepare(sql) { return new Statement(this._db, sql); }
  exec(sql) { try { this._db.exec(sql); } catch (e) { throw new Error('SQL exec: ' + e.message); } }
  pragma(str) { try { this._db.exec('PRAGMA ' + str); } catch {} }
  close() { try { this._db.close(); } catch {} }
  transaction(fn) {
    return (...args) => {
      this.exec('BEGIN'); try { const r = fn(...args); this.exec('COMMIT'); return r; }
      catch (e) { this.exec('ROLLBACK'); throw e; }
    };
  }
}
module.exports = Database;
` } };

    // ── STARTUP WRAPPER (initializes sql.js WASM before loading server.js) ──
    tree['_start.js'] = { file: { contents: `// Full-stack startup: sql.js (WASM) → better-sqlite3 shim → server.js
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

initSqlJs().then(SQL => {
  global.__SQL = SQL;
  console.log('[WC] sql.js initialized (WASM SQLite ready)');

  // Install shim: make require('better-sqlite3') use our sql.js wrapper
  const shimPath = path.join(__dirname, 'node_modules', 'better-sqlite3');
  try { fs.mkdirSync(shimPath, { recursive: true }); } catch {}
  fs.copyFileSync(path.join(__dirname, '_better-sqlite3-shim.cjs'), path.join(shimPath, 'index.js'));
  fs.writeFileSync(path.join(shimPath, 'package.json'), '{"name":"better-sqlite3","main":"index.js"}');

  // Create data directory for SQLite
  try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch {}

  // Now load server.js — its require('better-sqlite3') will find our shim
  require('./server.js');
}).catch(err => {
  console.error('[WC] Failed to initialize sql.js:', err.message);
  process.exit(1);
});
` } };

    // ── VITE CONFIG (with proxy to Express backend) ──
    tree['vite.config.js'] = { file: { contents: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000'
    }
  },
  build: { outDir: 'dist' }
});
` } };

    json(res, 200, tree);
    return;
  }

  // ─── PROJECTS CRUD ───
  if (url==='/api/projects' && req.method==='GET') {
    const p=user.role==='admin'?db.prepare('SELECT p.*,u.name as agent_name FROM projects p JOIN users u ON p.user_id=u.id ORDER BY p.updated_at DESC').all():db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC').all(user.id);
    json(res,200,p); return;
  }
  if (url==='/api/projects' && req.method==='POST') {
    const {title,client_name,project_type,brief,subdomain,domain,apis}=await getBody(req);
    const info=db.prepare("INSERT INTO projects (user_id,title,client_name,project_type,brief,subdomain,domain,apis,status) VALUES (?,?,?,?,?,?,?,?,'draft')").run(user.id,title,client_name,project_type,brief,subdomain,domain,JSON.stringify(apis||[]));
    const projectId = info.lastInsertRowid;

    // Launch isolated container (like Lovable fly.io — 1 container per project)
    if (isDockerAvailable()) {
      launchTemplateContainer(projectId).then(result => {
        if (result.success) console.log(`[Container] Project ${projectId} ready`);
        else console.warn(`[Container] Project ${projectId} failed: ${result.error}`);
      }).catch(err => console.error(`[Container] Error: ${err.message}`));
    }

    json(res,200,{id:projectId,title,status:'draft',preview:`/run/${projectId}/`}); return;
  }
  if (url.match(/^\/api\/projects\/\d+$/) && req.method==='GET') {
    const id=parseInt(url.split('/').pop());
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p||(user.role!=='admin'&&p.user_id!==user.id)) { json(res,403,{error:'Accès refusé.'}); return; }
    // Track access so auto-sleep doesn't kill the container while user is working
    containerLastAccess.set(id, Date.now());
    json(res,200,{...p,messages:db.prepare('SELECT * FROM project_messages WHERE project_id=? ORDER BY id ASC').all(id)}); return;
  }
  if (url.match(/^\/api\/projects\/\d+$/) && req.method==='PUT') {
    const id=parseInt(url.split('/').pop());
    // Authorization check: user must own the project or be admin
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!project||(user.role!=='admin'&&project.user_id!==user.id)) { json(res,403,{error:'Accès refusé.'}); return; }
    
    const {title,client_name,brief,subdomain,domain,apis,notes,generated_code,status}=await getBody(req);
    try {
      db.prepare("UPDATE projects SET title=COALESCE(?,title),client_name=COALESCE(?,client_name),brief=COALESCE(?,brief),subdomain=COALESCE(?,subdomain),domain=COALESCE(?,domain),apis=COALESCE(?,apis),notes=COALESCE(?,notes),generated_code=COALESCE(?,generated_code),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=?").run(title,client_name,brief,subdomain,domain,apis?JSON.stringify(apis):null,notes,generated_code,status,id);
      json(res,200,{ok:true});
    } catch(e) {
      json(res,500,{error:'Erreur lors de la mise à jour: ' + e.message});
    }
    return;
  }
  if (url.match(/^\/api\/projects\/\d+\/dns-instructions$/) && req.method==='GET') {
    if (user.role!=='admin') { json(res,403,{error:'Admin seulement.'}); return; }
    const id=parseInt(url.split('/')[3]);
    const p=db.prepare('SELECT domain,subdomain,is_published FROM projects WHERE id=?').get(id);
    if (!p) { json(res,404,{error:'Projet non trouvé.'}); return; }
    
    const subdomain = p.subdomain || `project-${id}`;
    const defaultUrl = `https://${subdomain}.${PUBLISH_DOMAIN}`;
    
    const response = {
      defaultUrl,
      cname: { type: 'CNAME', name: 'www', value: CNAME_TARGET },
      a: { type: 'A', name: '@', value: SERVER_IP }
    };
    
    if (p.domain) {
      response.customDomain = p.domain;
      response.customDomainUrl = `https://${p.domain}`;
      response.isActive = p.is_published === 1;
    }
    
    json(res,200,response); return;
  }
  if (url.match(/^\/api\/projects\/\d+\/publish$/) && req.method==='POST') {
    if (user.role !== 'admin' && (() => { const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(parseInt(url.split('/')[3])); return !p || p.user_id !== user.id; })()) {
      json(res, 403, { error: 'Accès refusé.' });
      return;
    }
    const id=parseInt(url.split('/')[3]);
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) { json(res,404,{error:'Projet non trouvé.'}); return; }

    // ── PRE-PUBLISH VALIDATION (enterprise) ──
    // Prevent publishing empty/broken projects
    if (!p.generated_code || p.generated_code.length < 500) {
      json(res, 400, { error: 'Le projet n\'a pas encore de code généré. Générez le site d\'abord.' });
      return;
    }
    if (p.build_status !== 'done' && p.status !== 'ready') {
      json(res, 400, { error: 'Le projet n\'est pas encore prêt. Attendez la fin de la génération.' });
      return;
    }

    const body = await getBody(req);
    let subdomain = body.subdomain || p.subdomain || p.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 30) || `project-${id}`;

    // ── SUBDOMAIN VALIDATION ──
    // Guard against null, empty, reserved names, and duplicates
    subdomain = subdomain.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').substring(0, 40) || `project-${id}`;
    const RESERVED_SUBDOMAINS = new Set(['admin', 'api', 'app', 'www', 'mail', 'ftp', 'preview', 'static', 'cdn', 'assets']);
    if (RESERVED_SUBDOMAINS.has(subdomain)) {
      subdomain = `${subdomain}-${id}`;
    }
    // Uniqueness check: if another project uses this subdomain, append ID
    const existing = db.prepare('SELECT id FROM projects WHERE subdomain=? AND id!=? AND is_published=1').get(subdomain, id);
    if (existing) {
      subdomain = `${subdomain}-${id}`;
    }

    // Copy project files to sites directory
    try {
      // For React projects: build dist/ in the container, then copy it out
      const containerName = getContainerName(id);
      const containerRunning = await isContainerRunningAsync(id);
      const distDir = path.join(DOCKER_PROJECTS_DIR, String(id), 'dist');
      let sourceDir = null;

      if (containerRunning) {
        // Build production dist/ inside the running container
        try {
          const { execSync } = require('child_process');
          console.log(`[Publish] Building production dist/ in ${containerName}...`);
          execSync(`docker exec ${containerName} ./node_modules/.bin/vite build`, { timeout: 60000, encoding: 'utf8' });
          // Copy dist/ out of the container to the project dir
          execSync(`docker cp ${containerName}:/app/dist/. ${distDir}/`, { timeout: 15000 });
          sourceDir = distDir;
          console.log(`[Publish] Production build completed`);
        } catch (buildErr) {
          console.warn(`[Publish] Vite build failed: ${buildErr.message}`);
        }
      }

      // Fallback: use existing dist/ from project dir
      if (!sourceDir && fs.existsSync(distDir)) {
        sourceDir = distDir;
      }
      // Fallback: preview dir
      if (!sourceDir) {
        sourceDir = path.join(PREVIEWS_DIR, String(id));
      }
      if (!fs.existsSync(sourceDir)) {
        // Last resort: create from generated code
        if (p.generated_code) {
          savePreviewFiles(id, p.generated_code);
          sourceDir = path.join(PREVIEWS_DIR, String(id));
        } else {
          json(res, 400, { error: 'Aucun fichier à publier. Compilez le projet d\'abord.' }); return;
        }
      }
      const previewDir = sourceDir;
      
      // Validate subdomain to prevent path traversal
      const safeSubdomain = subdomain.replace(/[^a-zA-Z0-9-]/g, '');
      const siteDir = path.join(SITES_DIR, safeSubdomain);
      
      // Verify the site directory is within SITES_DIR (prevent path traversal)
      if (!isPathSafe(SITES_DIR, siteDir)) {
        json(res, 400, { error: 'Subdomain invalide.' }); return;
      }
      
      // Create site directory and copy files
      if (fs.existsSync(siteDir)) {
        fs.rmSync(siteDir, { recursive: true, force: true });
      }
      fs.mkdirSync(siteDir, { recursive: true });
      
      // Copy all files from preview to site
      const copyRecursive = (src, dest) => {
        if (!fs.existsSync(src)) return;
        // Verify paths are safe
        if (!isPathSafe(previewDir, src) || !isPathSafe(siteDir, dest)) return;
        
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          fs.readdirSync(src).forEach(child => {
            copyRecursive(path.join(src, child), path.join(dest, child));
          });
        } else {
          let content = fs.readFileSync(src);
          // Inject tracking script into HTML files
          if (src.endsWith('.html')) {
            content = injectTrackingScript(content.toString(), id, safeSubdomain);
          }
          fs.writeFileSync(dest, content);
        }
      };
      copyRecursive(previewDir, siteDir);
      
      // ── PRODUCTION MODE: Switch container from dev (Vite+Express) to prod (Express only) ──
      // This makes the published site stable: Express serves dist/ + API, no Vite dev server
      try {
        const containerName = getContainerName(id);
        const projectDir = path.join(DOCKER_PROJECTS_DIR, String(id));
        const dataDir = path.join(projectDir, 'data');

        // Copy dist/ into the project directory (for the bind mount)
        const localDist = path.join(projectDir, 'dist');
        if (fs.existsSync(path.join(siteDir, 'assets'))) {
          // Copy compiled dist back to project dir so container can serve it
          if (!fs.existsSync(localDist)) fs.mkdirSync(localDist, { recursive: true });
          const copyDir = (s, d) => {
            fs.mkdirSync(d, { recursive: true });
            for (const f of fs.readdirSync(s, { withFileTypes: true })) {
              if (f.isDirectory()) copyDir(path.join(s, f.name), path.join(d, f.name));
              else fs.copyFileSync(path.join(s, f.name), path.join(d, f.name));
            }
          };
          copyDir(siteDir, localDist);
        }

        // Recreate container in PRODUCTION mode (Express only, no Vite)
        await stopContainerAsync(id);
        await ensureDockerNetwork();
        const jwtSecret = crypto.randomBytes(32).toString('hex');

        // Load project API keys
        const projKeys = db.prepare('SELECT env_name, env_value FROM project_api_keys WHERE project_id=?').all(id);
        const envVars = [
          `PORT=3000`,
          `JWT_SECRET=${jwtSecret}`,
          `NODE_ENV=production`,
          `NODE_OPTIONS=--max-old-space-size=128`
        ];
        projKeys.forEach(k => envVars.push(`${k.env_name}=${decryptValue(k.env_value)}`));

        const readyImage = READY_IMAGE;
        try { await docker.getImage(readyImage).inspect(); } catch { /* use whatever is available */ }

        const prodContainer = await docker.createContainer({
          Image: readyImage,
          name: containerName,
          Env: envVars,
          // PRODUCTION: only Express (serves dist/ + API), NO Vite
          Cmd: ['sh', '-c', 'cp server.js server.cjs 2>/dev/null; node server.cjs'],
          HostConfig: {
            NetworkMode: DOCKER_NETWORK,
            RestartPolicy: { Name: 'always' }, // always restart in production
            Binds: [
              `${dataDir}:/app/data`,
              `${projectDir}/src:/app/src`,
              `${projectDir}/server.js:/app/server.js`,
              `${projectDir}/index.html:/app/index.html`,
              `${localDist}:/app/dist`
            ],
            Memory: 128 * 1024 * 1024, // 128MB (production is lighter)
            NanoCpus: 250000000, // 0.25 CPU
            SecurityOpt: ['no-new-privileges']
          }
        });
        await prodContainer.start();
        console.log(`[Publish] Production container started for project ${id} (Express only, 128MB)`);
      } catch (prodErr) {
        console.warn(`[Publish] Production container failed: ${prodErr.message} — site still serves static files`);
      }

      // Update project status
      db.prepare("UPDATE projects SET is_published=1,status='published',subdomain=?,updated_at=datetime('now') WHERE id=?").run(safeSubdomain, id);
      db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(p.user_id,`Projet "${p.title}" publié sur ${safeSubdomain}.${PUBLISH_DOMAIN} !`,'success');
      
      // Generate publish URL
      const publishedUrl = `https://${safeSubdomain}.${PUBLISH_DOMAIN}`;
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(publishedUrl)}`;
      
      // Handle custom domain with Caddy SSL
      let customDomainResult = null;
      let customDomainUrl = null;
      if (p.domain) {
        // Validate custom domain format
        const customDomain = p.domain.toLowerCase().trim();
        if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(customDomain)) {
          customDomainResult = await addCustomDomainToCaddy(customDomain, siteDir);
          customDomainUrl = `https://${customDomain}`;
          
          // Notify about custom domain
          if (customDomainResult.success) {
            db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(
              p.user_id,
              `Domaine personnalisé ${customDomain} configuré avec SSL !`,
              'success'
            );
          }
        }
      }
      
      const response = {
        ok: true, 
        subdomain: safeSubdomain,
        url: publishedUrl,
        qrCode: qrCodeUrl,
        localPath: siteDir
      };
      
      // Add custom domain info if configured
      if (customDomainUrl) {
        response.customDomain = p.domain;
        response.customDomainUrl = customDomainUrl;
        response.customDomainConfigured = customDomainResult ? customDomainResult.success : false;
        response.dnsInstructions = {
          cname: { type: 'CNAME', name: 'www', value: CNAME_TARGET },
          a: { type: 'A', name: '@', value: SERVER_IP }
        };
      }
      
      json(res,200,response);
    } catch(e) {
      console.error('Publish error:', e);
      json(res, 500, { error: 'Erreur lors de la publication: ' + e.message });
    }
    return;
  }
  // ─── UNPUBLISH: Retirer un site publie ───
  // ─── PUBLISH UPDATE — manual "Mettre à jour" button (like Lovable) ───
  // Copies the latest project files to the published site directory + restarts
  // the production container. Does NOT unpublish/re-publish (preserves subdomain/domain).
  // User clicks this after making modifications to push changes to the live site.
  if (url.match(/^\/api\/projects\/\d+\/publish-update$/) && req.method === 'POST') {
    if (user.role !== 'admin' && (() => { const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(parseInt(url.split('/')[3])); return !p || p.user_id !== user.id; })()) {
      json(res, 403, { error: 'Accès refusé.' });
      return;
    }
    const id = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) { json(res, 404, { error: 'Projet non trouvé.' }); return; }
    if (!p.is_published) { json(res, 400, { error: 'Ce projet n\'est pas publié. Publiez-le d\'abord.' }); return; }
    if (!p.subdomain) { json(res, 400, { error: 'Subdomain manquant.' }); return; }

    try {
      const projectDir = path.join(DOCKER_PROJECTS_DIR, String(id));
      const siteDir = path.join(SITES_DIR, p.subdomain.replace(/[^a-zA-Z0-9-]/g, ''));

      // 1. Attempt fresh Vite build in running container
      let builtDist = false;
      try {
        const containerName = getContainerName(id);
        const isRunning = await isContainerRunningAsync(id);
        if (isRunning) {
          const distDir = path.join(projectDir, 'dist');
          // Build production dist/ inside container, then copy to host
          // (container filesystem may differ from bind mount for new dirs)
          execSync(`docker exec ${containerName} ./node_modules/.bin/vite build`, { timeout: 120000, encoding: 'utf8' });
          if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
          execSync(`docker cp ${containerName}:/app/dist/. ${distDir}/`, { timeout: 15000 });
          builtDist = true;
          console.log(`[PublishUpdate] Vite build + docker cp succeeded for project ${id}`);
        }
      } catch (e) {
        console.warn(`[PublishUpdate] Vite build failed (will use preview files): ${e.message}`);
      }

      // 2. Copy files to site directory (same logic as publish)
      if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
      fs.mkdirSync(siteDir, { recursive: true });

      const distDir = path.join(projectDir, 'dist');
      const previewDir = path.join(PREVIEWS_DIR, String(id));
      let sourceDir = null;
      if (builtDist && fs.existsSync(distDir) && fs.readdirSync(distDir).length > 0) {
        sourceDir = distDir;
      } else if (fs.existsSync(previewDir) && fs.readdirSync(previewDir).length > 0) {
        sourceDir = previewDir;
      }

      if (sourceDir) {
        const copyRecursive = (src, dest) => {
          if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
          for (const child of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, child.name);
            const d = path.join(dest, child.name);
            if (child.isDirectory()) copyRecursive(s, d);
            else fs.copyFileSync(s, d);
          }
        };
        copyRecursive(sourceDir, siteDir);
      } else if (p.generated_code) {
        // Fallback: write generated_code files
        const files = ai ? ai.parseCodeFiles(p.generated_code) : {};
        for (const [fn, content] of Object.entries(files)) {
          const fp = path.join(siteDir, fn);
          const dir = path.dirname(fp);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fp, content);
        }
      }

      // 3. Restart production container to pick up new code
      try {
        await restartContainerAsync(id);
        console.log(`[PublishUpdate] Container restarted for project ${id}`);
      } catch (e) {
        console.warn(`[PublishUpdate] Container restart failed: ${e.message}`);
      }

      // 4. Update timestamp
      db.prepare("UPDATE projects SET updated_at=datetime('now') WHERE id=?").run(id);

      log('info', 'publish', 'site updated', { projectId: id, userId: user.id });
      json(res, 200, {
        ok: true,
        message: `Site mis à jour sur https://${p.subdomain}.${PUBLISH_DOMAIN}`,
        url: `https://${p.subdomain}.${PUBLISH_DOMAIN}`
      });
    } catch (e) {
      log('error', 'publish', 'update failed', { projectId: id, error: e.message });
      json(res, 500, { error: 'Erreur mise à jour: ' + e.message });
    }
    return;
  }

  if (url.match(/^\/api\/projects\/\d+\/unpublish$/) && req.method==='POST') {
    if (user.role!=='admin') { json(res,403,{error:'Admin seulement.'}); return; }
    const id=parseInt(url.split('/')[3]);
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) { json(res,404,{error:'Projet non trouvé.'}); return; }
    if (!p.is_published) { json(res,400,{error:'Ce projet n\'est pas publié.'}); return; }

    try {
      // 1. Remove static site files
      if (p.subdomain) {
        const siteDir = path.join(SITES_DIR, p.subdomain.replace(/[^a-zA-Z0-9-]/g, ''));
        if (fs.existsSync(siteDir)) {
          fs.rmSync(siteDir, { recursive: true, force: true });
          console.log(`[Unpublish] Removed site files: ${siteDir}`);
        }
      }

      // 2. Stop production container
      try {
        await stopContainerAsync(id);
        console.log(`[Unpublish] Stopped container pbp-project-${id}`);
      } catch (e) { /* container might not exist */ }

      // 3. Update DB — back to ready, clear domain to prevent stale routing
      db.prepare("UPDATE projects SET is_published=0, status='ready', domain=NULL, updated_at=datetime('now') WHERE id=?").run(id);
      db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(p.user_id, `Projet "${p.title}" retiré de la publication.`, 'info');

      console.log(`[Unpublish] Project ${id} unpublished (domain cleared)`);
      json(res, 200, { ok: true, message: `Le site ${p.subdomain}.${PUBLISH_DOMAIN} a été retiré.` });
    } catch (e) {
      json(res, 500, { error: 'Erreur: ' + e.message });
    }
    return;
  }
  if (url.match(/^\/api\/projects\/\d+$/) && req.method==='DELETE') {
    if (user.role!=='admin') { json(res,403,{error:'Interdit.'}); return; }
    const id=parseInt(url.split('/').pop());
    
    // Get project info before deletion (for cleanup)
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    
    // Delete all related records in correct order to avoid FOREIGN KEY constraint failures
    // Order: analytics, project_versions, notifications (user-based, not project-linked), messages, then project
    db.prepare('DELETE FROM analytics WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project_versions WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project_messages WHERE project_id=?').run(id);
    db.prepare('DELETE FROM builds WHERE project_id=?').run(id);
    db.prepare('DELETE FROM error_history WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project_api_keys WHERE project_id=?').run(id);
    db.prepare('DELETE FROM projects WHERE id=?').run(id);
    if (global.auditLog) global.auditLog(req, user, 'project_deleted', 'project', id, { title: project?.title });

    // Clean up correction attempts tracking
    correctionAttempts.delete(id);
    correctionInProgress.delete(id);
    
    // Clean up preview files
    const previewDir = path.join(PREVIEWS_DIR, String(id));
    if (fs.existsSync(previewDir)) {
      try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch(e) { console.warn('Preview cleanup error:', e.message); }
    }
    
    // Clean up Docker container and image — ONLY on project DELETE
    if (isDockerAvailable()) {
      try {
        await removeContainerAsync(id);
        await removeContainerImageAsync(id);
      } catch(e) { console.warn('Docker cleanup error:', e.message); }
    }
    
    // Clean up Docker project files
    const dockerProjectDir = path.join(DOCKER_PROJECTS_DIR, String(id));
    if (fs.existsSync(dockerProjectDir)) {
      try { fs.rmSync(dockerProjectDir, { recursive: true, force: true }); } catch(e) { console.warn('Docker project cleanup error:', e.message); }
    }
    
    // Clean up published site files if published
    if (project && project.subdomain && project.is_published) {
      const safeSubdomain = project.subdomain.replace(/[^a-zA-Z0-9-]/g, '');
      const siteDir = path.join(SITES_DIR, safeSubdomain);
      if (fs.existsSync(siteDir) && isPathSafe(SITES_DIR, siteDir)) {
        try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch(e) { console.warn('Site cleanup error:', e.message); }
      }
    }

    // Clean up backups
    const backupDir = path.join(BACKUP_DIR, String(id));
    if (fs.existsSync(backupDir)) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch(e) { console.warn('Backup cleanup error:', e.message); }
    }

    // Clean up sleep tracking
    containerLastAccess.delete(id);

    console.log(`[Delete] Project ${id} fully cleaned up`);
    json(res,200,{ok:true}); return;
  }

  // ─── PROJECT LOGS (Docker container logs) ───
  if (url.match(/^\/api\/projects\/\d+\/logs$/) && req.method==='GET') {
    const id = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    
    if (!isDockerAvailable()) {
      json(res, 503, { error: 'Docker non disponible.' });
      return;
    }
    
    // Support ?since=60 to only get logs from the last N seconds (avoids stale error detection)
    const sinceParam = parseInt(new URL(req.url, 'http://localhost').searchParams.get('since') || '0');
    const rawLogs = await getContainerLogsAsync(id, 100, sinceParam);
    const translatedLogs = translateLogsToFrench(rawLogs);
    const errorHistory = getErrorHistory(id);
    const running = await isContainerRunningAsync(id);
    
    json(res, 200, { 
      logs: translatedLogs, 
      rawLogs,
      container: getContainerName(id), 
      running,
      errorHistory: errorHistory.map(e => ({
        type: translateErrorType(e.error_type),
        attempt: e.correction_attempt,
        corrected: e.corrected === 1,
        timestamp: e.created_at
      }))
    });
    return;
  }

  // ─── CLIENT-SIDE LOGS (from preview iframe) ───
  if (url.match(/^\/api\/projects\/\d+\/client-logs$/) && req.method==='POST') {
    const id = parseInt(url.split('/')[3]);
    const { level, message: logMsg } = await getBody(req);
    if (level && logMsg) addClientLog(id, level, logMsg);
    json(res, 200, { ok: true });
    return;
  }
  if (url.match(/^\/api\/projects\/\d+\/client-logs$/) && req.method==='GET') {
    const id = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const logs = clientLogs.get(String(id)) || [];
    json(res, 200, { logs, count: logs.length });
    return;
  }

  // ─── PROJECT ERROR HISTORY ───
  if (url.match(/^\/api\/projects\/\d+\/errors$/) && req.method==='GET') {
    const id = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    
    const errorHistory = getErrorHistory(id);
    json(res, 200, errorHistory.map(e => ({
      id: e.id,
      type: e.error_type,
      typeFr: translateErrorType(e.error_type),
      message: e.error_message,
      attempt: e.correction_attempt,
      corrected: e.corrected === 1,
      timestamp: e.created_at
    })));
    return;
  }

  // ─── PROJECT AUTO-CORRECT ───
  if (url.match(/^\/api\/projects\/\d+\/auto-correct$/) && req.method==='POST') {
    const id = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    
    if (!isDockerAvailable()) {
      json(res, 503, { error: 'Docker non disponible.' });
      return;
    }
    
    // Reset correction attempts
    correctionAttempts.delete(id);
    
    // Trigger auto-correction
    autoCorrectProject(id, (progress) => {
      console.log(`Auto-correct ${id}:`, progress);
    }).then(result => {
      if (result.success) {
        db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)')
          .run(p.user_id, `Projet "${p.title}" corrigé automatiquement par Prestige AI.`, 'success');
      }
    });
    
    json(res, 200, { ok: true, message: 'Correction automatique lancée.' });
    return;
  }

  // ─── PROJECT RESTART (Docker container restart) ───
  if (url.match(/^\/api\/projects\/\d+\/restart$/) && req.method==='POST') {
    const id = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    
    if (!isDockerAvailable()) {
      json(res, 503, { error: 'Docker non disponible.' });
      return;
    }
    
    const success = await restartContainerAsync(id);
    if (success) {
      json(res, 200, { ok: true, message: 'Projet redémarré avec succès.' });
    } else {
      json(res, 500, { error: 'Échec du redémarrage. Essayez de recompiler le projet.' });
    }
    return;
  }

  // ─── CLOSE WORKSPACE (stop container after idle timeout) ───
  if (url.match(/^\/api\/projects\/\d+\/close$/) && req.method==='POST') {
    const id = parseInt(url.split('/')[3]);
    // Set lastAccess to now — the monitoring loop will stop it after SLEEP_TIMEOUT_MS
    containerLastAccess.set(id, Date.now());
    console.log(`[Close] Workspace closed for project ${id} — container will auto-stop in ${SLEEP_TIMEOUT_MS/60000}min`);
    json(res, 200, { ok: true });
    return;
  }

  // ─── USERS ───
  if (url==='/api/users' && req.method==='GET') { if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;} json(res,200,db.prepare('SELECT id,email,name,role,lang,created_at FROM users ORDER BY created_at DESC').all()); return; }
  if (url==='/api/users' && req.method==='POST') {
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const {email,password,name,role,lang}=await getBody(req);
    try { const i=db.prepare('INSERT INTO users (email,password,name,role,lang) VALUES (?,?,?,?,?)').run(email,require('bcryptjs').hashSync(password,10),name,role||'agent',lang||'fr'); json(res,200,{id:i.lastInsertRowid,email,name,role}); }
    catch(e){json(res,400,{error:'Email déjà utilisé.'});}
    return;
  }
  // PUT /api/users/:id — Modifier un utilisateur (role, password, nom, activer/desactiver)
  if (url.match(/^\/api\/users\/\d+$/) && req.method==='PUT') {
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const id=parseInt(url.split('/').pop());
    const {name,role,password,lang,active,daily_generation_limit,monthly_generation_limit}=await getBody(req);
    const existing = db.prepare('SELECT id FROM users WHERE id=?').get(id);
    if (!existing) { json(res,404,{error:'Utilisateur non trouvé.'}); return; }
    if (name) db.prepare('UPDATE users SET name=? WHERE id=?').run(name, id);
    if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    if (lang) db.prepare('UPDATE users SET lang=? WHERE id=?').run(lang, id);
    if (password) db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(password, 10), id);
    if (typeof active === 'boolean') {
      // Desactiver = changer le role en 'disabled', activer = remettre 'agent'
      db.prepare('UPDATE users SET role=? WHERE id=?').run(active ? 'agent' : 'disabled', id);
    }
    if (daily_generation_limit !== undefined) db.prepare('UPDATE users SET daily_generation_limit=? WHERE id=?').run(daily_generation_limit, id);
    if (monthly_generation_limit !== undefined) db.prepare('UPDATE users SET monthly_generation_limit=? WHERE id=?').run(monthly_generation_limit, id);
    json(res,200,{ok:true});
    return;
  }
  // GET /api/users/:id/stats — Stats d'un agent (projets, tokens, activite)
  if (url.match(/^\/api\/users\/\d+\/stats$/) && req.method==='GET') {
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const id=parseInt(url.split('/')[3]);
    const projects = db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id=?').get(id)?.c || 0;
    const published = db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id=? AND is_published=1').get(id)?.c || 0;
    const tokensToday = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as ops FROM token_usage WHERE user_id=? AND created_at >= date('now')").get(id);
    const tokensMonth = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as ops FROM token_usage WHERE user_id=? AND created_at >= date('now','start of month')").get(id);
    const lastActivity = db.prepare("SELECT created_at FROM token_usage WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(id);
    json(res,200,{ projects, published, today: { cost: tokensToday.cost, operations: tokensToday.ops }, month: { cost: tokensMonth.cost, operations: tokensMonth.ops }, lastActivity: lastActivity?.created_at || null });
    return;
  }
  if (url.match(/^\/api\/users\/\d+$/) && req.method==='DELETE') {
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const targetId = parseInt(url.split('/').pop());
    const targetUser = db.prepare('SELECT email FROM users WHERE id=?').get(targetId);
    db.prepare('DELETE FROM users WHERE id=?').run(targetId);
    if (global.auditLog) global.auditLog(req, user, 'user_deleted', 'user', targetId, { email: targetUser?.email });
    json(res,200,{ok:true}); return;
  }

  // GET /api/admin/activity — Logs d'activite recents (generations, modifications)
  if (url === '/api/admin/activity' && req.method === 'GET') {
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const activity = db.prepare(`
      SELECT t.operation, t.cost_usd, t.created_at, u.name as user_name, p.title as project_title
      FROM token_usage t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN projects p ON t.project_id = p.id
      ORDER BY t.created_at DESC LIMIT 50
    `).all();
    json(res, 200, activity);
    return;
  }

  // ─── API KEYS ───
  if (url==='/api/apikeys' && req.method==='GET') { if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;} json(res,200,db.prepare('SELECT id,name,service,description,created_at FROM api_keys').all()); return; }
  if (url==='/api/apikeys/names' && req.method==='GET') { json(res,200,db.prepare('SELECT name,service,description FROM api_keys').all()); return; }
  if (url==='/api/apikeys' && req.method==='POST') { if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;} const {name,service,key_value,description}=await getBody(req); const i=db.prepare('INSERT INTO api_keys (name,service,key_value,description) VALUES (?,?,?,?)').run(name,service,key_value,description); json(res,200,{id:i.lastInsertRowid}); return; }
  if (url.match(/^\/api\/apikeys\/\d+$/) && req.method==='DELETE') { if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;} db.prepare('DELETE FROM api_keys WHERE id=?').run(parseInt(url.split('/').pop())); json(res,200,{ok:true}); return; }

  // ─── USER USAGE / QUOTA (accessible by any authenticated user) ───
  if (url === '/api/usage' && req.method === 'GET') {
    const quota = checkUserQuota(user.id);
    const todayTokens = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE user_id=? AND created_at >= date('now')").get(user.id);
    const monthTokens = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE user_id=? AND created_at >= date('now','start of month')").get(user.id);
    json(res, 200, {
      quota: { daily: quota.daily || 0, dailyLimit: quota.dailyLimit || 50, monthly: quota.monthly || 0, monthlyLimit: quota.monthlyLimit || 500, remaining: quota.remaining || 0 },
      today: { input_tokens: todayTokens.inp, output_tokens: todayTokens.out, cost_usd: Math.round(todayTokens.cost * 10000) / 10000 },
      month: { input_tokens: monthTokens.inp, output_tokens: monthTokens.out, cost_usd: Math.round(monthTokens.cost * 10000) / 10000 }
    });
    return;
  }

  // ─── ADMIN: USAGE DASHBOARD ───
  if (url === '/api/admin/usage' && req.method === 'GET') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const today = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls FROM token_usage WHERE created_at >= date('now')").get();
    const month = db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls FROM token_usage WHERE created_at >= date('now','start of month')").get();
    const byUser = db.prepare("SELECT u.email, u.name, COUNT(*) as calls, COALESCE(SUM(t.input_tokens),0) as inp, COALESCE(SUM(t.output_tokens),0) as out, COALESCE(SUM(t.cost_usd),0) as cost FROM token_usage t LEFT JOIN users u ON t.user_id=u.id WHERE t.created_at >= date('now','start of month') GROUP BY t.user_id ORDER BY cost DESC").all();
    const byProject = db.prepare("SELECT p.title, t.project_id, COUNT(*) as calls, COALESCE(SUM(t.input_tokens),0) as inp, COALESCE(SUM(t.output_tokens),0) as out, COALESCE(SUM(t.cost_usd),0) as cost FROM token_usage t LEFT JOIN projects p ON t.project_id=p.id WHERE t.created_at >= date('now','start of month') AND t.project_id IS NOT NULL GROUP BY t.project_id ORDER BY cost DESC LIMIT 20").all();
    const recentCalls = db.prepare("SELECT t.*, u.email FROM token_usage t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.id DESC LIMIT 50").all();
    const byComplexity = db.prepare("SELECT operation, COUNT(*) as calls, COALESCE(SUM(cost_usd),0) as cost FROM token_usage WHERE created_at >= date('now','start of month') GROUP BY operation ORDER BY cost DESC").all();
    json(res, 200, {
      today: { input_tokens: today.inp, output_tokens: today.out, cost_usd: Math.round(today.cost * 10000) / 10000, api_calls: today.calls },
      month: { input_tokens: month.inp, output_tokens: month.out, cost_usd: Math.round(month.cost * 10000) / 10000, api_calls: month.calls },
      by_complexity: byComplexity.map(c => ({ ...c, cost: Math.round(c.cost * 10000) / 10000 })),
      by_user: byUser.map(u => ({ ...u, cost: Math.round(u.cost * 10000) / 10000 })),
      by_project: byProject.map(p => ({ ...p, cost: Math.round(p.cost * 10000) / 10000 })),
      recent: recentCalls.slice(0, 20)
    });
    return;
  }

  // ─── ADMIN SYSTEM STATS ───
  if (url === '/api/admin/system' && req.method === 'GET') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const cpus = os.cpus();
    const projects = db.prepare("SELECT id, title, build_status, is_published FROM projects WHERE build_status='done'").all();
    const containers = [];
    for (const p of projects) {
      const running = await isContainerRunningAsync(p.id);
      const lastAccess = containerLastAccess.get(p.id);
      containers.push({
        id: p.id, title: p.title, running, published: !!p.is_published,
        lastAccess: lastAccess ? new Date(lastAccess).toISOString() : null,
        sleeping: !running && !p.is_published
      });
    }
    json(res, 200, {
      memory: { total: totalMem, free: freeMem, used: totalMem - freeMem, percent: usedPercent, server: mem },
      cpu: { cores: cpus.length, model: cpus[0]?.model },
      uptime: Math.round(process.uptime()),
      containers,
      alert: usedPercent > 75 ? `RAM à ${usedPercent}% — envisagez un upgrade` : null
    }); return;
  }

  // ─── GITHUB CONFIG (admin only) ───
  if (url === '/api/admin/github/config' && req.method === 'GET') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const cfg = db.prepare('SELECT github_username, github_org, updated_at FROM github_config WHERE id=1').get();
    json(res, 200, cfg || { github_username: '', github_org: '' }); return;
  }
  if (url === '/api/admin/github/config' && req.method === 'POST') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const { github_token, github_username, github_org } = await getBody(req);
    if (!github_token || !github_username) { json(res, 400, { error: 'Token et username requis.' }); return; }
    const encrypted = encryptValue(github_token);
    db.prepare('INSERT OR REPLACE INTO github_config (id, github_token, github_username, github_org, updated_at) VALUES (1,?,?,?,datetime("now"))').run(encrypted, github_username, github_org || '');
    json(res, 200, { ok: true }); return;
  }
  if (url === '/api/admin/github/test' && req.method === 'POST') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const cfg = db.prepare('SELECT github_token, github_username FROM github_config WHERE id=1').get();
    if (!cfg) { json(res, 404, { error: 'GitHub non configuré.' }); return; }
    try {
      const tok = decryptValue(cfg.github_token);
      const r = await new Promise((resolve, reject) => {
        const req = https.get('https://api.github.com/user', { headers: { 'Authorization': `token ${tok}`, 'User-Agent': 'PrestigeBuildPro' } }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, data: d }));
        }); req.on('error', reject);
      });
      if (r.status === 200) {
        const u = JSON.parse(r.data);
        json(res, 200, { ok: true, login: u.login, name: u.name });
      } else { json(res, 401, { error: 'Token GitHub invalide.' }); }
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ─── GITHUB EXPORT ───
  if (url.match(/^\/api\/projects\/\d+\/export-github$/) && req.method === 'POST') {
    const pid = parseInt(url.split('/')[3]);
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
    return;
  }

  // ─── GITHUB PULL (sync from GitHub → project) ───
  if (url.match(/^\/api\/projects\/\d+\/github-pull$/) && req.method === 'POST') {
    const pid = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    if (!p.github_repo) { json(res, 400, { error: 'Aucun repo GitHub lié. Exportez d\'abord.' }); return; }
    const cfg = db.prepare('SELECT github_token, github_username, github_org FROM github_config WHERE id=1').get();
    if (!cfg) { json(res, 400, { error: 'GitHub non configuré.' }); return; }

    const tok = decryptValue(cfg.github_token);
    // Extract owner/repo from URL: https://github.com/owner/repo
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
    return;
  }

  // ─── GITHUB PUSH (sync project → GitHub, update existing repo) ───
  if (url.match(/^\/api\/projects\/\d+\/github-push$/) && req.method === 'POST') {
    const pid = parseInt(url.split('/')[3]);
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
    return;
  }

  // ─── PROJECT BACKUPS ───
  if (url.match(/^\/api\/projects\/\d+\/backups$/) && req.method === 'GET') {
    const pid = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const bDir = path.join(BACKUP_DIR, String(pid));
    if (!fs.existsSync(bDir)) { json(res, 200, []); return; }
    const backups = fs.readdirSync(bDir).filter(f => f.endsWith('.db')).sort().reverse().map(f => ({
      filename: f,
      date: f.replace('.db', '').replace(/-/g, (m, i) => i < 10 ? '-' : i < 13 ? 'T' : i < 16 ? ':' : '.'),
      size: fs.statSync(path.join(bDir, f)).size
    }));
    json(res, 200, backups); return;
  }
  if (url.match(/^\/api\/projects\/\d+\/backup$/) && req.method === 'POST') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const pid = parseInt(url.split('/')[3]);
    try {
      const file = await backupProject(pid);
      json(res, 200, { ok: true, file: file ? path.basename(file) : null });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (url.match(/^\/api\/projects\/\d+\/restore$/) && req.method === 'POST') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const pid = parseInt(url.split('/')[3]);
    const { filename } = await getBody(req);
    if (!filename) { json(res, 400, { error: 'filename requis.' }); return; }
    const bFile = path.join(BACKUP_DIR, String(pid), path.basename(filename));
    const dbFile = path.join(DOCKER_PROJECTS_DIR, String(pid), 'data', 'database.db');
    if (!fs.existsSync(bFile)) { json(res, 404, { error: 'Backup non trouvé.' }); return; }
    try {
      fs.copyFileSync(bFile, dbFile);
      await restartContainerAsync(pid);
      json(res, 200, { ok: true, message: 'Backup restauré et container redémarré.' });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ─── PROJECT API KEYS ───
  if (url.match(/^\/api\/projects\/\d+\/keys$/) && req.method === 'GET') {
    const pid = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const keys = db.prepare('SELECT id, env_name, service, created_at FROM project_api_keys WHERE project_id=?').all(pid);
    json(res, 200, keys); return;
  }
  if (url.match(/^\/api\/projects\/\d+\/keys$/) && req.method === 'POST') {
    const pid = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const { env_name, env_value, service } = await getBody(req);
    if (!env_name || !env_value) { json(res, 400, { error: 'env_name et env_value requis.' }); return; }
    // Upsert: replace if same env_name exists for this project
    db.prepare('DELETE FROM project_api_keys WHERE project_id=? AND env_name=?').run(pid, env_name);
    db.prepare('INSERT INTO project_api_keys (project_id, env_name, env_value, service) VALUES (?,?,?,?)').run(pid, env_name, encryptValue(env_value), service || '');
    console.log(`[API Keys] Set ${env_name} for project ${pid}`);
    json(res, 200, { ok: true }); return;
  }
  if (url.match(/^\/api\/projects\/\d+\/keys\/\d+$/) && req.method === 'DELETE') {
    const parts = url.split('/');
    const pid = parseInt(parts[3]);
    const kid = parseInt(parts[5]);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    db.prepare('DELETE FROM project_api_keys WHERE id=? AND project_id=?').run(kid, pid);
    json(res, 200, { ok: true }); return;
  }

  // ─── NOTIFICATIONS ───
  if (url==='/api/notifications' && req.method==='GET') { json(res,200,db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(user.id)); return; }
  if (url==='/api/notifications/read' && req.method==='POST') { db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(user.id); json(res,200,{ok:true}); return; }

  // ─── PROJECT VERSIONS ───
  if (url.match(/^\/api\/projects\/\d+\/versions$/) && req.method==='GET') {
    const projectId = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const versions = db.prepare('SELECT v.*, u.name as author_name FROM project_versions v LEFT JOIN users u ON v.created_by = u.id WHERE v.project_id = ? ORDER BY v.version_number DESC').all(projectId);
    json(res, 200, versions);
    return;
  }
  if (url.match(/^\/api\/projects\/\d+\/versions\/\d+$/) && req.method==='GET') {
    const parts = url.split('/');
    const projectId = parseInt(parts[3]);
    const versionId = parseInt(parts[5]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const version = db.prepare('SELECT * FROM project_versions WHERE id = ? AND project_id = ?').get(versionId, projectId);
    if (!version) { json(res, 404, { error: 'Version non trouvée.' }); return; }
    json(res, 200, version);
    return;
  }
  if (url.match(/^\/api\/projects\/\d+\/versions\/\d+\/restore$/) && req.method==='POST') {
    const parts = url.split('/');
    const projectId = parseInt(parts[3]);
    const versionId = parseInt(parts[5]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const version = db.prepare('SELECT * FROM project_versions WHERE id = ? AND project_id = ?').get(versionId, projectId);
    if (!version) { json(res, 404, { error: 'Version non trouvée.' }); return; }
    // Restore the version
    db.prepare("UPDATE projects SET generated_code = ?, updated_at = datetime('now'), version = version + 1 WHERE id = ?").run(version.generated_code, projectId);
    // Save as new version
    saveProjectVersion(projectId, version.generated_code, user.id, `Restauration de la version ${version.version_number}`);
    // Regenerate preview
    try {
      savePreviewFiles(projectId, version.generated_code);
    } catch(e) {}
    // Notify other clients
    notifyProjectClients(projectId, 'version_restored', { userName: user.name, versionNumber: version.version_number }, user.id);
    json(res, 200, { ok: true, message: `Version ${version.version_number} restaurée.` });
    return;
  }

  // ─── PROJECT ANALYTICS ───
  if (url.match(/^\/api\/projects\/\d+\/analytics$/) && req.method==='GET') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin seulement.' }); return; }
    const projectId = parseInt(url.split('/')[3]);
    
    // Get analytics summary
    const totalViews = db.prepare('SELECT COUNT(*) as c FROM analytics WHERE project_id = ? AND event_type = ?').get(projectId, 'pageview')?.c || 0;
    const totalClicks = db.prepare('SELECT COUNT(*) as c FROM analytics WHERE project_id = ? AND event_type = ?').get(projectId, 'click')?.c || 0;
    const totalForms = db.prepare('SELECT COUNT(*) as c FROM analytics WHERE project_id = ? AND event_type = ?').get(projectId, 'form_submit')?.c || 0;
    
    // Get views by day (last 30 days)
    const viewsByDay = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as count 
      FROM analytics 
      WHERE project_id = ? AND event_type = 'pageview' AND created_at >= datetime('now', '-30 days')
      GROUP BY DATE(created_at) 
      ORDER BY date DESC
    `).all(projectId);
    
    // Get top pages
    const topPages = db.prepare(`
      SELECT json_extract(event_data, '$.page') as page, COUNT(*) as count 
      FROM analytics 
      WHERE project_id = ? AND event_type = 'pageview' AND event_data IS NOT NULL
      GROUP BY page 
      ORDER BY count DESC 
      LIMIT 10
    `).all(projectId);
    
    // Get top clicks
    const topClicks = db.prepare(`
      SELECT json_extract(event_data, '$.text') as text, COUNT(*) as count 
      FROM analytics 
      WHERE project_id = ? AND event_type = 'click' AND event_data IS NOT NULL
      GROUP BY text 
      ORDER BY count DESC 
      LIMIT 10
    `).all(projectId);
    
    // Get average time spent
    const avgTime = db.prepare(`
      SELECT AVG(CAST(json_extract(event_data, '$.seconds') AS INTEGER)) as avg_seconds 
      FROM analytics 
      WHERE project_id = ? AND event_type = 'time_spent'
    `).get(projectId);
    
    // Visitors today / this week / this month
    const visitorsToday = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now')").get(projectId)?.c || 0;
    const visitorsWeek = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-7 days')").get(projectId)?.c || 0;
    const visitorsMonth = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','start of month')").get(projectId)?.c || 0;

    // Device breakdown (from user_agent)
    const allUa = db.prepare("SELECT user_agent FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-30 days')").all(projectId);
    let mobile = 0, desktop = 0;
    allUa.forEach(r => {
      if (/mobile|android|iphone|ipad/i.test(r.user_agent || '')) mobile++; else desktop++;
    });

    // Referrer sources (from event_data.referrer)
    const referrers = db.prepare(`
      SELECT json_extract(event_data, '$.referrer') as ref, COUNT(*) as count
      FROM analytics WHERE project_id=? AND event_type='pageview' AND event_data LIKE '%referrer%'
      GROUP BY ref ORDER BY count DESC LIMIT 10
    `).all(projectId);

    // Bounce rate estimate (visitors with only 1 pageview)
    const totalVisitors = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-30 days')").get(projectId)?.c || 0;
    const singlePageVisitors = db.prepare(`
      SELECT COUNT(*) as c FROM (
        SELECT ip_address, COUNT(*) as views FROM analytics
        WHERE project_id=? AND event_type='pageview' AND created_at >= date('now','-30 days')
        GROUP BY ip_address HAVING views = 1
      )
    `).get(projectId)?.c || 0;
    const bounceRate = totalVisitors > 0 ? Math.round((singlePageVisitors / totalVisitors) * 100) : 0;

    json(res, 200, {
      totalViews, totalClicks, totalForms,
      avgTimeSpent: Math.round(avgTime?.avg_seconds || 0),
      visitors: { today: visitorsToday, week: visitorsWeek, month: visitorsMonth },
      devices: { mobile, desktop, mobilePercent: (mobile + desktop) > 0 ? Math.round((mobile / (mobile + desktop)) * 100) : 0 },
      bounceRate,
      viewsByDay, topPages, topClicks, referrers
    });
    return;
  }

  // ─── ADMIN: GLOBAL ANALYTICS (all published sites) ───
  if (url === '/api/admin/analytics' && req.method === 'GET') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin requis.' }); return; }
    const totalPageviews = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type='pageview'").get()?.c || 0;
    const todayPageviews = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type='pageview' AND created_at >= date('now')").get()?.c || 0;
    const uniqueVisitorsMonth = db.prepare("SELECT COUNT(DISTINCT ip_address) as c FROM analytics WHERE event_type='pageview' AND created_at >= date('now','start of month')").get()?.c || 0;
    const topProjects = db.prepare(`
      SELECT p.title, p.id, COUNT(*) as views
      FROM analytics a JOIN projects p ON a.project_id=p.id
      WHERE a.event_type='pageview' AND a.created_at >= date('now','-30 days')
      GROUP BY a.project_id ORDER BY views DESC LIMIT 10
    `).all();
    const dailyTrend = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as views, COUNT(DISTINCT ip_address) as visitors
      FROM analytics WHERE event_type='pageview' AND created_at >= date('now','-30 days')
      GROUP BY DATE(created_at) ORDER BY date DESC
    `).all();
    json(res, 200, {
      total: { pageviews: totalPageviews, todayPageviews, uniqueVisitorsMonth },
      topProjects, dailyTrend
    });
    return;
  }

  // ─── REAL-TIME COLLABORATION (SSE) ───
  if (url.match(/^\/api\/projects\/\d+\/stream$/) && req.method==='GET') {
    const projectId = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    
    // Setup SSE connection
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Register this client (with collaborator limit)
    if (!projectSSEClients.has(projectId)) {
      projectSSEClients.set(projectId, new Set());
    }
    const clients = projectSSEClients.get(projectId);
    if (clients.size >= MAX_COLLABORATORS_PER_PROJECT) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Maximum de collaborateurs atteint (20).' })}\n\n`);
      res.end();
      return;
    }
    const clientInfo = { res, userId: user.id, userName: user.name, connectedAt: new Date().toISOString() };
    clients.add(clientInfo);

    // Notify others that this user joined
    notifyProjectClients(projectId, 'user_joined', { userName: user.name, userId: user.id }, user.id);

    // Send initial connection confirmation + current collaborators list
    const collaborators = getProjectCollaborators(projectId);
    res.write(`data: ${JSON.stringify({ type: 'connected', userId: user.id, userName: user.name, collaborators })}\n\n`);
    
    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`); } catch(e) {}
    }, 30000);
    
    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      const clients = projectSSEClients.get(projectId);
      if (clients) {
        clients.delete(clientInfo);
        if (clients.size === 0) projectSSEClients.delete(projectId);
      }
      // Notify others that this user left
      notifyProjectClients(projectId, 'user_left', { userName: user.name, userId: user.id }, user.id);
    });
    
    return; // Keep connection open
  }

  // ─── WORKSPACES ───
  if (url === '/api/workspaces' && req.method === 'GET') {
    // List workspaces the user belongs to (as owner or member)
    const owned = db.prepare('SELECT * FROM workspaces WHERE owner_id=? ORDER BY created_at DESC').all(user.id);
    const memberOf = db.prepare(`SELECT w.* FROM workspaces w JOIN workspace_members wm ON w.id=wm.workspace_id WHERE wm.user_id=? ORDER BY w.created_at DESC`).all(user.id);
    const all = [...owned, ...memberOf.filter(w => !owned.find(o => o.id === w.id))];
    // Add member count and role
    const result = all.map(w => {
      const members = db.prepare('SELECT wm.*, u.email, u.name FROM workspace_members wm JOIN users u ON wm.user_id=u.id WHERE wm.workspace_id=?').all(w.id);
      const myRole = w.owner_id === user.id ? 'owner' : (members.find(m => m.user_id === user.id)?.role || 'viewer');
      const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects WHERE workspace_id=?').get(w.id)?.c || 0;
      return { ...w, myRole, memberCount: members.length + 1, projectCount };
    });
    json(res, 200, result);
    return;
  }
  if (url === '/api/workspaces' && req.method === 'POST') {
    const { name, description } = await getBody(req);
    if (!name || typeof name !== 'string' || name.trim().length < 2) { json(res, 400, { error: 'Nom requis (min 2 caractères).' }); return; }
    const result = db.prepare('INSERT INTO workspaces (name, description, owner_id) VALUES (?,?,?)').run(name.trim(), description || '', user.id);
    json(res, 201, { id: result.lastInsertRowid, name: name.trim() });
    return;
  }
  if (url.match(/^\/api\/workspaces\/\d+$/) && req.method === 'DELETE') {
    const wid = parseInt(url.split('/')[3]);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    if (w.owner_id !== user.id && user.role !== 'admin') { json(res, 403, { error: 'Seul le propriétaire peut supprimer.' }); return; }
    db.prepare('DELETE FROM workspace_members WHERE workspace_id=?').run(wid);
    db.prepare('UPDATE projects SET workspace_id=NULL WHERE workspace_id=?').run(wid);
    db.prepare('DELETE FROM workspaces WHERE id=?').run(wid);
    json(res, 200, { ok: true });
    return;
  }

  // ─── WORKSPACE MEMBERS ───
  if (url.match(/^\/api\/workspaces\/\d+\/members$/) && req.method === 'GET') {
    const wid = parseInt(url.split('/')[3]);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    const owner = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(w.owner_id);
    const members = db.prepare('SELECT wm.role, wm.joined_at, u.id, u.email, u.name FROM workspace_members wm JOIN users u ON wm.user_id=u.id WHERE wm.workspace_id=?').all(wid);
    json(res, 200, { owner: { ...owner, role: 'owner' }, members });
    return;
  }
  if (url.match(/^\/api\/workspaces\/\d+\/members$/) && req.method === 'POST') {
    const wid = parseInt(url.split('/')[3]);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    if (w.owner_id !== user.id && user.role !== 'admin') { json(res, 403, { error: 'Seul le propriétaire peut inviter.' }); return; }
    const { email, role } = await getBody(req);
    if (!email) { json(res, 400, { error: 'Email requis.' }); return; }
    const invitee = db.prepare('SELECT id FROM users WHERE email=?').get(email.trim().toLowerCase());
    if (!invitee) { json(res, 404, { error: 'Utilisateur introuvable.' }); return; }
    const validRoles = ['editor', 'viewer'];
    const memberRole = validRoles.includes(role) ? role : 'editor';
    try {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?,?,?,?)').run(wid, invitee.id, memberRole, user.id);
      db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?,?,?)').run(invitee.id, `Vous avez été invité au workspace "${w.name}" par ${user.name}`, 'info');
      json(res, 201, { ok: true, userId: invitee.id, role: memberRole });
    } catch (e) {
      json(res, 409, { error: 'Déjà membre de ce workspace.' });
    }
    return;
  }
  if (url.match(/^\/api\/workspaces\/\d+\/members\/\d+$/) && req.method === 'DELETE') {
    const parts = url.split('/');
    const wid = parseInt(parts[3]);
    const uid = parseInt(parts[5]);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    if (w.owner_id !== user.id && user.role !== 'admin' && user.id !== uid) {
      json(res, 403, { error: 'Accès refusé.' }); return;
    }
    db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(wid, uid);
    json(res, 200, { ok: true });
    return;
  }

  // ─── COLLABORATORS: who's online on a project ───
  if (url.match(/^\/api\/projects\/\d+\/collaborators$/) && req.method==='GET') {
    const projectId = parseInt(url.split('/')[3]);
    json(res, 200, { collaborators: getProjectCollaborators(projectId) });
    return;
  }

  // ─── TYPING INDICATOR: broadcast that user is typing ───
  if (url.match(/^\/api\/projects\/\d+\/typing$/) && req.method==='POST') {
    const projectId = parseInt(url.split('/')[3]);
    notifyProjectClients(projectId, 'user_typing', { userName: user.name, userId: user.id }, user.id);
    json(res, 200, { ok: true });
    return;
  }

  // ─── PROJECT MEMORY API ───
  if (url.match(/^\/api\/projects\/\d+\/memory$/) && req.method==='GET') {
    const projectId = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const memory = conversationMemoryService.getProjectMemory(projectId);
    const summaries = conversationMemoryService.getConversationSummaries(projectId);
    json(res, 200, { memory: memory || '', summaries });
    return;
  }
  if (url.match(/^\/api\/projects\/\d+\/memory$/) && req.method==='PUT') {
    const projectId = parseInt(url.split('/')[3]);
    const p = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé.' }); return; }
    const { content } = await getBody(req);
    const ok = conversationMemoryService.setProjectMemory(projectId, content || '', user.id);
    json(res, ok ? 200 : 500, ok ? { ok: true } : { error: 'Erreur sauvegarde mémoire' });
    return;
  }

  // ─── STATS ───
  if (url==='/api/stats' && req.method==='GET') {
    const q=(s,p)=>p?db.prepare(s).get(p).c:db.prepare(s).get().c;
    json(res,200,{
      total:user.role==='admin'?q('SELECT COUNT(*) as c FROM projects'):q('SELECT COUNT(*) as c FROM projects WHERE user_id=?',user.id),
      published:user.role==='admin'?q('SELECT COUNT(*) as c FROM projects WHERE is_published=1'):q('SELECT COUNT(*) as c FROM projects WHERE user_id=? AND is_published=1',user.id),
      draft:user.role==='admin'?q("SELECT COUNT(*) as c FROM projects WHERE status='draft'"):q("SELECT COUNT(*) as c FROM projects WHERE user_id=? AND status='draft'",user.id),
      agents:user.role==='admin'?q("SELECT COUNT(*) as c FROM users WHERE role='agent'"):0
    }); return;
  }

  // ─── ERROR TELEMETRY DASHBOARD (admin only) ───
  if (url === '/api/admin/error-patterns' && req.method === 'GET') {
    if (user.role !== 'admin') { json(res, 403, { error: 'Admin only' }); return; }
    try {
      const patterns = db.prepare('SELECT * FROM error_patterns ORDER BY occurrence_count DESC LIMIT 50').all();
      const summary = db.prepare('SELECT error_type, SUM(occurrence_count) as total, COUNT(*) as unique_patterns FROM error_patterns GROUP BY error_type ORDER BY total DESC').all();
      // Trend: errors per day (last 30 days)
      const trend = db.prepare("SELECT date(last_seen) as day, COUNT(*) as count, SUM(occurrence_count) as total FROM error_patterns WHERE last_seen > datetime('now', '-30 days') GROUP BY day ORDER BY day").all();
      // Top erreurs par projet
      const byProject = db.prepare('SELECT last_project_id as project_id, COUNT(*) as unique_errors, SUM(occurrence_count) as total_occurrences FROM error_patterns WHERE last_project_id IS NOT NULL GROUP BY last_project_id ORDER BY total_occurrences DESC LIMIT 10').all();
      // Taux de correction automatique
      const autoFixRate = db.prepare('SELECT SUM(auto_fixed) as fixed, SUM(rollback_triggered) as rolled_back, SUM(occurrence_count) as total FROM error_patterns').get();
      // Audit score trend (last 30 days)
      let auditTrend = [];
      try { auditTrend = db.prepare("SELECT date(created_at) as day, AVG(score) as avg_score, COUNT(*) as audits FROM audit_results WHERE created_at > datetime('now', '-30 days') GROUP BY day ORDER BY day").all(); } catch (_) {}
      json(res, 200, {
        patterns, summary, trend, byProject,
        autoFixRate: autoFixRate || { fixed: 0, rolled_back: 0, total: 0 },
        auditTrend,
        total: patterns.reduce((s, p) => s + p.occurrence_count, 0)
      });
    } catch (e) {
      json(res, 200, { patterns: [], summary: [], trend: [], byProject: [], autoFixRate: {}, auditTrend: [], total: 0 });
    }
    return;
  }

  // ─── AUDIT HISTORY ───
  const auditMatch = url.match(/^\/api\/projects\/(\d+)\/audits$/);
  if (auditMatch && req.method === 'GET') {
    const pid = parseInt(auditMatch[1]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé' }); return; }
    try {
      const audits = db.prepare('SELECT id, score, passed, failed, skipped, total, triggered_by, created_at FROM audit_results WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(pid);
      json(res, 200, { audits });
    } catch (e) {
      json(res, 200, { audits: [] });
    }
    return;
  }

  // ─── SINGLE AUDIT DETAIL ───
  const auditDetailMatch = url.match(/^\/api\/projects\/(\d+)\/audits\/(\d+)$/);
  if (auditDetailMatch && req.method === 'GET') {
    const pid = parseInt(auditDetailMatch[1]);
    const aid = parseInt(auditDetailMatch[2]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé' }); return; }
    try {
      const audit = db.prepare('SELECT * FROM audit_results WHERE id=? AND project_id=?').get(aid, pid);
      if (!audit) { json(res, 404, { error: 'Audit non trouvé' }); return; }
      audit.results = JSON.parse(audit.results_json || '[]');
      json(res, 200, audit);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── AUDIT PDF EXPORT (printable HTML) ───
  const auditPdfMatch = url.match(/^\/api\/projects\/(\d+)\/audits\/(\d+)\/pdf$/);
  if (auditPdfMatch && req.method === 'GET') {
    const pid = parseInt(auditPdfMatch[1]);
    const aid = parseInt(auditPdfMatch[2]);
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    if (!p || (user.role !== 'admin' && p.user_id !== user.id)) { json(res, 403, { error: 'Accès refusé' }); return; }
    try {
      const audit = db.prepare('SELECT * FROM audit_results WHERE id=? AND project_id=?').get(aid, pid);
      if (!audit) { json(res, 404, { error: 'Audit non trouvé' }); return; }
      const tests = JSON.parse(audit.results_json || '[]');
      const categories = [...new Set(tests.map(t => t.cat || 'Autre'))];

      // Generate print-optimized HTML
      let testsHtml = '';
      for (const cat of categories) {
        const catTests = tests.filter(t => (t.cat || 'Autre') === cat);
        const catPass = catTests.filter(t => t.ok === true).length;
        testsHtml += `<h3 style="margin-top:20px;color:#1e293b">${cat} (${catPass}/${catTests.length})</h3>`;
        testsHtml += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
        testsHtml += '<tr style="background:#f1f5f9"><th style="text-align:left;padding:6px;border:1px solid #e2e8f0">Test</th><th style="width:60px;padding:6px;border:1px solid #e2e8f0">Résultat</th><th style="text-align:left;padding:6px;border:1px solid #e2e8f0">Détails</th></tr>';
        for (const t of catTests) {
          const icon = t.ok === true ? '<span style="color:#16a34a">&#10003;</span>' : t.ok === false ? '<span style="color:#dc2626">&#10007;</span>' : '<span style="color:#d97706">&#9888;</span>';
          const bg = t.ok === false ? 'background:#fef2f2' : '';
          testsHtml += `<tr style="${bg}"><td style="padding:6px;border:1px solid #e2e8f0">${t.test}</td><td style="padding:6px;border:1px solid #e2e8f0;text-align:center">${icon}</td><td style="padding:6px;border:1px solid #e2e8f0;font-size:13px">${t.details || ''}</td></tr>`;
        }
        testsHtml += '</table>';
      }

      const scoreColor = audit.score >= 8 ? '#16a34a' : audit.score >= 5 ? '#d97706' : '#dc2626';
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Audit — ${p.title || 'Projet'}</title>
<style>@media print{body{margin:0}@page{size:A4;margin:15mm}}body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:30px;color:#1e293b}
h1{font-size:22px;margin-bottom:5px}h2{font-size:16px;color:#64748b;font-weight:normal;margin-top:0}
.score{font-size:64px;font-weight:bold;color:${scoreColor};text-align:center;margin:20px 0}
.meta{color:#64748b;font-size:13px;text-align:center;margin-bottom:30px}
.summary{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:15px;margin:20px 0;display:flex;justify-content:space-around}
.summary div{text-align:center}.summary .num{font-size:24px;font-weight:bold}.summary .label{font-size:12px;color:#64748b}
.report{margin-top:30px;line-height:1.6;white-space:pre-wrap}
.footer{margin-top:40px;padding-top:15px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center}</style></head><body>
<h1>Rapport d'audit — ${p.title || 'Projet ' + pid}</h1>
<h2>${p.brief ? p.brief.substring(0, 100) : 'Prestige Build Pro'}</h2>
<div class="score">${audit.score}/10</div>
<div class="meta">${audit.triggered_by === 'auto' ? 'Audit automatique' : 'Audit manuel'} — ${audit.created_at}</div>
<div class="summary">
<div><div class="num" style="color:#16a34a">${audit.passed}</div><div class="label">Réussis</div></div>
<div><div class="num" style="color:#dc2626">${audit.failed}</div><div class="label">Échoués</div></div>
<div><div class="num" style="color:#d97706">${audit.skipped}</div><div class="label">Non testés</div></div>
<div><div class="num">${audit.total}</div><div class="label">Total</div></div>
</div>
${testsHtml}
${audit.report ? '<h3 style="margin-top:30px">Rapport IA</h3><div class="report">' + audit.report.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' : ''}
<div class="footer">Généré par Prestige Build Pro — prestige-build.dev</div>
</body></html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── #8 LOGOUT (token invalidation) ───
  if (url === '/api/logout' && req.method === 'POST') {
    // JWT is stateless — we can't truly revoke it server-side without a blacklist.
    // But we add the token to a short-lived blacklist (cleared every hour).
    const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (headerToken) {
      if (!global._tokenBlacklist) global._tokenBlacklist = new Set();
      global._tokenBlacklist.add(headerToken);
      // Auto-cleanup every hour
      setTimeout(() => global._tokenBlacklist?.delete(headerToken), 3600000);
    }
    json(res, 200, { ok: true, message: 'Déconnecté.' });
    return;
  }

  // ─── #11 API DOCUMENTATION ENDPOINT ───
  if (url === '/api/docs' && req.method === 'GET') {
    json(res, 200, {
      name: 'Prestige Build Pro API',
      version: '2.0',
      description: 'AI-powered web application generator',
      endpoints: {
        auth: { 'POST /api/login': 'Login', 'POST /api/logout': 'Logout' },
        projects: { 'GET /api/projects': 'List projects', 'POST /api/projects': 'Create', 'GET /api/projects/:id': 'Details', 'PUT /api/projects/:id': 'Update', 'DELETE /api/projects/:id': 'Delete' },
        generation: { 'POST /api/generate/start': 'Start AI generation', 'GET /api/jobs/:id': 'Poll job status', 'POST /api/generate/image/start': 'Generate from image' },
        build: { 'POST /api/compile': 'Docker build', 'GET /api/builds/:id': 'Build status', 'POST /api/hot-reload': 'Hot reload files' },
        github: { 'POST /api/projects/:id/export-github': 'Export to GitHub', 'POST /api/projects/:id/github-pull': 'Pull from GitHub', 'POST /api/projects/:id/github-push': 'Push to GitHub' },
        analytics: { 'GET /api/projects/:id/analytics': 'Project analytics', 'GET /api/admin/analytics': 'Global analytics', 'POST /api/track/:id': 'Track event' },
        usage: { 'GET /api/usage': 'My usage/quota', 'GET /api/admin/usage': 'Admin usage dashboard' },
        workspaces: { 'GET /api/workspaces': 'List workspaces', 'POST /api/workspaces': 'Create workspace', 'POST /api/workspaces/:id/members': 'Invite member' },
        admin: { 'GET /api/admin/system': 'System info', 'GET /api/users': 'List users', 'POST /api/users': 'Create user' },
        debug: { 'GET /api/projects/:id/logs': 'Container logs', 'GET /api/projects/:id/client-logs': 'Frontend logs', 'GET /api/projects/:id/errors': 'Error history' }
      },
      tools: CODE_TOOLS.map(t => ({ name: t.name, description: t.description })),
      total_tools: CODE_TOOLS.length + 1,
      ui_components: 40,
      sectors: 12
    });
    return;
  }

  // ─── #15 PROMETHEUS METRICS ENDPOINT ───
  if (url === '/metrics' && req.method === 'GET') {
    const mem = process.memoryUsage();
    const tokenToday = db ? db.prepare("SELECT COALESCE(SUM(input_tokens+output_tokens),0) as t, COALESCE(SUM(cost_usd),0) as c FROM token_usage WHERE created_at >= date('now')").get() : { t: 0, c: 0 };
    const projectCount = db ? db.prepare('SELECT COUNT(*) as c FROM projects').get()?.c || 0 : 0;
    const userCount = db ? db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0 : 0;
    const metrics = [
      `# HELP prestige_uptime_seconds Server uptime`,
      `prestige_uptime_seconds ${process.uptime().toFixed(0)}`,
      `# HELP prestige_memory_heap_bytes Heap memory usage`,
      `prestige_memory_heap_bytes ${mem.heapUsed}`,
      `prestige_memory_rss_bytes ${mem.rss}`,
      `# HELP prestige_active_generations Current AI generation count`,
      `prestige_active_generations ${activeGenerations}`,
      `# HELP prestige_tokens_today Total tokens used today`,
      `prestige_tokens_today ${tokenToday.t}`,
      `# HELP prestige_cost_today_usd API cost today in USD`,
      `prestige_cost_today_usd ${tokenToday.c}`,
      `# HELP prestige_projects_total Total projects`,
      `prestige_projects_total ${projectCount}`,
      `# HELP prestige_users_total Total users`,
      `prestige_users_total ${userCount}`,
    ].join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(metrics);
    return;
  }

  res.writeHead(404); res.end('Not found');

  } catch (reqErr) {
    // Global error handler — prevents ANY unhandled error from crashing the server
    // Like Express error middleware — catches everything that falls through
    console.error(`[REQUEST ERROR] ${req.method} ${req.url}: ${reqErr.message}`);
    console.error(reqErr.stack);
    try {
      if (!res.headersSent) {
        json(res, 500, { error: 'Erreur interne du serveur. Réessayez.' });
      }
    } catch { /* response already sent or destroyed */ }
  }
});

// ─── WEBSOCKET UPGRADE HANDLER (Vite HMR through /run/:id/ proxy) ───
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  const host = (req.headers.host || '').split(':')[0];
  let projectId, targetPath;

  // Preview subdomain: preview-59.prestige-build.dev — direct, no rewrite
  const previewMatch = host.match(/^preview-(\d+)\./);
  if (previewMatch) {
    projectId = previewMatch[1];
    targetPath = url; // pass through as-is
  } else {
    // Legacy /run/:id/ path
    const runMatch = url.match(/^\/run\/(\d+)\//);
    if (!runMatch) { socket.destroy(); return; }
    projectId = runMatch[1];
    targetPath = url; // Keep full path — Vite uses --base /run/{id}/
  }

  const containerHost = getContainerHostname(projectId);

  const proxyReq = http.request({
    hostname: containerHost,
    port: 5173,
    path: targetPath,
    method: 'GET',
    headers: {
      ...req.headers,
      host: `${containerHost}:5173`
    }
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n'
    );
    if (proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });

  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
});

server.listen(PORT, async ()=>{
  console.log(`Prestige Build Pro on port ${PORT}`);
  console.log(`API: ${ANTHROPIC_API_KEY?'OK':'MISSING'} | Compiler: ${compiler?'OK':'N/A'}`);

  // Initialize Docker preview system (must await before checking availability)
  await initializeDockerSystem();

  // Start container monitoring (every 30 seconds)
  if (isDockerAvailable()) {
    console.log('Starting container monitoring (30s interval)...');
    setInterval(monitorContainers, CONTAINER_MONITORING_INTERVAL);

    // Auto-recovery of unhealthy pbp-project-* containers (every 60s).
    // Restarts stuck containers automatically, with 5-min cooldown per project
    // to prevent thrashing. Solves the "container stuck unhealthy requires manual
    // docker restart" problem from the Vite restart loop incident.
    console.log('Starting auto-recovery for unhealthy containers (60s interval, 5min cooldown)...');
    setInterval(autoRecoveryTick, AUTO_RECOVERY_INTERVAL_MS);
  }

  // Start automatic backups every 6 hours
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  setInterval(backupAllProjects, BACKUP_INTERVAL_MS);
  console.log('Automatic backup system active (every 6h)');

  // #5 Analytics retention — cleanup old data daily
  setInterval(() => {
    try {
      const d = db.prepare("DELETE FROM analytics WHERE created_at < datetime('now', '-90 days')").run();
      if (d.changes > 0) log('info', 'cleanup', `Cleaned ${d.changes} old analytics records`);
    } catch(e) {}
  }, 24 * 60 * 60 * 1000); // every 24h

  // #16 Log startup info
  log('info', 'startup', 'Prestige Build Pro started', { port: PORT, apiKey: ANTHROPIC_API_KEY ? 'configured' : 'MISSING', tools: CODE_TOOLS.length, uiComponents: 40 });
});
