// ─── PRESTIGE BUILD PRO — CONFIGURATION ───
// Centralized configuration: env vars, constants, pricing, defaults.

const crypto = require('crypto');
const path = require('path');

// ─── ENV VAR VALIDATION ───
const REQUIRED_ENV = ['ANTHROPIC_API_KEY'];
const OPTIONAL_ENV = { PORT: '3000', DB_PATH: './prestige-pro.db', JWT_SECRET: null, DOCKER_PROJECTS_DIR: '/data/projects' };

function validateEnv() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) console.warn(`[Config] ⚠️  ${key} non défini — la génération IA ne fonctionnera pas`);
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('[FATAL] JWT_SECRET env var must be set (min 32 chars). Generate one with: openssl rand -hex 64');
    process.exit(1);
  }

  const ENCRYPTION_KEY_RAW = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (ENCRYPTION_KEY_RAW.length < 32) {
    console.error('[FATAL] ENCRYPTION_KEY (or JWT_SECRET fallback) must be at least 32 chars.');
    process.exit(1);
  }

  return {
    PORT: process.env.PORT || 3000,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env['GPT-4_Mini'] || process.env.GPT4_MINI_KEY || '',
    JWT_SECRET: process.env.JWT_SECRET,
    ENCRYPTION_KEY_RAW,
    ENCRYPT_KEY: crypto.createHash('sha256').update(ENCRYPTION_KEY_RAW).digest(),
    DB_PATH: process.env.DB_PATH || './prestige-pro.db',
    PREVIEWS_DIR: process.env.PREVIEWS_DIR || '/tmp/previews',
    DOCKER_PROJECTS_DIR: process.env.DOCKER_PROJECTS_DIR || '/data/projects',
    DOCKER_NETWORK: 'pbp-projects',
    DOCKER_BASE_IMAGE: 'pbp-base',
    DOCKER_SOCKET_PATH: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    DOCKER_HEALTH_TIMEOUT: 60000,
    SITES_DIR: process.env.SITES_DIR || '/data/sites',
    PUBLISH_DOMAIN: process.env.PUBLISH_DOMAIN || 'prestige-build.dev',
    ENCRYPT_PREFIX: 'enc:v1:',
  };
}

// ─── CONSTANTS ───
const MAX_CONCURRENT_GENERATIONS = 8;
const MAX_AUTO_CORRECTION_ATTEMPTS = 3;
const CONTAINER_MONITORING_INTERVAL = 30000;
const SLEEP_TIMEOUT_MS = 30 * 60 * 1000;
const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_CODE_DISPLAY_LENGTH = 50000;
const CLAUDE_CODE_TIMEOUT_MS = 10 * 60 * 1000;
const API_MAX_RETRIES = 5;
const MAX_COLLABORATORS_PER_PROJECT = 20;

// ─── TOKEN PRICING ───
const TOKEN_PRICING = {
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'default': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 }
};

// ─── ERROR TYPES ───
const ERROR_TYPES = {
  SYNTAX: 'syntax',
  DEPENDENCY: 'dependency',
  PORT: 'port',
  SQLITE: 'sqlite',
  MEMORY: 'memory',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown'
};

// ─── API ERROR MESSAGES ───
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

// ─── ABSOLUTE BROWSER RULE ───
const ABSOLUTE_BROWSER_RULE = `RÈGLE ABSOLUE : Les projets générés utilisent React + Vite + TailwindCSS.
- Les fichiers .tsx contiennent des composants React fonctionnels
- Le styling se fait via TailwindCSS classes dans className
- Les icônes via lucide-react — JAMAIS de CDN
- Navigation via react-router-dom <Link> — JAMAIS window.location
- Le package.json doit être du JSON strict avec "type": "module"
- server.js sert dist/ en production après npm run build

`;

// ─── STRUCTURED LOGGING ───
function log(level, category, message, meta = {}) {
  const entry = { timestamp: new Date().toISOString(), level, category, message, ...meta };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

module.exports = {
  validateEnv,
  // Constants
  MAX_CONCURRENT_GENERATIONS,
  MAX_AUTO_CORRECTION_ATTEMPTS,
  CONTAINER_MONITORING_INTERVAL,
  SLEEP_TIMEOUT_MS,
  PREVIEW_RETENTION_MS,
  CLEANUP_INTERVAL_MS,
  MAX_CODE_DISPLAY_LENGTH,
  CLAUDE_CODE_TIMEOUT_MS,
  API_MAX_RETRIES,
  MAX_COLLABORATORS_PER_PROJECT,
  TOKEN_PRICING,
  ERROR_TYPES,
  API_ERROR_MESSAGES,
  ABSOLUTE_BROWSER_RULE,
  log,
};
