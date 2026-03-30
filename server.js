/*
 * PRESTIGE BUILD PRO - Server
 * 
 * ARCHITECTURE: Claude Code Server-Side Generation
 * ─────────────────────────────────────────────────────────────────
 * Code generation is handled by Claude Code running as a child process on the server.
 * Each project gets its own isolated directory: /data/projects/[project_id]/
 * 
 * Generation workflow:
 * 1. Create project directory /data/projects/[project_id]/
 * 2. Write BRIEF.md with the project brief
 * 3. Write CLAUDE.md with generation instructions
 * 4. Spawn Claude Code: claude --dangerously-skip-permissions --print [prompt]
 * 5. Claude Code generates files, tests, and creates READY file on success
 * 6. Server reads the generated files and starts Docker container
 * 
 * Security: Claude Code is isolated to the project directory via cwd parameter.
 * API usage: Direct Anthropic API calls are kept only for small non-generation 
 * operations like error auto-correction.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync, spawn } = require('child_process');
const Dockerode = require('dockerode');

// ─── #12 ENV VAR VALIDATION (fail fast if critical vars missing) ───
const REQUIRED_ENV = ['ANTHROPIC_API_KEY'];
const OPTIONAL_ENV = { PORT: '3000', DB_PATH: './prestige-pro.db', JWT_SECRET: null, DOCKER_PROJECTS_DIR: '/data/projects' };
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) console.warn(`[Config] ⚠️  ${key} non défini — la génération IA ne fonctionnera pas`);
}

// ─── #9 GLOBAL ERROR HANDLERS + #18 GRACEFUL SHUTDOWN ───
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Erreur non gérée: ${err.message}`);
  console.error(err.stack);
  // Exit so Docker/Coolify can restart us in a clean state
  // Staying alive after uncaughtException = corrupted state
  setTimeout(() => process.exit(1), 1000);
});
process.on('unhandledRejection', (err) => {
  console.error(`[FATAL] Promise rejetée: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
});
// Graceful shutdown — clean up on SIGTERM/SIGINT
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal} received — closing gracefully...`);
  // Close HTTP server (stop accepting new connections)
  if (typeof server !== 'undefined' && server.close) {
    server.close(() => console.log('[Shutdown] HTTP server closed'));
  }
  // Close DB
  try { if (db) db.close(); console.log('[Shutdown] Database closed'); } catch(e) {}
  // Exit after 10s max
  setTimeout(() => { console.log('[Shutdown] Forcing exit'); process.exit(0); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── #4 JOB QUEUE LIMIT (max concurrent AI generations) ───
const MAX_CONCURRENT_GENERATIONS = 3;
let activeGenerations = 0;

// ─── #10 STRUCTURED LOGGING ───
function log(level, category, message, meta = {}) {
  const entry = { timestamp: new Date().toISOString(), level, category, message, ...meta };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ─── #3 INPUT VALIDATION HELPERS ───
function validateString(value, name, minLen = 1, maxLen = 10000) {
  if (typeof value !== 'string') return `${name} doit être une chaîne de caractères`;
  if (value.trim().length < minLen) return `${name} trop court (min ${minLen} caractères)`;
  if (value.length > maxLen) return `${name} trop long (max ${maxLen} caractères)`;
  return null;
}
function validateId(value, name = 'ID') {
  const num = parseInt(value);
  if (isNaN(num) || num < 1) return `${name} invalide`;
  return null;
}

// ─── #7 PAGINATION HELPER ───
function paginate(req) {
  const urlParts = req.url.split('?');
  const params = urlParts.length > 1 ? new URLSearchParams(urlParts[1]) : new URLSearchParams();
  const page = Math.max(1, parseInt(params.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit')) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ─── #17 IN-MEMORY CACHE WITH TTL (Redis-like for single server) ───
class MemoryCache {
  constructor() { this._store = new Map(); }
  get(key) {
    const item = this._store.get(key);
    if (!item) return null;
    if (item.expiry && item.expiry < Date.now()) { this._store.delete(key); return null; }
    return item.value;
  }
  set(key, value, ttlMs = 0) {
    const expiry = ttlMs > 0 ? Date.now() + ttlMs : null;
    this._store.set(key, { value, expiry });
  }
  del(key) { this._store.delete(key); }
  has(key) { return this.get(key) !== null; }
  // Cleanup expired entries every 5 minutes
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, item] of this._store) {
        if (item.expiry && item.expiry < now) this._store.delete(key);
      }
    }, 5 * 60 * 1000);
  }
}
const cache = new MemoryCache();
cache.startCleanup();

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || './prestige-pro.db';
const PREVIEWS_DIR = process.env.PREVIEWS_DIR || '/tmp/previews';

// Docker preview system constants
const DOCKER_PROJECTS_DIR = process.env.DOCKER_PROJECTS_DIR || '/data/projects';
const DOCKER_NETWORK = 'pbp-projects';
const DOCKER_BASE_IMAGE = 'pbp-base';

// ─── ENCRYPTION FOR API KEYS AT REST ───
const ENCRYPT_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();
function encryptValue(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + enc;
}
function decryptValue(encrypted) {
  try {
    const [ivHex, tagHex, enc] = encrypted.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch { return encrypted; } // fallback for unencrypted legacy values
}
const DOCKER_HEALTH_TIMEOUT = 15000; // 15 seconds max wait for container health
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

// Dockerode client - communicates directly with Docker socket (no CLI dependency)
let docker = null;
try {
  docker = new Dockerode({ socketPath: DOCKER_SOCKET_PATH });
} catch (e) {
  console.warn('Failed to initialize Dockerode client:', e.message);
}

// ─── ANTHROPIC API RATE LIMIT HANDLER ───
const API_MAX_RETRIES = 5;
const API_QUEUE = [];
let apiRunning = false;

// Human-readable error messages for each API status code
const API_ERROR_MESSAGES = {
  400: 'Requête invalide. Le brief contient peut-être des caractères non supportés.',
  401: 'Clé API Anthropic invalide ou expirée. Contactez l\'administrateur.',
  402: 'Crédit API épuisé. Le compte Anthropic doit être rechargé. Contactez l\'administrateur.',
  403: 'Accès API refusé. Vérifiez les permissions de la clé API.',
  404: 'Modèle API non trouvé. Contactez l\'administrateur.',
  413: 'Le brief est trop long. Réduisez la taille de votre demande.',
  429: 'API surchargée. Réessai automatique en cours...',
  500: 'Erreur interne du serveur Anthropic. Réessayez dans quelques minutes.',
  529: 'Serveur Anthropic surchargé. Réessai automatique en cours...'
};

function anthropicRequest(payload, opts, onResponse, onError, job, retryCount = 0) {
  const r = https.request(opts, apiRes => {
    const status = apiRes.statusCode;

    // Retryable errors: 429 (rate limit) and 529 (overloaded)
    if (status === 429 || status === 529) {
      let body = '';
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        const retryAfter = parseInt(apiRes.headers['retry-after'] || '60');
        const wait = Math.min(retryAfter, 120) * 1000;
        if (retryCount < API_MAX_RETRIES) {
          console.log(`[API] ${status} rate limited, retry ${retryCount + 1}/${API_MAX_RETRIES} in ${wait / 1000}s`);
          if (job) job.progressMessage = `File d'attente API... (tentative ${retryCount + 1}/${API_MAX_RETRIES})`;
          setTimeout(() => anthropicRequest(payload, opts, onResponse, onError, job, retryCount + 1), wait);
        } else {
          console.error(`[API] Rate limit exhausted after ${API_MAX_RETRIES} retries`);
          onError(new Error(API_ERROR_MESSAGES[status] || 'Limite API atteinte.'));
        }
      });
      return;
    }

    // Non-retryable errors: 400, 401, 402, 403, 404, 413, 500
    if (status >= 400 && status !== 200) {
      let body = '';
      apiRes.on('data', c => body += c);
      apiRes.on('end', () => {
        const friendlyMsg = API_ERROR_MESSAGES[status] || `Erreur API (${status}).`;
        console.error(`[API] HTTP ${status}: ${body.substring(0, 300)}`);

        // Special handling for billing/quota (402)
        if (status === 402) {
          console.error('[API] ⚠️ BILLING ISSUE — Anthropic account needs funding');
          if (job) job.progressMessage = '⚠️ Crédit API épuisé';
        }

        // Special handling for bad API key (401)
        if (status === 401) {
          console.error('[API] ⚠️ INVALID API KEY — check ANTHROPIC_API_KEY env var');
        }

        onError(new Error(friendlyMsg));
      });
      return;
    }

    onResponse(apiRes);
  });
  r.on('error', e => {
    if (retryCount < 2) {
      console.log(`[API] Network error, retrying in 5s: ${e.message}`);
      setTimeout(() => anthropicRequest(payload, opts, onResponse, onError, job, retryCount + 1), 5000);
    } else {
      onError(new Error('Erreur réseau. Vérifiez la connexion internet du serveur.'));
    }
  });
  r.setTimeout(CLAUDE_CODE_TIMEOUT_MS, () => {
    r.destroy();
    onError(new Error('Délai dépassé (5 min). Le brief est peut-être trop complexe — essayez en le simplifiant.'));
  });
  r.write(payload);
  r.end();
}

// ─── TOKEN USAGE TRACKING ───
// Pricing per million tokens (Claude Sonnet 4)
const TOKEN_PRICING = {
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'default': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 }
};

// Classify operation complexity for smart tracking
function classifyComplexity(operation, inputTokens, outputTokens) {
  const total = inputTokens + outputTokens;
  if (operation === 'chat') return 'chat';
  if (operation === 'auto-correct') return 'fix';
  if (operation === 'generate-plan') return 'plan';
  if (total < 5000) return 'simple';     // color change, text edit
  if (total < 20000) return 'moderate';   // add component, modify page
  if (total < 50000) return 'complex';    // full page, backend feature
  return 'heavy';                          // full project generation
}

function trackTokenUsage(userId, projectId, operation, model, usage) {
  if (!db || !usage) return;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  const pricing = TOKEN_PRICING[model] || TOKEN_PRICING['default'];
  const costUsd = (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cache_read +
    (cacheWrite / 1_000_000) * pricing.cache_write
  );
  const complexity = classifyComplexity(operation, inputTokens, outputTokens);

  try {
    db.prepare('INSERT INTO token_usage (user_id, project_id, operation, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userId || null, projectId || null, `${operation}:${complexity}`, model, inputTokens, outputTokens, cacheRead, cacheWrite, Math.round(costUsd * 100000) / 100000);
    console.log(`[Tokens] ${operation}:${complexity} ${inputTokens}in+${outputTokens}out=$${costUsd.toFixed(4)} (u:${userId} p:${projectId})`);
  } catch (e) {
    console.error('[Tokens] Track error:', e.message);
  }
}

// Check if user has exceeded their generation quota
function checkUserQuota(userId) {
  if (!db) return { allowed: true };
  const user = db.prepare('SELECT role, daily_generation_limit, monthly_generation_limit FROM users WHERE id=?').get(userId);
  if (!user) return { allowed: false, reason: 'Utilisateur non trouvé.' };
  if (user.role === 'admin') return { allowed: true }; // admin = illimité

  const dailyLimit = user.daily_generation_limit || 50;
  const monthlyLimit = user.monthly_generation_limit || 500;

  const todayCount = db.prepare("SELECT COUNT(*) as c FROM token_usage WHERE user_id=? AND operation LIKE 'generate%' AND created_at >= date('now')").get(userId)?.c || 0;
  const monthCount = db.prepare("SELECT COUNT(*) as c FROM token_usage WHERE user_id=? AND operation LIKE 'generate%' AND created_at >= date('now','start of month')").get(userId)?.c || 0;

  if (todayCount >= dailyLimit) {
    return { allowed: false, reason: `Limite quotidienne atteinte (${dailyLimit} générations/jour). Réessayez demain.`, daily: todayCount, dailyLimit };
  }
  if (monthCount >= monthlyLimit) {
    return { allowed: false, reason: `Limite mensuelle atteinte (${monthlyLimit} générations/mois). Contactez l'administrateur.`, monthly: monthCount, monthlyLimit };
  }
  return { allowed: true, daily: todayCount, dailyLimit, monthly: monthCount, monthlyLimit, remaining: dailyLimit - todayCount };
}

// Preview system constants
const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CODE_DISPLAY_LENGTH = 50000; // 50KB max for fallback code display

// ─── ERROR MANAGEMENT SYSTEM CONSTANTS ───
const MAX_AUTO_CORRECTION_ATTEMPTS = 3;
const CONTAINER_MONITORING_INTERVAL = 30000; // 30 seconds
const SLEEP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const containerLastAccess = new Map(); // projectId → timestamp
const ERROR_TYPES = {
  SYNTAX: 'syntax',
  DEPENDENCY: 'dependency',
  PORT: 'port',
  SQLITE: 'sqlite',
  MEMORY: 'memory',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown'
};

// ─── ABSOLUTE RULE FOR REACT PROJECTS ───
const ABSOLUTE_BROWSER_RULE = `RÈGLE ABSOLUE : Les projets générés utilisent React + Vite + TailwindCSS.
- Les fichiers .tsx contiennent des composants React fonctionnels
- Le styling se fait via TailwindCSS classes dans className
- Les icônes via lucide-react — JAMAIS de CDN
- Navigation via react-router-dom <Link> — JAMAIS window.location
- Le package.json doit être du JSON strict avec "type": "module"
- server.js sert dist/ en production après npm run build

`;

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
    clsx: "2.1.1",
    "tailwind-merge": "3.3.0",
    sonner: "2.0.3",
    cmdk: "1.1.1",
    "@radix-ui/react-dialog": "1.1.14",
    "@radix-ui/react-dropdown-menu": "2.1.15",
    "@radix-ui/react-tabs": "1.1.12",
    "@radix-ui/react-accordion": "1.2.11",
    "@radix-ui/react-tooltip": "1.1.18",
    "@radix-ui/react-popover": "1.1.14",
    "@radix-ui/react-checkbox": "1.1.8",
    "@radix-ui/react-switch": "1.1.7",
    "@radix-ui/react-radio-group": "1.2.7",
    "@radix-ui/react-slider": "1.2.7",
    "@radix-ui/react-progress": "1.1.7",
    "@radix-ui/react-collapsible": "1.1.7",
    "@radix-ui/react-scroll-area": "1.2.8",
    "@radix-ui/react-separator": "1.1.7",
    "@radix-ui/react-label": "2.1.7",
    "@radix-ui/react-avatar": "1.1.7",
    "@radix-ui/react-alert-dialog": "1.1.14",
    "@radix-ui/react-select": "2.1.14",
    express: "4.18.2",
    "better-sqlite3": "9.4.3",
    bcryptjs: "2.4.3",
    jsonwebtoken: "9.0.2",
    cors: "2.8.5",
    helmet: "7.1.0",
    compression: "1.7.4"
  },
  devDependencies: {
    vite: "6.3.5",
    "@vitejs/plugin-react": "4.5.2",
    tailwindcss: "4.1.7",
    "@tailwindcss/vite": "4.1.7"
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
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
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
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

const DEFAULT_INDEX_CSS = `@import "tailwindcss";

:root {
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-light: #dbeafe;
  --color-secondary: #64748b;
  --color-accent: #f59e0b;
  --color-background: #ffffff;
  --color-surface: #f8fafc;
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-border: #e2e8f0;
  --color-success: #16a34a;
  --color-error: #dc2626;
  --color-warning: #f59e0b;
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.07);
  --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
}

.dark {
  --color-primary: #3b82f6; --color-primary-hover: #60a5fa; --color-primary-light: #1e3a5f;
  --color-secondary: #94a3b8; --color-accent: #fbbf24;
  --color-background: #0f172a; --color-surface: #1e293b;
  --color-text: #f1f5f9; --color-text-muted: #94a3b8; --color-border: #334155;
  --color-success: #22c55e; --color-error: #ef4444; --color-warning: #fbbf24;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3); --shadow-md: 0 4px 6px rgba(0,0,0,0.4); --shadow-lg: 0 10px 15px rgba(0,0,0,0.5);
}

body { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: var(--color-text); background-color: var(--color-background); -webkit-font-smoothing: antialiased; }
@keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.animate-in { animation: fade-in 0.3s ease-out; }
html { scroll-behavior: smooth; }
*:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
`;

const DEFAULT_APP_JSX = `import React from 'react';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center p-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">Bienvenue</h1>
        <p className="text-lg text-gray-600 mb-8">Votre application React est en cours de construction.</p>
        <a href="/health" className="inline-block px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors">
          Vérifier le statut
        </a>
      </div>
    </div>
  );
}
`;

// In-memory tracking of auto-correction attempts per project
const correctionAttempts = new Map();

// In-memory tracking of projects being auto-corrected (to prevent concurrent corrections)
const correctionInProgress = new Set();

// Ensure previews directory exists
if (!fs.existsSync(PREVIEWS_DIR)) fs.mkdirSync(PREVIEWS_DIR, { recursive: true });

let compiler, ai;
try { compiler = require('./src/compiler'); } catch(e) {}
try { ai = require('./src/ai'); } catch(e) {}

// ─── DATABASE ───
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  // SQLite hardening — prevents corruption and concurrent access errors
  db.pragma('journal_mode = WAL');       // Write-Ahead Logging — safe concurrent reads + crash protection
  db.pragma('busy_timeout = 5000');      // Wait 5s if DB is locked instead of throwing SQLITE_BUSY
  db.pragma('synchronous = NORMAL');     // Good balance of safety vs performance with WAL
  db.pragma('foreign_keys = ON');        // Enforce foreign key constraints
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, name TEXT NOT NULL, role TEXT DEFAULT 'agent', lang TEXT DEFAULT 'fr', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT, client_name TEXT, project_type TEXT, brief TEXT, generated_code TEXT, status TEXT DEFAULT 'draft', is_published INTEGER DEFAULT 0, subdomain TEXT, domain TEXT, apis TEXT, notes TEXT, build_id TEXT, build_status TEXT DEFAULT 'none', build_url TEXT, version INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS project_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, service TEXT NOT NULL, key_value TEXT NOT NULL, description TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS project_api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, env_name TEXT NOT NULL, env_value TEXT NOT NULL, service TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS github_config (id INTEGER PRIMARY KEY, github_token TEXT NOT NULL, github_username TEXT NOT NULL, github_org TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT, type TEXT DEFAULT 'info', read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, project_id INTEGER, status TEXT DEFAULT 'building', progress INTEGER DEFAULT 0, message TEXT, url TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS analytics (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, event_type TEXT NOT NULL, event_data TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS project_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version_number INTEGER NOT NULL, generated_code TEXT, screenshot_url TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), message TEXT, FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS error_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, error_type TEXT NOT NULL, error_message TEXT, docker_logs TEXT, correction_attempt INTEGER DEFAULT 1, corrected INTEGER DEFAULT 0, corrected_code TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, project_id INTEGER, operation TEXT NOT NULL, model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, owner_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(owner_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS workspace_members (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT DEFAULT 'editor', invited_by INTEGER, joined_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(user_id) REFERENCES users(id), UNIQUE(workspace_id, user_id));
  `);
  const bcrypt = require('bcryptjs');
  const ADMIN_EMAIL = 'admin@prestige-build.dev';
  const ADMIN_PASSWORD = 'Prestige2026!';
  const adminExists = db.prepare("SELECT id FROM users WHERE email=?").get(ADMIN_EMAIL);
  if (!adminExists) {
    db.prepare('INSERT INTO users (email,password,name,role) VALUES (?,?,?,?)').run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 12), 'Administrateur', 'admin');
    console.log(`[DB] Admin account created: ${ADMIN_EMAIL}`);
  } else {
    // Always sync admin password on startup to prevent desync after redeploy
    db.prepare('UPDATE users SET password=? WHERE email=?').run(bcrypt.hashSync(ADMIN_PASSWORD, 12), ADMIN_EMAIL);
  }
  // Log all users on startup (never touch agent passwords — they persist in the volume)
  const allUsers = db.prepare('SELECT id, email, role FROM users').all();
  console.log(`[DB] ${allUsers.length} user(s): ${allUsers.map(u => u.email + ' (' + u.role + ')').join(', ')}`);
} catch(e) { console.error('DB:', e.message); }

// Add missing columns (safe — ALTER TABLE errors silently if column exists)
try { db.exec('ALTER TABLE projects ADD COLUMN github_repo TEXT'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN daily_generation_limit INTEGER DEFAULT 50'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN monthly_generation_limit INTEGER DEFAULT 500'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE projects ADD COLUMN workspace_id INTEGER'); } catch(e) { /* already exists */ }

