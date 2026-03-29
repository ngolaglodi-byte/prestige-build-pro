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

// ─── GLOBAL ERROR HANDLERS (prevent server crash on unhandled errors) ───
process.on('uncaughtException', (err) => {
  console.error('Erreur non gérée:', err.message);
  console.error('Stack trace:', err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('Promise rejetée:', err.message);
  if (err && err.stack) console.error('Stack trace:', err.stack);
});

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

function trackTokenUsage(userId, projectId, operation, model, usage) {
  if (!db || !usage) return;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || usage.cache_creation_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  const pricing = TOKEN_PRICING[model] || TOKEN_PRICING['default'];
  const costUsd = (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cache_read +
    (cacheWrite / 1_000_000) * pricing.cache_write
  );

  try {
    db.prepare('INSERT INTO token_usage (user_id, project_id, operation, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userId || null, projectId || null, operation, model, inputTokens, outputTokens, cacheRead, cacheWrite, Math.round(costUsd * 100000) / 100000);
    console.log(`[Tokens] ${operation}: ${inputTokens}in + ${outputTokens}out = $${costUsd.toFixed(4)} (user:${userId} proj:${projectId})`);
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

  const todayCount = db.prepare("SELECT COUNT(*) as c FROM token_usage WHERE user_id=? AND operation IN ('generate','modify') AND created_at >= date('now')").get(userId)?.c || 0;
  const monthCount = db.prepare("SELECT COUNT(*) as c FROM token_usage WHERE user_id=? AND operation IN ('generate','modify') AND created_at >= date('now','start of month')").get(userId)?.c || 0;

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
- Les fichiers .jsx contiennent des composants React fonctionnels
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

db.exec(\\\`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );
\\\`);

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

app.listen(PORT, () => console.log(\\\`Server running on port \\\${PORT}\\\`));

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
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`;

// Default React source files for fallback
const DEFAULT_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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

// ─── SSE CLIENTS FOR REAL-TIME COLLABORATION ───
const projectSSEClients = new Map(); // Map<projectId, Set<{res, userId, userName}>>

// ─── JOBS MAP FOR POLLING-BASED GENERATION ───
const generationJobs = new Map(); // Map<job_id, {status, code, error, progress, project_id, user_id}>

// ─── SITES DIRECTORY FOR PUBLISHED SITES ───
const SITES_DIR = process.env.SITES_DIR || '/data/sites';
const PUBLISH_DOMAIN = process.env.PUBLISH_DOMAIN || 'prestige-build.dev';
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
  const b=Buffer.from(JSON.stringify({...p,exp:Math.floor(Date.now()/1000)+604800})).toString('base64url');
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
function json(res,code,data) { res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(data)); }
function cors(res) { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization'); }
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
  main.jsx            — ReactDOM.createRoot
  index.css           — @import "tailwindcss"
  App.jsx             — BrowserRouter + Routes + Layout
  components/
    Header.jsx        — Navigation responsive avec menu mobile
    Footer.jsx        — Pied de page
    ...               — Composants réutilisables selon le secteur
  pages/
    Home.jsx          — Page d'accueil
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

1. Un composant = un fichier .jsx avec export default function
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
  const validDirs = ['src/components', 'src/pages', 'src/styles', 'src/lib', 'src/hooks', 'src/context'];
  const validSrcFiles = ['src/main.jsx', 'src/index.css', 'src/App.jsx'];

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
        if (entry.endsWith('.jsx') || entry.endsWith('.js') || entry.endsWith('.css')) {
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
    'src/main.jsx', 'src/index.css', 'src/App.jsx'
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
    'src/main.jsx': DEFAULT_MAIN_JSX,
    'src/index.css': DEFAULT_INDEX_CSS,
    'src/App.jsx': DEFAULT_APP_JSX,
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
  const prompt = `Lis le fichier CLAUDE.md dans ce dossier et exécute toutes les instructions pour générer une application React + Vite + TailwindCSS complète basée sur le brief. Génère tous les fichiers du projet (package.json, vite.config.js, index.html, server.js, src/main.jsx, src/index.css, src/App.jsx, src/components/*.jsx, src/pages/*.jsx), teste-les avec npm run build, et crée le fichier READY quand tout fonctionne.`;
  
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
  const prompt = `Modifie les fichiers React existants dans ce dossier selon cette instruction: "${message}". Le projet utilise React + Vite + TailwindCSS. Tu peux modifier src/App.jsx, src/components/*.jsx, src/pages/*.jsx, server.js, src/index.css, etc. Teste avec npm run build, puis crée le fichier READY quand tout fonctionne. Si erreur après 5 tentatives, crée le fichier ERROR.`;
  
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
function callClaudeAPI(systemBlocks, messages, maxTokens = 16000, trackingInfo = null) {
  return new Promise((resolve, reject) => {
    const model = 'claude-sonnet-4-20250514';
    const apiPayload = { model, max_tokens: maxTokens, system: systemBlocks, messages };
    const payload = JSON.stringify(apiPayload);
    const opts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const timeoutMs = Math.max(maxTokens * 5, 120000); // ~5ms per token, min 2 min
    anthropicRequest(payload, opts, (apiRes) => {
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
          if (r.content?.[0]?.text) {
            console.log(`[callClaudeAPI] OK: ${r.content[0].text.length} chars, usage: ${JSON.stringify(r.usage || {})}`);
            // Track token usage if tracking info provided
            if (trackingInfo && r.usage) {
              trackTokenUsage(trackingInfo.userId, trackingInfo.projectId, trackingInfo.operation, model, r.usage);
            }
            resolve(r.content[0].text);
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

  // Detect sector-specific structure from brief
  const sectorHint = sectorProfile ? sectorProfile.substring(0, 200) : '';

  // ── PHASE 1: Infrastructure (sequential — needed before UI) ──
  job.progressMessage = 'Génération du backend...';
  console.log(`[Gen] Phase 1: Infrastructure for project ${projectId}`);

  const infraPrompt = `Génère l'infrastructure React+Vite+TailwindCSS.

Brief: ${brief}
${sectorHint ? `Secteur: ${sectorHint}` : ''}

Génère ces 6 fichiers avec ### markers :
### package.json — "type":"module", React 19, Vite 6, TailwindCSS 4, Express 4.18.2, better-sqlite3
### vite.config.js — plugins react+tailwindcss, server: host 0.0.0.0 port 5173 allowedHosts:true, proxy /api→localhost:3000
### index.html — <div id="root">, <script type="module" src="/src/main.jsx">
### server.js — Express complet: tables SQLite adaptées au brief, routes API CRUD, auth JWT, bcrypt, /health, sert dist/. FIN: // CREDENTIALS: email=admin@project.com password=[fort]
### src/main.jsx — ReactDOM.createRoot, import App + index.css
### src/index.css — @import "tailwindcss";

Code COMPLET et fonctionnel. Pas de placeholder.`;

  try {
    const infraCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: infraPrompt }], 24000, { ...tracking, operation: 'generate' });
    allCode = infraCode;
    writeGeneratedFiles(projectDir, infraCode);
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
### src/App.jsx — import BrowserRouter,Routes,Route. Import Header,Footer,Home,About,Contact (ou pages adaptées au brief). Layout: <Header/> + <Routes> + <Footer/>
### src/pages/Home.jsx — page d'accueil COMPLÈTE: hero section, sections principales, contenu réaliste en français, fetch('/api/...') pour données dynamiques
### src/pages/About.jsx — page à propos, histoire, équipe, valeurs
### src/pages/Contact.jsx — formulaire contact complet avec validation useState, carte/adresse

Chaque fichier : export default function, TailwindCSS classes, lucide-react icônes, responsive.
Contenu PRO français, zéro lorem ipsum. Images: picsum.photos.`;

  const compsPrompt = `Génère les composants React réutilisables.

Brief: ${brief}

Génère ces fichiers avec ### markers :
### src/components/Header.jsx — header sticky responsive, logo, nav desktop + menu hamburger mobile (useState), liens: Accueil, À propos, Contact
### src/components/Footer.jsx — footer professionnel, copyright 2024, liens rapides, coordonnées
### src/components/HeroSection.jsx — hero plein écran, titre accrocheur, sous-titre, CTA button, image de fond picsum.photos

Chaque composant : export default function, TailwindCSS, lucide-react. Design pro, responsive.`;

  // Launch BOTH in parallel — they don't depend on each other
  const [pagesResult, compsResult] = await Promise.allSettled([
    callClaudeAPI(systemBlocks, [{ role: 'user', content: pagesPrompt }], 24000, { ...tracking, operation: 'generate' }),
    callClaudeAPI(systemBlocks, [{ role: 'user', content: compsPrompt }], 12000, { ...tracking, operation: 'generate' })
  ]);

  // Merge pages result
  if (pagesResult.status === 'fulfilled') {
    allCode = mergeModifiedCode(allCode, pagesResult.value);
    writeGeneratedFiles(projectDir, pagesResult.value);
    job.code = allCode;
    job.progress = allCode.length;
    console.log(`[Gen] Pages OK: +${pagesResult.value.length} chars`);
  } else {
    console.error(`[Gen] Pages failed: ${pagesResult.reason?.message}`);
  }

  // Merge components result
  if (compsResult.status === 'fulfilled') {
    allCode = mergeModifiedCode(allCode, compsResult.value);
    writeGeneratedFiles(projectDir, compsResult.value);
    job.code = allCode;
    job.progress = allCode.length;
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
      const fixCode = await callClaudeAPI(systemBlocks, [{ role: 'user', content: fixPrompt }], 16000, { ...tracking, operation: 'generate' });
      allCode = mergeModifiedCode(allCode, fixCode);
      writeGeneratedFiles(projectDir, fixCode);
      console.log(`[Gen] Fixed ${missingFiles.length} missing imports`);
    } catch (e) {
      console.warn(`[Gen] Could not generate missing files: ${e.message}`);
      // Write stub components so Vite doesn't crash
      for (const f of missingFiles) {
        const fp = path.join(projectDir, f);
        if (!fs.existsSync(fp)) {
          const name = path.basename(f, '.jsx');
          const fpDir = path.dirname(fp);
          if (!fs.existsSync(fpDir)) fs.mkdirSync(fpDir, { recursive: true });
          fs.writeFileSync(fp, `import React from 'react';\n\nexport default function ${name}() {\n  return <div className="p-8"><h2 className="text-xl font-bold">${name}</h2></div>;\n}\n`);
          console.log(`[Gen] Wrote stub: ${f}`);
        }
      }
    }
    savePartialToDb();
  }

  // ── Finalize ──
  const finalFiles = readProjectFilesRecursive(projectDir);
  allCode = formatProjectCode(finalFiles);
  job.code = allCode;
  savePartialToDb();
  job.status = 'done';
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(0);
  job.progressMessage = `Projet React généré en ${totalSec}s !`;
  console.log(`[Gen] COMPLETE: ${Object.keys(finalFiles).length} files, ${allCode.length} chars, ${totalSec}s total`);
}

// Scan App.jsx and all components/pages for missing imports
function findMissingImports(projectDir) {
  const missing = [];
  const srcDir = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDir)) return missing;

  // Collect all .jsx files to scan
  const filesToScan = [];
  const appJsx = path.join(srcDir, 'App.jsx');
  if (fs.existsSync(appJsx)) filesToScan.push(appJsx);
  for (const sub of ['components', 'pages']) {
    const dir = path.join(srcDir, sub);
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).filter(f => f.endsWith('.jsx')).forEach(f => filesToScan.push(path.join(dir, f)));
    }
  }

  // Extract relative imports and check if target exists
  const checked = new Set();
  for (const file of filesToScan) {
    const content = fs.readFileSync(file, 'utf8');
    const fileDir = path.dirname(file);
    // Match: import X from './path' or import X from '../path'
    const importRegex = /import\s+\w+\s+from\s+['"](\.[^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      // Resolve to absolute path, try .jsx extension
      let resolved = path.resolve(fileDir, importPath);
      if (!resolved.endsWith('.jsx') && !resolved.endsWith('.js') && !resolved.endsWith('.css')) {
        resolved += '.jsx';
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
    const essentialFiles = ['index.html', 'src/main.jsx', 'src/App.jsx', 'vite.config.js'];
    let missingFiles = [];
    for (const f of essentialFiles) {
      if (!fs.existsSync(path.join(projDir, f))) missingFiles.push(f);
    }
    if (missingFiles.length > 0) {
      console.log(`[Validate] Missing React files: ${missingFiles.join(', ')} — writing defaults`);
      writeDefaultReactProject(projDir);
    }

    // 3) Quick JSX sanity check: src/App.jsx should contain valid-looking JSX
    const appJsxPath = path.join(projDir, 'src', 'App.jsx');
    if (fs.existsSync(appJsxPath)) {
      const appContent = fs.readFileSync(appJsxPath, 'utf8');
      const hasExport = /export\s+default/.test(appContent);
      const hasJsx = /<\w/.test(appContent);
      const hasImport = /import\s+/.test(appContent);
      if (!hasExport || !hasJsx || !hasImport) {
        console.warn(`[Validate] src/App.jsx looks malformed (export:${hasExport} jsx:${hasJsx} import:${hasImport})`);
        if (attempt < maxAttempts) {
          // Ask Claude to fix App.jsx
          const fixPrompt = `Le fichier src/App.jsx du projet React est malformé. Il doit contenir un composant React valide avec import React, export default function, et du JSX. Corrige-le.\n\nContenu actuel:\n${appContent.substring(0, 3000)}\n\nRetourne le fichier corrigé avec ### src/App.jsx`;
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
    'src/main.jsx', 'src/index.css', 'src/App.jsx'
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
    'src/main.jsx', 'src/index.css', 'src/App.jsx'
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
const VALID_FILE_PATTERNS = [
  /^package\.json$/,
  /^vite\.config\.js$/,
  /^index\.html$/,
  /^server\.js$/,
  /^src\/main\.jsx$/,
  /^src\/index\.css$/,
  /^src\/App\.jsx$/,
  /^src\/components\/[A-Za-z0-9_-]+\.jsx$/,
  /^src\/pages\/[A-Za-z0-9_-]+\.jsx$/,
  /^src\/styles\/[A-Za-z0-9_-]+\.css$/,
  /^src\/lib\/[A-Za-z0-9_-]+\.(js|jsx)$/,
  /^src\/hooks\/[A-Za-z0-9_-]+\.(js|jsx)$/,
  /^src\/context\/[A-Za-z0-9_-]+\.(js|jsx)$/,
  // Legacy support for public/index.html (map to index.html at root)
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

  // Route: modifications go through API (with full code context), new generation through API fallback
  if (job.project_id) {
    const projectDir = path.join(DOCKER_PROJECTS_DIR, String(job.project_id));
    const serverJsPath = path.join(projectDir, 'server.js');
    const isModification = fs.existsSync(serverJsPath);

    if (isModification) {
      // Modifications: ALWAYS use API path — sends full code context + CHAT_SYSTEM_PROMPT
      // Claude Code CLI cannot run as root (--dangerously-skip-permissions fails)
      console.log(`[generateClaude] Modification for project ${job.project_id} — using API with full code context`);
      // Don't return here — fall through to the API streaming path below
    } else {
      // New generation: use API fallback (reliable, no root issue)
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
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
  };
  const payload = JSON.stringify(apiPayload);
  const opts = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31,web-search-2025-03-05','Content-Length':Buffer.byteLength(payload)} };
  
  anthropicRequest(payload, opts, (apiRes) => {
    let buffer = '';
    apiRes.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const d = JSON.parse(data);
          // Handle text deltas (regular content)
          if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta' && d.delta?.text) {
            job.code += d.delta.text;
            job.progress = job.code.length;
          }
          // Handle web search progress
          if (d.type === 'content_block_start' && d.content_block?.type === 'server_tool_use') {
            job.progressMessage = 'Recherche web en cours...';
          }
          if (d.type === 'content_block_start' && d.content_block?.type === 'text') {
            job.progressMessage = 'Prestige AI rédige le code...';
          }
          // Handle completion — set flag, process in 'end' handler
          if (d.type === 'message_stop') {
            job._messageComplete = true;
          }
          // Handle errors in stream
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
      if (job.status === 'running' && job.code.length > 0) {
        try {
          // Strip Claude artifacts (SUGGESTIONS, conversational text, backticks)
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
- index.html — <div id="root"> + <script type="module" src="/src/main.jsx">
- server.js — Express servant dist/, SQLite, JWT auth
- src/main.jsx — point d'entrée React
- src/index.css — @import "tailwindcss" + custom CSS
- src/App.jsx — BrowserRouter + Routes + Layout
- src/components/*.jsx — Header, Footer, etc.
- src/pages/*.jsx — Home, etc.

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
  clients.forEach(client => {
    if (excludeUserId && client.userId === excludeUserId) return;
    try {
      client.res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
    } catch(e) {}
  });
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
function injectErrorConsole(html) {
  const errorScript = `
<script>
(function() {
  const errors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  
  function notifyParent(type, msg) {
    try {
      window.parent.postMessage({ type: 'preview-console', level: type, message: String(msg) }, '*');
    } catch(e) {}
  }
  
  console.error = function(...args) {
    notifyParent('error', args.join(' '));
    originalError.apply(console, args);
  };
  
  console.warn = function(...args) {
    notifyParent('warn', args.join(' '));
    originalWarn.apply(console, args);
  };
  
  window.onerror = function(msg, url, line, col, error) {
    notifyParent('error', msg + ' (line ' + line + ')');
    return false;
  };
  
  window.onunhandledrejection = function(e) {
    notifyParent('error', 'Promise rejected: ' + (e.reason?.message || e.reason || 'Unknown'));
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

  // 3) Remove conversational text that isn't code
  //    Must be careful not to remove JSX text content or comments
  cleaned = cleaned.replace(/^(?:Voici|Voilà|Ce fichier|Ce composant|Ce code|J'ai (?:ajouté|modifié|créé|changé|corrigé)|Ci-dessus|Ci-dessous|En résumé|Bien sûr|Parfait|D'accord|Très bien|OK,|C'est fait).+$/gm, '');
  cleaned = cleaned.replace(/^---+\s*$/gm, '');
  cleaned = cleaned.replace(/^\*\*[^*]+\*\*\s*$/gm, '');
  // Lines that are pure text (no code chars) at the very end of the file
  cleaned = cleaned.replace(/\n(?:N'hésitez pas|N'hésite pas|Les? modifications?|Si vous|Tu peux|Bonne continuation).+$/gm, '');

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
  if (!html.includes('src="/src/main.jsx"') && !html.includes("src='/src/main.jsx'")) {
    console.warn(`[Validate] index.html missing main.jsx entry — fixing`);
    if (html.includes('</body>')) {
      html = html.replace('</body>', '  <script type="module" src="/src/main.jsx"></script>\n</body>');
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

    // Fix package.json to use pinned versions and ensure "type": "module"
    const packageJsonPathForScan = path.join(projectDir, 'package.json');
    if (fs.existsSync(packageJsonPathForScan)) {
      let packageContent = fs.readFileSync(packageJsonPathForScan, 'utf8');
      let packageCorrected = false;

      // Fix Express 5.x references
      if (packageContent.includes('"express": "^5') || packageContent.includes('"express": "5')) {
        packageContent = packageContent.replace(/"express"\s*:\s*"\^?5[^"]*"/g, '"express": "4.18.2"');
        console.log(`[Docker Build] Fixed Express 5.x to 4.18.2`);
        packageCorrected = true;
      }

      // Remove ^ prefix from critical dependencies
      const criticalDeps = ['express', 'better-sqlite3', 'bcryptjs', 'jsonwebtoken', 'cors', 'helmet', 'compression', 'react', 'react-dom', 'react-router-dom', 'vite'];
      for (const dep of criticalDeps) {
        const regex = new RegExp(`"${dep}"\\s*:\\s*"\\^`, 'g');
        if (packageContent.match(regex)) {
          packageContent = packageContent.replace(regex, `"${dep}": "`);
          packageCorrected = true;
        }
      }

      if (packageCorrected) {
        fs.writeFileSync(packageJsonPathForScan, packageContent);
        console.log(`[Docker Build] package.json versions pinned`);
      }
    }

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
      'src/main.jsx': DEFAULT_MAIN_JSX,
      'src/index.css': DEFAULT_INDEX_CSS,
      'src/App.jsx': DEFAULT_APP_JSX,
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
COPY package.json ./
COPY vite.config.js ./
COPY index.html ./
COPY server.js ./
COPY src/ ./src/
COPY start-dev.sh ./
RUN chmod +x start-dev.sh
RUN mkdir -p /app/data
ENV JWT_SECRET=${jwtSecret}
ENV PORT=3000
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
      './node_modules/.bin/vite --host 0.0.0.0 --port 5173 &',
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
  const requiredFiles = ['index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx'];
  const missing = requiredFiles.filter(f => !fs.existsSync(path.join(projectDir, f)));
  if (missing.length > 0) {
    console.warn(`[checkSyntax] Missing React files: ${missing.join(', ')}`);
    // Not a hard failure — writeDefaultReactProject will fill in gaps
  }

  // 3) Quick JSX sanity: App.jsx should have export default and JSX
  const appJsx = path.join(projectDir, 'src', 'App.jsx');
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
  // Extract file list from code so AI understands the project structure
  const fileList = (originalCode.match(/### ([^\n]+)/g) || []).map(m => m.replace('### ', ''));

  // Identify which file likely caused the error
  const errorFileHints = [];
  if (errorLogs.includes('server.js')) errorFileHints.push('server.js');
  if (errorLogs.includes('App.jsx') || errorLogs.includes('src/')) errorFileHints.push('src/App.jsx');
  if (errorLogs.match(/components\/\w+/)) errorFileHints.push(errorLogs.match(/components\/(\w+\.jsx)/)?.[0] || '');
  if (errorLogs.match(/pages\/\w+/)) errorFileHints.push(errorLogs.match(/pages\/(\w+\.jsx)/)?.[0] || '');
  if (errorLogs.includes('vite') || errorLogs.includes('build')) errorFileHints.push('vite.config.js');
  if (errorLogs.includes('package.json') || errorLogs.includes('Cannot find module')) errorFileHints.push('package.json');

  const correctionPrompt = `Ce projet React+Vite a cette erreur : ${translateErrorType(errorType)}

STRUCTURE DU PROJET (${fileList.length} fichiers):
${fileList.map(f => `  - ${f}`).join('\n')}

${errorFileHints.length ? `FICHIER(S) PROBABLEMENT EN CAUSE: ${errorFileHints.filter(Boolean).join(', ')}` : ''}

LOGS D'ERREUR:
${errorLogs.substring(0, 3000)}

CODE COMPLET DU PROJET:
${originalCode}

CORRIGE l'erreur. Retourne TOUS les fichiers modifiés avec ### markers.

RÈGLES:
1. Format ### pour chaque fichier (### package.json, ### server.js, ### src/App.jsx, etc.)
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
      // Try again recursively
      return await autoCorrectProject(projectId, onProgress);
    }
    
  } catch (e) {
    console.error('Auto-correction failed:', e.message);
    
    const currentAttempts = correctionAttempts.get(projectId) || 0;
    
    // Always check attempts before recursing
    if (currentAttempts >= MAX_AUTO_CORRECTION_ATTEMPTS) {
      return { 
        success: false, 
        reason: 'max_attempts',
        attempts: currentAttempts,
        error: e.message
      };
    }
    
    // Increment attempts before retrying
    correctionAttempts.set(projectId, currentAttempts + 1);
    
    // Check again after increment
    if (correctionAttempts.get(projectId) >= MAX_AUTO_CORRECTION_ATTEMPTS) {
      return { 
        success: false, 
        reason: 'max_attempts',
        attempts: correctionAttempts.get(projectId),
        error: e.message
      };
    }
    
    // Try again
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
    if (isHtml) {
      delete headers['content-encoding'];
      delete headers['content-length']; // length will change after injection
      if (!headers['content-type'].includes('charset')) {
        headers['content-type'] = 'text/html; charset=utf-8';
      }
    }

    res.writeHead(proxyRes.statusCode, headers);

    if (isHtml) {
      // Check if this is a React/Vite project (has @vite/client or react-refresh)
      let body = '';
      proxyRes.on('data', chunk => body += chunk.toString());
      proxyRes.on('end', () => {
        try {
          // React/Vite projects: serve HTML as-is — Vite handles all routing
          const isViteProject = body.includes('@vite/client') || body.includes('@react-refresh') || body.includes('type="module" src="/src/');
          if (isViteProject) {
            res.end(body);
            return;
          }

          // Vanilla HTML projects: inject <base> + fetch patch
          const pid = Number(projectId);
          const baseTag = `<base href="/run/${pid}/">`;
          const proxyScript = `<script>(function(){var B='/run/${pid}/';` +
            `var _f=window.fetch;window.fetch=function(u,o){if(typeof u==='string'&&u.startsWith('/'))u=u.substring(1);return _f.call(this,u,o);};` +
            `var _x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string'&&u.startsWith('/'))u=u.substring(1);return _x.call(this,m,u);};` +
            // Intercept window.location changes that would navigate to Prestige
            `var _a=HTMLAnchorElement.prototype;Object.defineProperty(_a,'href',{set:function(v){if(typeof v==='string'&&v.startsWith('/')&&!v.startsWith(B))v=B+v.substring(1);this.setAttribute('href',v);}});` +
            // Intercept form actions
            `document.addEventListener('submit',function(e){var a=e.target.action;if(a&&a.includes(location.origin)&&!a.includes(B)){e.target.action=a.replace(location.origin+'/',location.origin+B);}},true);` +
            // Visibility rescue: fix opacity:0, visibility:hidden, and SPA .page display:none
            `window.addEventListener('load',function(){` +
            `document.querySelectorAll('*').forEach(function(el){var s=getComputedStyle(el);if(s.opacity==='0')el.style.opacity='1';if(s.visibility==='hidden')el.style.visibility='visible';});` +
            `var pages=document.querySelectorAll('.page');if(pages.length>0){var hasActive=document.querySelector('.page.active');if(!hasActive){pages[0].classList.add('active');pages[0].style.display='block';}}` +
            `});` +
            `})();</script>`;
          // Inject after <meta charset> so browser knows encoding before parsing our script
          const injection = baseTag + proxyScript;
          if (body.match(/<meta\s+charset[^>]*>/i)) {
            body = body.replace(/<meta\s+charset[^>]*>/i, `$&${injection}`);
          } else if (body.includes('<head>')) {
            body = body.replace('<head>', `<head>${injection}`);
          } else if (body.includes('<head ')) {
            body = body.replace(/<head\s[^>]*>/, `$&${injection}`);
          } else if (body.includes('<html')) {
            body = body.replace(/<html[^>]*>/, `$&<head>${injection}</head>`);
          } else {
            body = injection + body;
          }
          res.end(body);
        } catch (injErr) {
          console.error(`[Proxy] HTML injection error for project ${projectId}:`, injErr.message);
          res.end(body);
        }
      });
      proxyRes.on('error', () => { try { res.end(); } catch(e) {} });
    } else {
      proxyRes.pipe(res);
    }
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
  lucide-react@0.511.0 clsx@2.1.1 \
  tailwindcss@4.1.7 @tailwindcss/vite@4.1.7
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
  await ensureDockerNetwork();
  await joinPbpProjectsNetwork();
  await rebuildContainerMapping();
}

// ─── SERVER ───
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method==='OPTIONS') { res.writeHead(200); res.end(); return; }
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

  // SUBDOMAINS (*.prestige-build.dev)
  if (host && host.endsWith('.' + PUBLISH_DOMAIN) && host !== 'app.' + PUBLISH_DOMAIN) {
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

    // Build the target path: strip /run/{id} prefix, preserve query string
    // but remove the auth token param (no need to leak it to the container)
    let targetPath = runMatch[2] || '/';
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
    if (!global._loginAttempts) global._loginAttempts = new Map();
    const attempts = global._loginAttempts.get(loginKey) || { count: 0, reset: now + 60000 };
    if (now > attempts.reset) { attempts.count = 0; attempts.reset = now + 60000; }
    attempts.count++;
    global._loginAttempts.set(loginKey, attempts);
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
    if (!global._trackLimits) global._trackLimits = new Map();
    const tl = global._trackLimits.get(trackKey) || { count: 0, reset: Date.now() + 60000 };
    if (Date.now() > tl.reset) { tl.count = 0; tl.reset = Date.now() + 60000; }
    tl.count++;
    global._trackLimits.set(trackKey, tl);
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
      job.finalized = true;
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

    // Check user quota before starting generation
    const quota = checkUserQuota(user.id);
    if (!quota.allowed) {
      json(res, 429, { error: quota.reason, quota: { daily: quota.daily, dailyLimit: quota.dailyLimit, monthly: quota.monthly, monthlyLimit: quota.monthlyLimit } });
      return;
    }

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
    
    generateClaude(messages, jobId, brief);
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

      // Backend — only restart Express if server.js actually changed
      if (fs.existsSync(path.join(projDir, 'server.js'))) {
        execSync(`docker cp ${projDir}/server.js ${containerName}:/app/server.js`, { timeout: 10000 });
        serverChanged = true;
      }

      // Only restart if server.js changed (API routes/DB schema changes)
      // Frontend changes are picked up by Vite HMR instantly — no restart needed
      if (serverChanged) {
        console.log(`[HMR] server.js changed — restarting Express...`);
        const container = docker.getContainer(containerName);
        // Kill and restart only the Express process, not Vite
        try {
          execSync(`docker exec ${containerName} sh -c "kill $(cat /tmp/express.pid 2>/dev/null) 2>/dev/null; node server.js & echo $! > /tmp/express.pid"`, { timeout: 10000 });
        } catch {
          // Fallback: full container restart
          await container.restart({ t: 2 });
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      const elapsed = Date.now() - startTime;
      db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(`/run/${project_id}/`, project_id);
      console.log(`[HMR] ${containerName} updated in ${elapsed}ms — Vite HMR handles the rest`);
      json(res, 200, { hot: true, url: `/run/${project_id}/`, elapsed });
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

  // ─── PROJECTS CRUD ───
  if (url==='/api/projects' && req.method==='GET') {
    const p=user.role==='admin'?db.prepare('SELECT p.*,u.name as agent_name FROM projects p JOIN users u ON p.user_id=u.id ORDER BY p.updated_at DESC').all():db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC').all(user.id);
    json(res,200,p); return;
  }
  if (url==='/api/projects' && req.method==='POST') {
    const {title,client_name,project_type,brief,subdomain,domain,apis}=await getBody(req);
    const info=db.prepare("INSERT INTO projects (user_id,title,client_name,project_type,brief,subdomain,domain,apis,status) VALUES (?,?,?,?,?,?,?,?,'draft')").run(user.id,title,client_name,project_type,brief,subdomain,domain,JSON.stringify(apis||[]));
    json(res,200,{id:info.lastInsertRowid,title,status:'draft'}); return;
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
    json(res, 200, {
      today: { input_tokens: today.inp, output_tokens: today.out, cost_usd: Math.round(today.cost * 10000) / 10000, api_calls: today.calls },
      month: { input_tokens: month.inp, output_tokens: month.out, cost_usd: Math.round(month.cost * 10000) / 10000, api_calls: month.calls },
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
    
    json(res, 200, {
      totalViews,
      totalClicks,
      totalForms,
      avgTimeSpent: Math.round(avgTime?.avg_seconds || 0),
      viewsByDay,
      topPages,
      topClicks
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
    
    // Register this client
    if (!projectSSEClients.has(projectId)) {
      projectSSEClients.set(projectId, new Set());
    }
    const clientInfo = { res, userId: user.id, userName: user.name };
    projectSSEClients.get(projectId).add(clientInfo);
    
    // Notify others that this user joined
    notifyProjectClients(projectId, 'user_joined', { userName: user.name, userId: user.id }, user.id);
    
    // Send initial connection confirmation
    res.write(`data: ${JSON.stringify({ type: 'connected', userId: user.id, userName: user.name })}\n\n`);
    
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

  res.writeHead(404); res.end('Not found');
});

// ─── WEBSOCKET UPGRADE HANDLER (Vite HMR through /run/:id/ proxy) ───
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  const match = url.match(/^\/run\/(\d+)\//);
  if (!match) { socket.destroy(); return; }

  const projectId = match[1];
  const containerHost = getContainerHostname(projectId);
  const targetPath = url.replace(`/run/${projectId}`, '') || '/';

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

server.listen(PORT, ()=>{
  console.log(`Prestige Build Pro on port ${PORT}`);
  console.log(`API: ${ANTHROPIC_API_KEY?'OK':'MISSING'} | Compiler: ${compiler?'OK':'N/A'}`);

  // Initialize Docker preview system
  initializeDockerSystem();

  // Start container monitoring (every 30 seconds)
  if (isDockerAvailable()) {
    console.log('Starting container monitoring (30s interval)...');
    setInterval(monitorContainers, CONTAINER_MONITORING_INTERVAL);
  }

  // Start automatic backups every 6 hours
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  setInterval(backupAllProjects, BACKUP_INTERVAL_MS);
  console.log('Automatic backup system active (every 6h)');
});