// ─── #2 DATABASE INDEXES (performance on frequent queries) ───
try { db.exec(`
  CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
  CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_project_messages_project ON project_messages(project_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_project_type ON analytics(project_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics(created_at);
  CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(project_id);
  CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
  CREATE INDEX IF NOT EXISTS idx_error_history_project ON error_history(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_versions_project ON project_versions(project_id);
`); console.log('[DB] Indexes created/verified'); } catch(e) { console.warn('[DB] Index creation:', e.message); }

// ─── #5 ANALYTICS RETENTION (cleanup old data > 90 days) ───
try {
  const deleted = db.prepare("DELETE FROM analytics WHERE created_at < datetime('now', '-90 days')").run();
  if (deleted.changes > 0) console.log(`[DB] Cleaned ${deleted.changes} analytics records older than 90 days`);
} catch(e) { /* ignore */ }

// ─── SSE CLIENTS FOR REAL-TIME COLLABORATION ───
const projectSSEClients = new Map(); // Map<projectId, Set<{res, userId, userName, connectedAt}>>
const MAX_COLLABORATORS_PER_PROJECT = 20;

// ─── JOBS MAP FOR POLLING-BASED GENERATION ───
const generationJobs = new Map(); // Map<job_id, {status, code, error, progress, project_id, user_id}>

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

// ─── PATH VALIDATION HELPER ───
function isPathSafe(basePath, targetPath) {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

// ─── JSON VALIDATION HELPER ───
function isValidJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    JSON.parse(content);
    return true;
  } catch { return false; }
}

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

// ─── AUTH ───
function signToken(p) {
  const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const b=Buffer.from(JSON.stringify({...p,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url'); // 24h expiry
  const s=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}
function verifyToken(t) {
  if(!t) return null;
  try {
    const [h,b,s]=t.split('.');
    if(crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url')!==s) return null;
    const p=JSON.parse(Buffer.from(b,'base64url').toString());
    return p.exp<Math.floor(Date.now()/1000)?null:p;
  } catch{return null;}
}
function getAuth(req) {
  // Check Authorization header first
  const headerToken = (req.headers['authorization']||'').replace('Bearer ','');
  // #8 Check token blacklist (logout)
  if (headerToken && global._tokenBlacklist?.has(headerToken)) return null;
  if (headerToken) return verifyToken(headerToken);
  // Check query string (for SSE and initial iframe load)
  const urlParts = req.url.split('?');
  if (urlParts.length > 1) {
    const params = new URLSearchParams(urlParts[1]);
    const queryToken = params.get('token');
    if (queryToken) return verifyToken(queryToken);
  }
  // Check cookie (for iframe sub-requests: CSS, JS, fetch, images)
  const cookies = req.headers.cookie || '';
  const cookieMatch = cookies.match(/(?:^|;\s*)pbp_token=([^;]+)/);
  if (cookieMatch) return verifyToken(cookieMatch[1]);
  return null;
}
function json(res,code,data) { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); }
function cors(res) {
  // Allow only our own domain + localhost for development
  const allowedOrigins = process.env.CORS_ORIGIN || 'https://app.prestige-build.dev';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins);
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}
function getBody(req, maxSize = 5 * 1024 * 1024) {
  return new Promise(r => {
    let b = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxSize) { req.destroy(); r({}); return; }
      b += c;
    });
    req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } });
    req.on('error', () => r({}));
  });
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

## server.js — Backend Express

- Port 3000, route /health
- Sert dist/ : app.use(express.static(path.join(__dirname, 'dist')))
- SQLite : tables selon le secteur avec données de démo
- JWT auth, compte admin basé sur le nom du projet
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
- Images via picsum.photos
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
`;
}

// ─── REACT PROJECT FILE HELPERS ───

// Read all valid project files recursively from a directory
function readProjectFilesRecursive(projectDir) {
  const files = {};
  const validNames = [
    'package.json', 'vite.config.js', 'index.html', 'server.js',
  ];
  const validDirs = ['src/components', 'src/components/ui', 'src/pages', 'src/styles', 'src/lib', 'src/hooks', 'src/context'];
  const validSrcFiles = ['src/main.tsx', 'src/index.css', 'src/App.tsx'];

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

  // Read src/ files
  for (const name of validSrcFiles) {
    const p = path.join(projectDir, name);
    if (fs.existsSync(p)) {
      files[name] = fs.readFileSync(p, 'utf8');
    }
  }

  // Read src/components/, src/pages/, etc.
  for (const dir of validDirs) {
    const dirPath = path.join(projectDir, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        if (entry.endsWith('.tsx') || entry.endsWith('.ts') || entry.endsWith('.jsx') || entry.endsWith('.js') || entry.endsWith('.css')) {
          const relativePath = `${dir}/${entry}`;
          const fullPath = path.join(dirPath, entry);
          if (fs.statSync(fullPath).isFile()) {
            files[relativePath] = fs.readFileSync(fullPath, 'utf8');
          }
        }
      }
    }
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
      fs.writeFileSync(filePath, content);
      console.log(`[Defaults] Wrote default ${filename}`);
    }
  }

  // Copy UI component library (shadcn-style) from templates
  const templateUiDir = path.join(__dirname, 'templates', 'react', 'src');
  const uiDirs = ['components/ui', 'lib', 'hooks'];
  for (const dir of uiDirs) {
    const srcDir = path.join(templateUiDir, dir);
    const destDir = path.join(projectDir, 'src', dir);
    if (fs.existsSync(srcDir)) {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const destFile = path.join(destDir, file);
        // ALWAYS overwrite UI components with our canonical versions
        // The AI might generate broken versions — ours are guaranteed to work
        fs.copyFileSync(path.join(srcDir, file), destFile);
        console.log(`[Defaults] Wrote canonical UI: src/${dir}/${file}`);
      }
    }
  }
}

// ─── CLAUDE CODE PROCESS MANAGER ───
// Track active Claude Code processes per project
const claudeCodeProcesses = new Map();

// Timeout for Claude Code generation (5 minutes)
const CLAUDE_CODE_TIMEOUT_MS = 5 * 60 * 1000;

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
    job.error = 'Clé API non configurée sur le serveur.';
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
    job.error = 'Clé API non configurée sur le serveur.';
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
    description: 'Create or overwrite a file in the project. Use for new files or when most of the file changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root (e.g. src/components/Header.tsx)' },
        content: { type: 'string', description: 'Complete file content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Make a surgical edit to an existing file. Use for small changes (color, text, fix). More efficient than rewriting the whole file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        search: { type: 'string', description: 'Exact text to find (must match existing code exactly)' },
        replace: { type: 'string', description: 'Text to replace it with' }
      },
      required: ['path', 'search', 'replace']
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
  }
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
    if (PROTECTED_FILES.has(toolInput.path) || toolInput.path.startsWith('src/components/ui/') || toolInput.path.startsWith('src/lib/') || toolInput.path.startsWith('src/hooks/')) {
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

  if (toolName === 'enable_stripe' && toolInput.project_id && db) {
    const keyName = toolInput.stripe_key_name || 'STRIPE_SECRET_KEY';
    try {
      const existing = db.prepare('SELECT id FROM project_api_keys WHERE project_id=? AND env_name=?').get(toolInput.project_id, keyName);
      if (existing) return Promise.resolve(`Stripe déjà configuré (${keyName}). Utilisez l'interface admin pour modifier la clé.`);
      db.prepare('INSERT INTO project_api_keys (project_id, env_name, env_value, service) VALUES (?,?,?,?)').run(toolInput.project_id, keyName, encryptValue('CONFIGURE_VIA_ADMIN_PANEL'), 'stripe');
      return Promise.resolve(`Stripe activé. Variable ${keyName} créée. L'admin doit configurer la clé via l'interface admin. Utilise process.env.${keyName} dans server.js.`);
    } catch (e) { return Promise.resolve(`Erreur: ${e.message}`); }
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
        // Block writes to canonical files — server controls these
        if (PROTECTED_FILES.has(block.input.path) || block.input.path.startsWith('src/components/ui/') || block.input.path.startsWith('src/lib/') || block.input.path.startsWith('src/hooks/')) {
          console.log(`[Tool] Blocked write to canonical file: ${block.input.path}`);
        } else {
          const cleanContent = cleanGeneratedContent(block.input.content);
          if (cleanContent) { result.files[block.input.path] = cleanContent; }
        }
      } else if (block.name === 'edit_file' && block.input?.path && block.input?.search) {
        result.edits.push({
          path: block.input.path,
          search: block.input.search,
          replace: block.input.replace || ''
        });
      } else if (['fetch_website', 'read_console_logs', 'run_security_check', 'parse_document', 'generate_mermaid', 'view_file', 'search_files', 'delete_file', 'rename_file', 'add_dependency', 'remove_dependency', 'download_to_project', 'read_project_analytics', 'get_table_schema', 'enable_stripe', 'search_images'].includes(block.name)) {
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
function applyToolEdits(projectDir, edits) {
  let applied = 0;
  for (const edit of edits) {
    const filePath = path.join(projectDir, edit.path);
    if (!fs.existsSync(filePath)) {
      console.warn(`[ToolEdit] File not found: ${edit.path}`);
      continue;
    }
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(edit.search)) {
      content = content.replace(edit.search, edit.replace);
      fs.writeFileSync(filePath, content);
      applied++;
      console.log(`[ToolEdit] Applied edit to ${edit.path}`);
    } else {
      // Fuzzy match: trim whitespace
      const trimSearch = edit.search.trim();
      if (trimSearch && content.includes(trimSearch)) {
        content = content.replace(trimSearch, edit.replace.trim());
        fs.writeFileSync(filePath, content);
        applied++;
        console.log(`[ToolEdit] Applied fuzzy edit to ${edit.path}`);
      } else {
        console.warn(`[ToolEdit] Search text not found in ${edit.path}: "${edit.search.substring(0, 50)}..."`);
      }
    }
  }
  return applied;
}

// opts.useTools: if true, pass CODE_TOOLS and return parsed tool response
// opts.rawResponse: if true, return the full API response object instead of text
function callClaudeAPI(systemBlocks, messages, maxTokens = 16000, trackingInfo = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const model = 'claude-sonnet-4-20250514';
    const apiPayload = { model, max_tokens: maxTokens, system: systemBlocks, messages };
    if (opts.useTools) {
      apiPayload.tools = CODE_TOOLS;
      apiPayload.tool_choice = { type: 'auto' }; // let Claude decide when to use tools
    }
    const payload = JSON.stringify(apiPayload);
    const reqOpts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
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

            // Execute server-side tools (fetch_website, read_console_logs, security_check)
            // and return results to Claude in a follow-up call if needed
            if (serverCalls > 0 && (opts._depth || 0) < 5) {
              (async () => {
                try {
                  const toolResults = [];
                  // Inject project directory for file-based tools
                  const projDir = trackingInfo?.projectId ? path.join(DOCKER_PROJECTS_DIR, String(trackingInfo.projectId)) : null;
                  for (const tc of parsed.serverToolCalls) {
                    const input = { ...tc.input };
                    if (projDir) input._projectDir = projDir;
                    if (trackingInfo?.projectId) input.project_id = input.project_id || trackingInfo.projectId;
                    const result = await executeServerTool(tc.name, input);
                    toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result || 'OK' });
                    console.log(`[ServerTool] ${tc.name}: ${(result || '').substring(0, 100)}`);
                  }
                  // Continue conversation with tool results (all in one user message per Anthropic API spec)
                  const followUp = await callClaudeAPI(systemBlocks, [
                    ...messages,
                    { role: 'assistant', content: r.content },
                    { role: 'user', content: toolResults }
                  ], maxTokens, trackingInfo, { ...opts, _depth: (opts._depth || 0) + 1 });
                  resolve(followUp);
                } catch (e) {
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

function generateViaAPI(projectId, brief, jobId) {
  const job = generationJobs.get(jobId);
  if (!job) return;

  if (!ANTHROPIC_API_KEY) {
    job.status = 'error';
    job.error = 'Clé API Anthropic non configurée (ANTHROPIC_API_KEY).';
    return;
  }

  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  const srcDirApi = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDirApi)) fs.mkdirSync(srcDirApi, { recursive: true });

  job.status = 'running';
  job.progressMessage = 'Analyse du brief...';
  console.log(`[MultiTurn] Starting multi-turn generation for project ${projectId}`);

  const sectorProfile = ai && brief ? ai.detectSectorProfile(brief) : null;
  const baseSystemPrompt = ai ? ai.SYSTEM_PROMPT : 'Tu es un expert en développement professionnel.';

  // Cached system prompt blocks (reused across all turns)
  const systemBlocks = [
    { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } }
  ];
  if (sectorProfile) {
    systemBlocks.push({ type: 'text', text: sectorProfile });
  }

  // ─── MULTI-TURN GENERATION ───
  // Phase 1: Plan (file list) → Phase 2: Infrastructure → Phase 3: Components+Pages
  // Each phase builds on the previous, preventing truncation
  generateMultiTurn(projectId, brief, jobId, job, projectDir, systemBlocks).catch(err => {
    console.error(`[MultiTurn] Fatal error: ${err.message}`);
    if (job.status === 'running') {
      job.status = 'error';
      job.error = `Erreur de génération: ${err.message}`;
    }
  });
}

async function generateMultiTurn(projectId, brief, jobId, job, projectDir, systemBlocks) {
  let allCode = '';
  const tracking = { userId: job.user_id, projectId };
  const startTime = Date.now();
  const sectorProfile = ai ? ai.detectSectorProfile(brief) : null;

  // Helper: save partial code to DB after each successful phase
  function savePartialToDb() {
    try {
      if (allCode.length > 0 && job.project_id) {
        db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready' WHERE id=?").run(allCode, job.project_id);
      }
    } catch (e) { console.error('[Gen] DB save error:', e.message); }
  }

  // ── CONTAINER CHECK — don't block, just check if it's ready ──
  // Container was launched async by POST /api/projects.
  // If not ready yet, generation proceeds anyway — files are written to disk.
  // autoCompile/hot-reload after generation handles pushing to container.
  const containerRunning = await isContainerRunningAsync(projectId);
  if (containerRunning) {
    console.log(`[Gen] Container already running for project ${projectId}`);
  } else {
    console.log(`[Gen] Container not ready yet for project ${projectId} — generation proceeds, files written to disk`);
    // Launch container in background — don't wait
    launchTemplateContainer(projectId).then(r => {
      if (r.success) console.log(`[Gen] Container started mid-generation for project ${projectId}`);
      else console.warn(`[Gen] Container failed for project ${projectId}: ${r.error}`);
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
### server.js — Express complet: tables SQLite adaptées au brief, routes API CRUD, auth JWT, bcrypt, /health, sert dist/. Ordre: static → public routes → auth → protected /api → SPA fallback. FIN: // CREDENTIALS: email=admin@project.com password=[fort]
### src/index.css — @import "tailwindcss"; puis :root { --color-primary: [couleur secteur]; --color-primary-hover; --color-secondary; --color-accent; --color-background: #ffffff; --color-surface; --color-text; --color-text-muted; --color-border; }

Code COMPLET et fonctionnel. Pas de placeholder.`;

  try {
    const infraCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: infraPrompt }], 24000, { ...tracking, operation: 'generate' }, { useTools: true });
    allCode = infraCode;
    writeGeneratedFiles(projectDir, infraCode);
    // Push to running container — Vite HMR updates preview in real-time
    try { await writeFilesToContainer(projectId, infraCode); } catch(e) { console.warn(`[Gen] Container push failed (will retry at finalize): ${e.message}`); }
    job.code = allCode;
    job.progress = allCode.length;
    savePartialToDb();
    console.log(`[Gen] Phase 1 OK: ${infraCode.length} chars (${((Date.now()-startTime)/1000).toFixed(0)}s)`);
  } catch (e) {
    console.error(`[Gen] Phase 1 failed: ${e.message}`);
    job.status = 'error';
    job.error = `Erreur infrastructure: ${e.message}`;
    return;
  }

  // ── PHASE 2+3 IN PARALLEL: Pages + Components at the same time ──
  job.progressMessage = 'Génération des pages et composants...';
  const phase2Start = Date.now();
  console.log(`[Gen] Phase 2+3: Pages + Components IN PARALLEL`);

  const pagesPrompt = `Génère App.jsx et les pages React.

Brief: ${brief}

Génère ces fichiers avec ### markers :
### src/App.tsx — import BrowserRouter,Routes,Route. Import Header,Footer,Home,About,Contact (ou pages adaptées au brief). Layout: <Header/> + <Routes> + <Footer/>
### src/pages/Home.tsx — page d'accueil COMPLÈTE: hero section, sections principales, contenu réaliste en français, fetch('/api/...') pour données dynamiques
### src/pages/About.tsx — page à propos, histoire, équipe, valeurs
### src/pages/Contact.tsx — formulaire contact complet avec validation useState, carte/adresse

Chaque fichier : export default function, TailwindCSS classes, lucide-react icônes, responsive.
Contenu PRO français, zéro lorem ipsum. Images: picsum.photos.`;

  const compsPrompt = `Génère les composants React réutilisables.

Brief: ${brief}

Génère ces fichiers avec ### markers :
### src/components/Header.tsx — header sticky responsive, logo, nav desktop + menu hamburger mobile (useState), liens: Accueil, À propos, Contact
### src/components/Footer.tsx — footer professionnel, copyright 2024, liens rapides, coordonnées
### src/components/HeroSection.tsx — hero plein écran, titre accrocheur, sous-titre, CTA button, image de fond picsum.photos

Chaque composant : export default function, TailwindCSS, lucide-react. Design pro, responsive.`;

  // Launch BOTH in parallel — they don't depend on each other
  const [pagesResult, compsResult] = await Promise.allSettled([
    callClaudeAPI(systemBlocks, [{ role: 'user', content: pagesPrompt }], 24000, { ...tracking, operation: 'generate' }, { useTools: true }),
    callClaudeAPI(systemBlocks, [{ role: 'user', content: compsPrompt }], 12000, { ...tracking, operation: 'generate' }, { useTools: true })
  ]);

  // Merge pages result
  if (pagesResult.status === 'fulfilled') {
    allCode = mergeModifiedCode(allCode, pagesResult.value);
    writeGeneratedFiles(projectDir, pagesResult.value);
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
    writeGeneratedFiles(projectDir, compsResult.value);
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
      writeGeneratedFiles(projectDir, fixCode);
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

  // ── Vite build check (like Lovable: catch errors BEFORE deploying) ──
  // Run a test build to detect import errors, syntax errors, type errors
  // If it fails, send the EXACT Vite error to Claude for correction
  const viteBuildResult = testViteBuild(projectDir);
  if (!viteBuildResult.success && viteBuildResult.error) {
    job.progressMessage = 'Correction d\'erreurs de build...';
    console.log(`[Gen] Vite build failed: ${viteBuildResult.error.substring(0, 200)}`);

    // Send the exact Vite error to Claude for auto-fix (free, no quota)
    try {
      const fixPrompt = `Le build Vite a échoué avec cette erreur :

${viteBuildResult.error.substring(0, 2000)}

Corrige le(s) fichier(s) en cause. Utilise les outils write_file/edit_file.
Règle : imports avec @/ alias, fichiers UI en lowercase, TypeScript valide.`;

      const fixCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: fixPrompt }], 16000,
        { ...tracking, operation: 'auto-correct' }, { useTools: true });
      if (fixCode) {
        allCode = mergeModifiedCode(allCode, fixCode);
        writeGeneratedFiles(projectDir, fixCode);
        savePartialToDb();
        console.log(`[Gen] Vite build error auto-fixed`);

        // Re-test after fix
        const retest = testViteBuild(projectDir);
        if (retest.success) console.log(`[Gen] Vite build OK after fix`);
        else console.warn(`[Gen] Vite build still failing: ${retest.error?.substring(0, 100)}`);
      }
    } catch (fixErr) {
      console.warn(`[Gen] Auto-fix failed: ${fixErr.message}`);
    }
  } else {
    console.log(`[Gen] Vite build check: OK`);
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
  // Delete files that shouldn't exist (postcss.config.js, tailwind.config.js — TailwindCSS 4 doesn't need them)
  for (const junk of ['postcss.config.js', 'postcss.config.cjs', 'tailwind.config.js', 'tailwind.config.ts', 'vite.config.ts']) {
    const jp = path.join(projectDir, junk);
    if (fs.existsSync(jp)) { fs.unlinkSync(jp); console.log(`[Gen] Removed unnecessary: ${junk}`); }
  }
  console.log(`[Gen] Canonical files written`);

  // Write UI component library + utils + hooks
  writeDefaultReactProject(projectDir);

  // Auto-fix relative imports in all generated files
  validateJsxFiles(projectDir);

  // Push ALL final files to running container
  // If container isn't running yet, launch it now (generation took 30-60s, more than enough)
  if (!(await isContainerRunningAsync(projectId))) {
    console.log(`[Gen] Container not running at finalize — launching now`);
    try { await launchTemplateContainer(projectId); } catch(e) { console.error(`[Gen] Container launch at finalize: ${e.message}`); }
  }
  try {
    const containerName = getContainerName(projectId);
    const { execSync } = require('child_process');
    // Push src/ (all components, pages, styles)
    execSync(`docker cp ${projectDir}/src/. ${containerName}:/app/src/`, { timeout: 15000 });
    // Push index.html (may have custom title)
    if (fs.existsSync(path.join(projectDir, 'index.html'))) {
      execSync(`docker cp ${projectDir}/index.html ${containerName}:/app/index.html`, { timeout: 10000 });
    }
    // Push server.js if syntax-valid, then restart Express
    if (fs.existsSync(path.join(projectDir, 'server.js'))) {
      const { spawnSync } = require('child_process');
      if (spawnSync('node', ['--check', path.join(projectDir, 'server.js')], { timeout: 5000 }).status === 0) {
        execSync(`docker cp ${projectDir}/server.js ${containerName}:/app/server.js`, { timeout: 10000 });
        // Restart Express to pick up new routes/tables
        try {
          execSync(`docker exec ${containerName} sh -c 'kill $(cat /tmp/express.pid 2>/dev/null) 2>/dev/null; node server.js & echo $! > /tmp/express.pid'`, { timeout: 10000 });
        } catch {}
      }
    }
    console.log(`[Gen] Final files pushed to container`);
  } catch(e) { console.warn(`[Gen] Final container push: ${e.message}`); }

  // Read final state from disk and save to DB
  const finalFiles = readProjectFilesRecursive(projectDir);
  allCode = formatProjectCode(finalFiles);
  job.code = allCode;
  savePartialToDb();

  // Mark build as done (no separate compile step needed)
  db.prepare("UPDATE projects SET build_status='done',build_url=?,status='ready' WHERE id=?").run(`/run/${projectId}/`, projectId);

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
    writeGeneratedFiles(projDir, code);

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
  'package.json', 'vite.config.js', 'tsconfig.json', 'index.html', 'src/main.tsx'
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

function writeGeneratedFiles(projectDir, code) {
  const sections = code.split(/^### /m).filter(s => s.trim());
  let filesWritten = 0;
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

    // Skip canonical files — server controls these, not the AI
    if (PROTECTED_FILES.has(filename)) {
      console.log(`[WriteFiles] Skipping canonical file: ${filename}`);
      continue;
    }
    // Skip canonical UI component templates — our versions are always used
    // But ALLOW custom files in src/lib/ and src/hooks/ (e.g., src/lib/api.ts, src/hooks/useAuth.ts)
    const CANONICAL_LIB_FILES = new Set(['src/lib/utils.ts', 'src/hooks/useToast.ts', 'src/hooks/useIsMobile.ts']);
    if (filename.startsWith('src/components/ui/') || CANONICAL_LIB_FILES.has(filename)) {
      console.log(`[WriteFiles] Skipping canonical template: ${filename}`);
      continue;
    }
    // Only write valid project files
    if (!isValidProjectFile(filename)) {
      console.log(`[WriteFiles] Skipping invalid file: ${filename}`);
      continue;
    }

    // Clean Claude artifacts from file content before writing
    content = cleanGeneratedContent(content);
    if (!content) continue;

    const filePath = path.join(projectDir, filename);
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(filePath, content);
    filesWritten++;
    console.log(`[WriteFiles] Wrote ${filename} (${content.length} bytes)`);
  }
  console.log(`[WriteFiles] Total: ${filesWritten} files written`);
}

// ─── LEGACY GENERATE CLAUDE (KEPT FOR SMALL OPERATIONS) ───
function generateClaude(messages, jobId, brief, options = {}) {
  const job = generationJobs.get(jobId);
  if (!job) return;

  // Route: NEW projects go through multi-turn generation, MODIFICATIONS go through streaming API
  if (job.project_id) {
    // Check if the project has ALREADY been generated (has real code in DB)
    // launchTemplateContainer writes default files to disk, so we can't use fs.existsSync
    const existingProject = db.prepare('SELECT generated_code, status FROM projects WHERE id=?').get(job.project_id);
    const hasGeneratedCode = existingProject?.generated_code && existingProject.generated_code.length > 500;
    const isModification = hasGeneratedCode && existingProject.status === 'ready';

    if (isModification) {
      // Modifications: streaming API with full code context + CHAT_SYSTEM_PROMPT
      console.log(`[generateClaude] Modification for project ${job.project_id} — using streaming API`);
      // Don't return here — fall through to the API streaming path below
    } else {
      // NEW generation: multi-turn pipeline (infra → pages → components)
      console.log(`[generateClaude] New generation for project ${job.project_id} — using multi-turn pipeline`);
      const effectiveBrief = brief || (messages[messages.length - 1]?.content || '');
      generateViaAPI(job.project_id, effectiveBrief, jobId);
      return;
    }
  }

  // For non-project operations, fall back to API (kept for compatibility)
  if (!ANTHROPIC_API_KEY) { 
    job.status = 'error';
    job.error = 'Clé API non configurée sur le serveur.';
    return; 
  }
  
  // Use CHAT prompt for modifications (existing code), SYSTEM prompt for new generation
  const isModificationChat = messages.length > 2;
  const baseSystemPrompt = ai
    ? (isModificationChat ? (ABSOLUTE_BROWSER_RULE + ai.CHAT_SYSTEM_PROMPT) : (ABSOLUTE_BROWSER_RULE + ai.SYSTEM_PROMPT))
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
- Utilise https://picsum.photos/WIDTH/HEIGHT pour les images placeholder (ex: https://picsum.photos/800/600)

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

  // For modifications: always Sonnet (smarter for surgical edits). For new gen: based on complexity.
  const maxTokens = ai && ai.getMaxTokensForProject ? ai.getMaxTokensForProject(brief) : 16000;
  const model = 'claude-sonnet-4-20250514';
  console.log(`[Claude API Generate] model: ${model}, max_tokens: ${maxTokens}, job: ${jobId}`);

  job.status = 'running';
  job.progressMessage = 'Prestige AI travaille sur votre demande...';

  const apiPayload = { model, max_tokens: maxTokens, system: systemBlocks, stream: true, messages,
    tools: [...CODE_TOOLS, { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    tool_choice: { type: 'auto' }
  };
  const payload = JSON.stringify(apiPayload);
  const opts = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31,web-search-2025-03-05','Content-Length':Buffer.byteLength(payload)} };
  
  anthropicRequest(payload, opts, (apiRes) => {
    let buffer = '';
    // Track tool_use blocks accumulated during streaming
    const toolBlocks = []; // { name, id, input_json }
    let currentToolId = null;
    let currentToolName = null;
    let currentToolJson = '';

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

          // Text deltas (regular content / fallback ### markers)
          if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && d.delta?.text) {
            job.code += d.delta.text;
            job.progress = job.code.length;
          }

          // Tool use start — begin accumulating input JSON
          if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
            currentToolId = d.content_block.id;
            currentToolName = d.content_block.name;
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
            try {
              const input = JSON.parse(currentToolJson);
              toolBlocks.push({ name: currentToolName, id: currentToolId, input });

              // REAL-TIME: Write file to container IMMEDIATELY as each tool call completes
              // This makes the preview update progressively (like Lovable)
              if (currentToolName === 'write_file' && input.path && input.content && job.project_id) {
                job.progressMessage = `${input.path}`;
                const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
                const cleanContent = cleanGeneratedContent(input.content);
                // Skip canonical files
                const CANONICAL_TEMPLATES = new Set(['src/lib/utils.ts', 'src/hooks/useToast.ts', 'src/hooks/useIsMobile.ts']);
                if (!PROTECTED_FILES.has(input.path) && !input.path.startsWith('src/components/ui/') && !CANONICAL_TEMPLATES.has(input.path) && cleanContent) {
                  // Write to disk (for persistence/DB)
                  const filePath = path.join(projDir, input.path);
                  const fileDir = path.dirname(filePath);
                  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
                  fs.writeFileSync(filePath, cleanContent);
                  // Push to frontend via SSE → WebContainer picks it up via Vite HMR
                  notifyProjectClients(job.project_id, 'file_written', { path: input.path, content: cleanContent });
                  console.log(`[Stream] SSE push: ${input.path}`);
                  // Also try Docker container (fallback for non-WebContainer clients)
                  try {
                    const containerName = getContainerName(job.project_id);
                    execSync(`docker cp ${filePath} ${containerName}:/app/${input.path}`, { timeout: 5000 });
                  } catch { /* container might not be ready */ }
                }
              } else if (currentToolName === 'edit_file' && input.path && input.search && job.project_id) {
                job.progressMessage = `Modifie: ${input.path}`;
                // Apply edit immediately
                const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
                const filePath = path.join(projDir, input.path);
                if (fs.existsSync(filePath)) {
                  let content = fs.readFileSync(filePath, 'utf8');
                  if (content.includes(input.search)) {
                    content = content.replace(input.search, input.replace || '');
                    fs.writeFileSync(filePath, content);
                    // Push edit to frontend via SSE → WebContainer
                    notifyProjectClients(job.project_id, 'file_edited', { path: input.path, search: input.search, replace: input.replace || '' });
                    console.log(`[Stream] SSE edit: ${input.path}`);
                    // Also try Docker container (fallback)
                    try {
                      const containerName = getContainerName(job.project_id);
                      execSync(`docker cp ${filePath} ${containerName}:/app/${input.path}`, { timeout: 5000 });
                    } catch {}
                  }
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
            job.progressMessage = 'Recherche web en cours...';
          }
          if (d.type === 'content_block_start' && d.content_block?.type === 'text') {
            job.progressMessage = 'Prestige AI rédige le code...';
          }
          if (d.type === 'message_stop') {
            job._messageComplete = true;
          }
          if (d.type === 'error') {
            console.error('[Claude API] Stream error:', JSON.stringify(d.error));
            job.status = 'error';
            job.error = d.error?.message || 'Erreur API';
          }
        } catch(e) {
          if (data && data.length > 10) console.warn(`[Claude API] Malformed SSE: ${data.substring(0, 80)}`);
        }
      }
    });
    apiRes.on('error', e => { job.status = 'error'; job.error = e.message; });
    apiRes.on('end', async () => {
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
          applyToolEdits(projDir, parsed.edits);
          // Also update the code in memory with the edit results
          if (job.project_id) {
            const existingCode = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(job.project_id);
            if (existingCode?.generated_code) {
              // Re-read files from disk after edits applied
              const updatedFiles = readProjectFilesRecursive(projDir);
              job.code = formatProjectCode(updatedFiles);
            }
          }
        }
        // Write tool files to disk
        if (Object.keys(parsed.files).length > 0 && job.project_id) {
          writeGeneratedFiles(path.join(DOCKER_PROJECTS_DIR, String(job.project_id)), toolCode);
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
          // Validate and auto-fix syntax (like Lovable)
          if (job.project_id) {
            job.progressMessage = 'Vérification du code...';
            job.code = await validateAndFixCode(job.project_id, job.code);
          }
        } catch (e) { console.error('[Claude API] Post-process error:', e.message); }

        // CRITICAL: Push final processed files to running container
        // During streaming, raw files were pushed. But post-processing (auto-fix, validate)
        // may have changed them on disk. Push the FINAL versions now.
        if (job.project_id) {
          try {
            const projDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
            const containerName = getContainerName(job.project_id);
            // Auto-fix relative imports before final push
            validateJsxFiles(projDir);
            // Push all src files
            if (fs.existsSync(path.join(projDir, 'src'))) {
              execSync(`docker cp ${projDir}/src/. ${containerName}:/app/src/`, { timeout: 15000 });
            }
            // Push index.html (may have custom title or meta tags)
            if (fs.existsSync(path.join(projDir, 'index.html'))) {
              execSync(`docker cp ${projDir}/index.html ${containerName}:/app/index.html`, { timeout: 10000 });
            }
            // Push server.js if valid
            if (fs.existsSync(path.join(projDir, 'server.js'))) {
              const { spawnSync } = require('child_process');
              if (spawnSync('node', ['--check', path.join(projDir, 'server.js')], { timeout: 5000 }).status === 0) {
                execSync(`docker cp ${projDir}/server.js ${containerName}:/app/server.js`, { timeout: 10000 });
              }
            }
            // Update DB with final code
            const finalFiles = readProjectFilesRecursive(projDir);
            const finalCode = formatProjectCode(finalFiles);
            db.prepare("UPDATE projects SET generated_code=?,build_status='done',build_url=?,status='ready',updated_at=datetime('now') WHERE id=?")
              .run(finalCode, `/run/${job.project_id}/`, job.project_id);
            job.code = finalCode;
            console.log(`[Stream] Final files pushed to container ${containerName}`);
          } catch (pushErr) {
            console.warn(`[Stream] Final container push failed: ${pushErr.message}`);
          }
        }

        job.status = 'done';
      } else if (job.status === 'running') {
        job.status = 'error';
        job.error = 'La génération n\'a produit aucun résultat. Réessayez.';
      }
    });
  }, (e) => {
    job.status = 'error';
    job.error = e.message;
  }, job);
}

// ─── GENERATE CLAUDE WITH IMAGE (NON-STREAMING, FOR POLLING) ───
// ─── GENERATE CLAUDE CODE FROM IMAGE ───
function generateClaudeWithImage(imageBase64, mediaType, prompt, jobId) {
  const job = generationJobs.get(jobId);
  if (!job) return;
  
  if (!ANTHROPIC_API_KEY) { 
    job.status = 'error';
    job.error = 'Clé API non configurée sur le serveur.';
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

## Instructions de reproduction
1. Analyse la structure visuelle : header, sections, footer, disposition des éléments
2. Identifie la palette de couleurs et les traduis en classes Tailwind
3. Reproduis la typographie avec les utilities Tailwind
4. Reproduis les espacements et marges
5. Adapte pour le responsive (mobile-first avec sm:, md:, lg:)

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
        job.status = 'done';
        job.progressMessage = 'Design reproduit avec succès !';
        console.log(`[Claude Code Image] Generation successful for project ${projectId} — ${Object.keys(allFiles).length} files`);
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

// ─── NOTIFY SSE CLIENTS ───
function notifyProjectClients(projectId, event, data, excludeUserId = null) {
  const clients = projectSSEClients.get(projectId);
  if (!clients) return;
  const dead = [];
  clients.forEach(client => {
    if (excludeUserId && client.userId === excludeUserId) return;
    try {
      client.res.write(`data: ${JSON.stringify({ type: event, ...data, timestamp: Date.now() })}\n\n`);
    } catch(e) { dead.push(client); }
  });
  // Clean dead connections
  dead.forEach(c => clients.delete(c));
}

// Get list of users currently connected to a project
function getProjectCollaborators(projectId) {
  const clients = projectSSEClients.get(projectId);
  if (!clients || clients.size === 0) return [];
  const seen = new Map();
  clients.forEach(c => {
    if (!seen.has(c.userId)) {
      seen.set(c.userId, { userId: c.userId, userName: c.userName, connectedAt: c.connectedAt });
    }
  });
  return Array.from(seen.values());
}

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
  '.jsx': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
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
    fs.writeFileSync(filePath, content);
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
async function stopContainerAsync(projectId) {
  if (!docker) return;
  const containerName = getContainerName(projectId);
  try {
    const container = docker.getContainer(containerName);
    try {
      await container.stop({ t: 10 });
    } catch (e) {
      // Container might not be running
    }
    try {
      await container.remove({ force: true });
    } catch (e) {
      // Container might not exist
    }
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
async function getContainerLogsAsync(projectId, tailLines = 100) {
  if (!docker) return 'Erreur: Docker non disponible.';
  const containerName = getContainerName(projectId);
  try {
    const container = docker.getContainer(containerName);
    const logStream = await container.logs({
      stdout: true,
      stderr: true,
      tail: tailLines,
      follow: false
    });
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
  let attempt = 0;

  console.log(`[Health] Starting health check for project ${projectId} → ${healthUrl} (timeout: ${maxWait / 1000}s)`);

  while (Date.now() - startTime < maxWait) {
    attempt++;
    try {
      const result = await new Promise((resolve) => {
        const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
          // HTTP 200 = healthy, regardless of body content
          if (res.statusCode === 200) {
            res.resume(); // drain the response
            resolve({ ok: true, statusCode: 200 });
          } else {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              resolve({ ok: false, reason: `HTTP ${res.statusCode}`, body: data.substring(0, 200) });
            });
          }
        });
        req.on('error', (e) => resolve({ ok: false, reason: `error: ${e.code || e.message}` }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout (2s)' }); });
      });

      if (result.ok) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Health] ${hostname} OK after ${attempt} attempts (${elapsed}s)`);
        return true;
      }

      // Log every attempt for first 3, then every 5th
      if (attempt <= 3 || attempt % 5 === 0) {
        console.log(`[Health] ${hostname} attempt ${attempt}: ${result.reason}${result.body ? ' — ' + result.body : ''}`);
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
  // Remove trailing conversational text after last closing brace/semicolon
  cleaned = cleaned.replace(/\n(?:N'hésitez pas|N'hésite pas|Si vous|Tu peux|Bonne continuation)[^\n]*$/gm, '');
  cleaned = cleaned.replace(/^\*\*[^*]+\*\*\s*$/gm, '');
  cleaned = cleaned.replace(/^---+\s*$/gm, '');

  // 4) Fix Express wildcard patterns
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
    Cmd: ['sh', '-c', [
      // Start Express (save PID for later restart)
      'node server.js & echo $! > /tmp/express.pid',
      // Start Vite with correct base path
      `./node_modules/.bin/vite --host 0.0.0.0 --port 5173 --base "/run/${projectId}/" &`,
      // Keep alive (use ; so this always runs even if Vite/Express crash)
      'while true; do sleep 3600; done'
    ].join('; ')],
    HostConfig: {
      NetworkMode: DOCKER_NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: [`${dataDir}:/app/data`],
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500000000,
      SecurityOpt: ['no-new-privileges']
    }
  });
  await container.start();

  // Wait for health (should be very fast — everything is pre-installed)
  const healthy = await waitForContainerHealth(projectId, 10000);
  if (healthy) {
    db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(`/run/${projectId}/`, projectId);
    console.log(`[Template] Container ready for project ${projectId} (instant launch)`);
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
  writeGeneratedFiles(projectDir, code);

  // Auto-fix relative imports
  validateJsxFiles(projectDir);

  // Copy into running container
  if (fs.existsSync(path.join(projectDir, 'src'))) {
    execSync(`docker cp ${projectDir}/src/. ${containerName}:/app/src/`, { timeout: 15000 });
  }
  // Copy index.html (may have custom title or meta tags)
  if (fs.existsSync(path.join(projectDir, 'index.html'))) {
    execSync(`docker cp ${projectDir}/index.html ${containerName}:/app/index.html`, { timeout: 10000 });
  }
  if (fs.existsSync(path.join(projectDir, 'server.js'))) {
    // Validate syntax before copying
    const { spawnSync } = require('child_process');
    const check = spawnSync('node', ['--check', path.join(projectDir, 'server.js')], { encoding: 'utf8', timeout: 5000 });
    if (check.status === 0) {
      execSync(`docker cp ${projectDir}/server.js ${containerName}:/app/server.js`, { timeout: 10000 });
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
      fs.writeFileSync(filePath, content);
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
        Binds: [`${dataDir}:/app/data`],
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

CORRIGE l'erreur. Retourne TOUS les fichiers modifiés avec ### markers.

RÈGLES:
1. Format ### pour chaque fichier (### package.json, ### server.js, ### src/App.tsx, etc.)
2. JAMAIS de backticks markdown autour du code
3. Retourne SEULEMENT les fichiers que tu modifies
4. server.js: Port 3000, route /health, express.static(path.join(__dirname,'dist'))
5. Composants React: export default function, imports corrects, hooks valides

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
    const correctedCode = await callClaudeForCorrection(project.generated_code, logs, errorType);
    
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
      const idle = Date.now() - lastAccess;

      // Auto-sleep: stop idle pbp-project-* containers only (never the main Prestige container)
      const targetContainer = getContainerName(project.id);
      if (running && !project.is_published && idle > SLEEP_TIMEOUT_MS && lastAccess > 0 && targetContainer.startsWith('pbp-project-')) {
        console.log(`[Sleep] Stopping idle ${targetContainer} (idle ${Math.round(idle / 60000)}min)`);
        try {
          const container = docker.getContainer(targetContainer);
          await container.stop({ t: 5 });
        } catch (e) { /* already stopped */ }
        continue;
      }

      // Keep published sites running
      if (!running && project.is_published) {
        const containerName = getContainerName(project.id);
        try {
          await startContainerAsync(project.id);
          await new Promise(r => setTimeout(r, 3000));
          const healthy = await waitForContainerHealth(project.id, 10000);
          if (healthy) {
            console.log(`[Monitor] Published container ${containerName} restarted`);
          }
        } catch (e) {
          console.error(`[Monitor] Failed to restart ${containerName}:`, e.message);
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

// Proxy request to container (uses Docker DNS name, not IP)
async function proxyToContainer(req, res, projectId, targetPath) {
  const containerHost = getContainerHostname(projectId);

  // Route through Vite dev server (5173) for preview — Vite proxies /api/* to Express (3000)
  // For published sites, the publish flow builds dist/ separately
  const proxyPort = 5173;

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
    const running = await isContainerRunningAsync(projectId);
    if (!running && !restartLocks.get(projectId)) {
      restartLocks.set(projectId, true);
      restartContainerAsync(projectId).catch(err => console.error('Restart error:', err.message));
      setTimeout(() => restartLocks.delete(projectId), 30000);
    }
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Redémarrage</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#0d1120,#1a2744);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#e2e8f0}.c{text-align:center;padding:40px}.l{width:50px;height:50px;border:4px solid rgba(212,168,32,.2);border-top-color:#D4A820;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 24px}@keyframes s{to{transform:rotate(360deg)}}h1{font-size:1.5rem;margin-bottom:12px;color:#D4A820}p{color:#8896c4}</style><script>setTimeout(()=>location.reload(),3000)</script></head><body><div class="c"><div class="l"></div><h1>Votre projet redémarre</h1><p>Veuillez patienter quelques instants...</p></div></body></html>`);
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
  csv-parse@5.5.3 marked@11.1.1 axios@1.6.7 \
  vite@6.3.5 @vitejs/plugin-react@4.5.2 \
  react@19.1.0 react-dom@19.1.0 react-router-dom@7.6.1 \
  lucide-react@0.511.0 clsx@2.1.1 tailwind-merge@3.3.0 \
  tailwindcss@4.1.7 @tailwindcss/vite@4.1.7 \
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
  // WebContainers require 'require-corp' for SharedArrayBuffer (credentialless not enough)
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

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
            res.setHeader('Set-Cookie', `pbp_token=${qsToken}; Path=/; ${isHttps ? 'HttpOnly; SameSite=None; Secure' : 'HttpOnly; SameSite=Lax'}; Max-Age=86400`);
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

  // PUBLISHED SITE SUBDOMAINS (*.prestige-build.dev — NOT preview-*)
  if (host && host.endsWith('.' + PUBLISH_DOMAIN) && host !== 'app.' + PUBLISH_DOMAIN && !host.startsWith('preview-')) {
    const subdomain = host.replace('.' + PUBLISH_DOMAIN, '').replace(/[^a-zA-Z0-9-]/g, '');
    if (subdomain) {
      const siteDir = path.join(SITES_DIR, subdomain);
      if (fs.existsSync(siteDir)) {
        // Serve published site static files
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
  // DOCKER PROXY ROUTE: /run/:projectId/*
  // Proxies requests to isolated Docker containers running project previews
  // Path rewriting: /run/23/ → /, /run/23/api/login → /api/login
  // ═══════════════════════════════════════════════════════════════════════════
  if (url.startsWith('/run/')) {
    const runMatch = req.url.match(/^\/run\/(\d+)(\/.*)?$/);
    if (!runMatch) {
      json(res, 400, { error: 'ID de projet invalide' });
      return;
    }
    const projectId = parseInt(runMatch[1]);

    // Authentication check for Docker proxy
    const user = getAuth(req);
    if (!user) {
      const hasHeader = !!(req.headers['authorization'] || '').replace('Bearer ', '');
      const hasQuery = req.url.includes('token=');
      const hasCookie = (req.headers.cookie || '').includes('pbp_token');
      console.warn(`[Proxy Auth] 401 for /run/${projectId} — header:${hasHeader} query:${hasQuery} cookie:${hasCookie}`);
      json(res, 401, { error: 'Non autorisé. Connectez-vous pour accéder au projet.' });
      return;
    }

    // Auth passed — set cookie so sub-requests (CSS, JS, fetch, images) from the
    // iframe are automatically authenticated without needing ?token= on each one.
    // Only set cookie when token comes via query string (initial iframe load).
    const qsParts = req.url.split('?');
    if (qsParts.length > 1) {
      const qsParams = new URLSearchParams(qsParts[1]);
      const qsToken = qsParams.get('token');
      if (qsToken) {
        const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.headers['x-forwarded-ssl'] === 'on';
        const cookieFlags = isHttps ? 'HttpOnly; SameSite=None; Secure; Max-Age=86400' : 'HttpOnly; SameSite=Lax; Max-Age=86400';
        res.setHeader('Set-Cookie', `pbp_token=${qsToken}; Path=/run/${projectId}/; ${cookieFlags}`);
      }
    }

    // Authorization check: user must own the project or be admin
    const project = db.prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
    if (!project || (user.role !== 'admin' && project.user_id !== user.id)) {
      json(res, 403, { error: 'Accès refusé à ce projet.' });
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

    // Wake container if sleeping
    const running = await isContainerRunningAsync(projectId);
    if (!running) {
      console.log(`[Sleep] Waking container for project ${projectId}`);
      await startContainerAsync(projectId);
      await waitForContainerHealth(projectId, 10000);
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
      json(res,401,{error:'Email ou mot de passe incorrect.'}); return;
    }
    console.log(`[Auth] Login: ${u.email} (${u.role})`);
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
    
    // If done, finalize project and cleanup
    if (job.status === 'done' && job.project_id && !job.finalized) {
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
      if (activeGenerations > 0) activeGenerations--;
    }
    // Also decrement counter on error (prevents counter leak blocking all future generations)
    if (job.status === 'error' && !job.finalized) {
      job.finalized = true;
      if (activeGenerations > 0) activeGenerations--;
    }

    // Return user-friendly message from Claude Code progress
    const progressMessage = job.progressMessage || (job.status === 'pending' ? 'En attente...' : 
      job.status === 'running' ? 'Génération en cours...' : 
      job.status === 'done' ? 'Terminé !' : 
      job.status === 'error' ? 'Erreur' : 'En cours...');
    
    json(res, 200, {
      job_id: jobId,
      status: job.status,
      code: job.code,
      error: job.error,
      progress: job.progress,
      progress_message: progressMessage,
      preview_url: job.preview_url,
      framework: job.framework,
      credentials: job.credentials || null,
      suggestions: job.suggestions || null,
      chat_message: job.chat_message || null
    });
    return;
  }

  // ─── GENERATE START (POLLING) ───
  if (url==='/api/generate/start' && req.method==='POST') {
    const {project_id, message}=await getBody(req);

    // #3 Validate input
    if (!message || typeof message !== 'string' || message.trim().length < 3) {
      json(res, 400, { error: 'Message requis (min 3 caractères).' }); return;
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

    // Detect intent: discussion (question) vs code (action)
    // Action words trigger code generation; questions get lightweight chat response
    const msg = (message || '').toLowerCase();
    const isQuestion = /^(comment|pourquoi|qu'est-ce|c'est quoi|explique|quel|quelle|est-ce que|combien|où|quand)\b/.test(msg)
      && !/\b(crée|ajoute|modifie|change|supprime|corrige|implémente|intègre|construis|fais|mets|retire)\b/.test(msg);

    const jobId = crypto.randomUUID();

    // Initialize job in Map
    generationJobs.set(jobId, {
      status: 'pending',
      code: '',
      error: null,
      progress: 0,
      project_id: project_id,
      user_id: user.id,
      message: message,
      finalized: false
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
    const userMsg = ai ? ai.buildProfessionalPrompt(message, project, savedApis) : message;
    const messages = ai ? ai.buildConversationContext(project, history, userMsg, projectKeys) : [{role:'user', content: userMsg}];
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
    } else {
      // Code mode: full generation pipeline
      activeGenerations++;
      generateClaude(messages, jobId, brief);
    }
    return;
  }

  // ─── GENERATE FROM IMAGE START (POLLING) ───
  if (url==='/api/generate/image/start' && req.method==='POST') {
    const body = await getBody(req);
    const { project_id, image_base64, media_type, prompt } = body;
    if (!image_base64) { json(res, 400, { error: 'Image requise' }); return; }
    
    const jobId = crypto.randomUUID();
    
    // Initialize job in Map
    generationJobs.set(jobId, {
      status: 'pending',
      code: '',
      error: null,
      progress: 0,
      project_id: project_id,
      user_id: user.id,
      message: '[Image uploadée pour reproduction de design]',
      finalized: false,
      is_image_gen: true
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
        execSync(`docker cp ${projDir}/src/. ${containerName}:/app/src/`, { timeout: 15000 });
      }
      // Root HTML and config (triggers full page reload via Vite if changed)
      if (fs.existsSync(path.join(projDir, 'index.html'))) {
        execSync(`docker cp ${projDir}/index.html ${containerName}:/app/index.html`, { timeout: 10000 });
      }
      // NOTE: Do NOT copy vite.config.js during hot reload — it causes Vite to restart
      // and kill the container (wait -n in start-dev.sh). Config changes require full rebuild.

      // Backend — only restart Express if server.js changed AND has no syntax errors
      if (fs.existsSync(path.join(projDir, 'server.js'))) {
        const { spawnSync } = require('child_process');
        const syntaxCheck = spawnSync('node', ['--check', path.join(projDir, 'server.js')], { encoding: 'utf8', timeout: 5000 });
        if (syntaxCheck.status === 0) {
          execSync(`docker cp ${projDir}/server.js ${containerName}:/app/server.js`, { timeout: 10000 });
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
          execSync(`docker exec ${containerName} sh -c 'kill $(cat /tmp/express.pid 2>/dev/null) 2>/dev/null; node server.js & echo $! > /tmp/express.pid'`, { timeout: 10000 });
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
            writeGeneratedFiles(projDir, fixCode);
            execSync(`docker cp ${projDir}/src/. ${containerName}:/app/src/`, { timeout: 15000 });
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
                  writeGeneratedFiles(projDir, fixCode);
                  // Update DB code
                  const updatedFiles = readProjectFilesRecursive(projDir);
                  const updatedCode = formatProjectCode(updatedFiles);
                  db.prepare("UPDATE projects SET generated_code=? WHERE id=?").run(updatedCode, project_id);
                  // Hot-reload the fix into the running container
                  const { execSync } = require('child_process');
                  const containerName = getContainerName(project_id);
                  try {
                    execSync(`docker cp ${projDir}/src/. ${containerName}:/app/src/`, { timeout: 15000 });
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

  // ─── WEBCONTAINER: TEMPLATE FILE TREE ───
  if (url === '/api/template-tree' && req.method === 'GET') {
    // Returns the entire template project as a WebContainer-compatible file tree
    // Format: { "file.tsx": { file: { contents: "..." } }, "dir": { directory: { ... } } }
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
    // Override package.json for WebContainer (remove native addons)
    const wcPkg = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'))));
    delete wcPkg.dependencies['better-sqlite3'];
    wcPkg.scripts.dev = 'vite --port 5173';
    tree['package.json'] = { file: { contents: JSON.stringify(wcPkg, null, 2) } };
    // Remove server.js from tree (it requires better-sqlite3 which doesn't work in WebContainer)
    // The Express backend is for production only — WebContainer preview is frontend-only
    delete tree['server.js'];
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

    // TEMPLATE-FIRST: Launch container IMMEDIATELY with template project
    // Preview is available in seconds, before any AI generation
    if (isDockerAvailable()) {
      launchTemplateContainer(projectId).then(result => {
        if (result.success) {
          console.log(`[Template] Project ${projectId} container ready at ${result.url}`);
          db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(user.id, `Projet "${title}" prêt — preview disponible !`, 'success');
        } else {
          console.warn(`[Template] Project ${projectId} container failed: ${result.error}`);
        }
      }).catch(err => console.error(`[Template] Launch error: ${err.message}`));
    }

    json(res,200,{id:projectId,title,status:'draft',preview:`/run/${projectId}/`}); return;
  }
  if (url.match(/^\/api\/projects\/\d+$/) && req.method==='GET') {
    const id=parseInt(url.split('/').pop());
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p||(user.role!=='admin'&&p.user_id!==user.id)) { json(res,403,{error:'Accès refusé.'}); return; }
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
    if (user.role!=='admin') { json(res,403,{error:'Admin seulement.'}); return; }
    const id=parseInt(url.split('/')[3]);
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) { json(res,404,{error:'Projet non trouvé.'}); return; }
    
    const body = await getBody(req);
    const subdomain = body.subdomain || p.subdomain || p.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 30) || `project-${id}`;

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
    
    // Clean up correction attempts tracking
    correctionAttempts.delete(id);
    correctionInProgress.delete(id);
    
    // Clean up preview files
    const previewDir = path.join(PREVIEWS_DIR, String(id));
    if (fs.existsSync(previewDir)) {
      try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch(e) { console.warn('Preview cleanup error:', e.message); }
    }
    
    // Clean up Docker container and image
    if (isDockerAvailable()) {
      try {
        await stopContainerAsync(id);
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
    
    const rawLogs = await getContainerLogsAsync(id, 100);
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

  // ─── USERS ───
  if (url==='/api/users' && req.method==='GET') { if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;} json(res,200,db.prepare('SELECT id,email,name,role,lang,created_at FROM users ORDER BY created_at DESC').all()); return; }
  if (url==='/api/users' && req.method==='POST') {
    if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;}
    const {email,password,name,role,lang}=await getBody(req);
    try { const i=db.prepare('INSERT INTO users (email,password,name,role,lang) VALUES (?,?,?,?,?)').run(email,require('bcryptjs').hashSync(password,10),name,role||'agent',lang||'fr'); json(res,200,{id:i.lastInsertRowid,email,name,role}); }
    catch(e){json(res,400,{error:'Email déjà utilisé.'});}
    return;
  }
  if (url.match(/^\/api\/users\/\d+$/) && req.method==='DELETE') { if(user.role!=='admin'){json(res,403,{error:'Interdit.'});return;} db.prepare('DELETE FROM users WHERE id=?').run(parseInt(url.split('/').pop())); json(res,200,{ok:true}); return; }

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
          fs.writeFileSync(filePath, content);
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
