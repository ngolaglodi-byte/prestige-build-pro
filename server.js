const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || './prestige-pro.db';
const PREVIEWS_DIR = process.env.PREVIEWS_DIR || '/tmp/previews';

// Docker preview system constants
const DOCKER_PROJECTS_DIR = process.env.DOCKER_PROJECTS_DIR || '/data/projects';
const DOCKER_NETWORK = 'pbp-projects';
const DOCKER_BASE_IMAGE = 'pbp-base';
const DOCKER_HEALTH_TIMEOUT = 15000; // 15 seconds max wait for container health

// In-memory mapping of projectId → containerIP for proxy routing
const containerMapping = new Map();

// Preview system constants
const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT, type TEXT DEFAULT 'info', read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, project_id INTEGER, status TEXT DEFAULT 'building', progress INTEGER DEFAULT 0, message TEXT, url TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS analytics (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, event_type TEXT NOT NULL, event_data TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS project_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version_number INTEGER NOT NULL, generated_code TEXT, screenshot_url TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), message TEXT, FOREIGN KEY(project_id) REFERENCES projects(id));
  `);
  const bcrypt = require('bcryptjs');
  if (!db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
    db.prepare('INSERT INTO users (email,password,name,role) VALUES (?,?,?,?)').run('admin@prestige-build.dev', bcrypt.hashSync('Admin2026!',10), 'Administrateur', 'admin');
  }
} catch(e) { console.error('DB:', e.message); }

// ─── SSE CLIENTS FOR REAL-TIME COLLABORATION ───
const projectSSEClients = new Map(); // Map<projectId, Set<{res, userId, userName}>>

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

// ─── CADDY CUSTOM DOMAIN HELPER ───
async function addCustomDomainToCaddy(customDomain, siteDir) {
  // Add a route for the custom domain in Caddy via its admin API
  // Caddy will automatically provision SSL via Let's Encrypt
  const routeConfig = {
    '@id': `custom-domain-${customDomain.replace(/[^a-z0-9]/gi, '-')}`,
    match: [{ host: [customDomain] }],
    handle: [{
      handler: 'file_server',
      root: siteDir
    }],
    terminal: true
  };
  
  return new Promise((resolve, reject) => {
    const url = new URL(CADDY_ADMIN_API + '/config/apps/http/servers/srv0/routes');
    const options = {
      hostname: url.hostname,
      port: url.port || 2019,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`Custom domain ${customDomain} added to Caddy successfully`);
          resolve({ success: true, domain: customDomain });
        } else {
          console.warn(`Caddy API response: ${res.statusCode} - ${data}`);
          // Don't fail the publish if Caddy config fails - domain can be added later
          resolve({ success: false, domain: customDomain, error: data });
        }
      });
    });
    
    req.on('error', (err) => {
      console.warn(`Could not configure Caddy for ${customDomain}: ${err.message}`);
      // Don't fail the publish if Caddy is not available
      resolve({ success: false, domain: customDomain, error: err.message });
    });
    
    req.write(JSON.stringify(routeConfig));
    req.end();
  });
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
  // Check query string for SSE support
  const urlParts = req.url.split('?');
  if (urlParts.length > 1) {
    const params = new URLSearchParams(urlParts[1]);
    const queryToken = params.get('token');
    if (queryToken) return verifyToken(queryToken);
  }
  return null;
}
function json(res,code,data) { res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(data)); }
function cors(res) { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization'); }
function getBody(req) { return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{r(JSON.parse(b))}catch{r({})}})}); }

// ─── STREAM CLAUDE ───
function streamClaude(messages, res, onDone, brief, options = {}) {
  if (!ANTHROPIC_API_KEY) { res.write(`data: ${JSON.stringify({type:'error',content:'Clé API non configurée sur le serveur.'})}\n\n`); res.end(); return; }
  const baseSystemPrompt = ai ? ai.SYSTEM_PROMPT : 'Tu es un expert en développement professionnel. Génère du code complet et de qualité production.';
  const sectorProfile = ai && brief ? ai.detectSectorProfile(brief) : null;
  
  // Enhanced system prompt with content generation and API integration instructions
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

  // API auto-integration instructions
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

  const systemPrompt = sectorProfile 
    ? `${baseSystemPrompt}${contentGenPrompt}${apiIntegrationPrompt}\n\n${sectorProfile}` 
    : `${baseSystemPrompt}${contentGenPrompt}${apiIntegrationPrompt}`;
    
  const payload = JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:8000, system:systemPrompt, stream:true, messages });
  const opts = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(payload)} };
  const r = https.request(opts, apiRes => {
    let full='';
    apiRes.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d=JSON.parse(line.slice(6));
          if (d.type==='content_block_delta'&&d.delta?.text) { full+=d.delta.text; res.write(`data: ${JSON.stringify({type:'delta',content:d.delta.text})}\n\n`); }
          if (d.type==='message_stop') { res.write(`data: ${JSON.stringify({type:'done'})}\n\n`); res.end(); if(onDone) onDone(full); }
        } catch {}
      }
    });
    apiRes.on('error', e=>{ res.write(`data: ${JSON.stringify({type:'error',content:e.message})}\n\n`); res.end(); });
  });
  r.on('error', e=>{ res.write(`data: ${JSON.stringify({type:'error',content:e.message})}\n\n`); res.end(); });
  r.write(payload); r.end();
}

// ─── STREAM CLAUDE WITH IMAGE (VISION) ───
function streamClaudeWithImage(imageBase64, mediaType, prompt, res, onDone) {
  if (!ANTHROPIC_API_KEY) { res.write(`data: ${JSON.stringify({type:'error',content:'Clé API non configurée sur le serveur.'})}\n\n`); res.end(); return; }
  
  const systemPrompt = `Tu es un expert en développement web professionnel spécialisé dans la reproduction fidèle de designs.

## TA MISSION
Analyse l'image fournie et reproduis FIDÈLEMENT ce design en HTML/CSS/JS moderne, responsive et professionnel.

## INSTRUCTIONS DE REPRODUCTION
1. Analyse la structure visuelle : header, sections, footer, disposition des éléments
2. Identifie la palette de couleurs exacte utilisée
3. Note la typographie et les tailles de police
4. Reproduis les espacements et marges
5. Adapte pour le responsive (mobile-first)

## CODE À GÉNÉRER
- HTML5 sémantique avec structure complète
- CSS moderne (Flexbox/Grid, variables CSS)
- Tailwind CSS pour le styling rapide
- JavaScript pour les interactions si nécessaire
- Images via https://picsum.photos avec dimensions appropriées
- Contenu réaliste et professionnel (jamais de Lorem ipsum)

## FORMAT DE SORTIE
Génère un fichier HTML complet et fonctionnel avec tout le CSS inline ou dans une balise <style>.`;

  const messages = [{
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: imageBase64
        }
      },
      {
        type: 'text',
        text: prompt || "Analyse cette image et reproduis fidèlement ce design en HTML/CSS/JS moderne, responsive, professionnel. Adapte les couleurs, la typographie, la structure et les sections exactement comme dans l'image."
      }
    ]
  }];

  const payload = JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:8000, system:systemPrompt, stream:true, messages });
  const opts = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(payload)} };
  
  const r = https.request(opts, apiRes => {
    let full='';
    apiRes.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d=JSON.parse(line.slice(6));
          if (d.type==='content_block_delta'&&d.delta?.text) { full+=d.delta.text; res.write(`data: ${JSON.stringify({type:'delta',content:d.delta.text})}\n\n`); }
          if (d.type==='message_stop') { res.write(`data: ${JSON.stringify({type:'done'})}\n\n`); res.end(); if(onDone) onDone(full); }
        } catch {}
      }
    });
    apiRes.on('error', e=>{ res.write(`data: ${JSON.stringify({type:'error',content:e.message})}\n\n`); res.end(); });
  });
  r.on('error', e=>{ res.write(`data: ${JSON.stringify({type:'error',content:e.message})}\n\n`); res.end(); });
  r.write(payload); r.end();
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
    files[m[1].trim()] = m[2];
  }

  // Pattern 2: ## filename.ext + code block
  const pattern2 = /##\s+([^\n]+\.[\w]+)\n```(?:\w+)?\n([\s\S]*?)```/g;
  while ((m = pattern2.exec(code)) !== null) {
    if (!files[m[1].trim()]) files[m[1].trim()] = m[2];
  }

  // Pattern 3: **filename.ext** or `filename.ext` + code block
  const pattern3 = /(?:\*\*|`)([^*`\n]+\.[\w]+)(?:\*\*|`)\s*\n```(?:\w+)?\n([\s\S]*?)```/g;
  while ((m = pattern3.exec(code)) !== null) {
    if (!files[m[1].trim()]) files[m[1].trim()] = m[2];
  }

  // If no multi-file found, treat as single file
  if (Object.keys(files).length === 0) {
    // Check for complete HTML document
    const htmlMatch = code.match(/<!DOCTYPE[\s\S]*?<\/html>/i);
    if (htmlMatch) {
      files['index.html'] = htmlMatch[0];
    } else {
      // Extract from single code block
      const single = code.match(/```(?:html|jsx?|tsx?|vue)?\n([\s\S]*?)```/);
      if (single) {
        const content = single[1];
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
        // Last resort: create minimal HTML
        mainHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Preview</title></head><body><pre>${escapeHtml(code.substring(0, 2000))}</pre></body></html>`;
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

// Execute Docker command safely
function execDocker(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 60000, ...options });
  } catch (e) {
    console.error('Docker command failed:', cmd, e.message);
    throw e;
  }
}

// Check if Docker is available
function isDockerAvailable() {
  try {
    execSync('docker --version', { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

// Ensure Docker network exists
function ensureDockerNetwork() {
  try {
    const networks = execDocker('docker network ls --format "{{.Name}}"');
    if (!networks.includes(DOCKER_NETWORK)) {
      execDocker(`docker network create ${DOCKER_NETWORK}`);
      console.log(`Created Docker network: ${DOCKER_NETWORK}`);
    }
  } catch (e) {
    console.error('Failed to ensure Docker network:', e.message);
  }
}

// Get container name for a project
function getContainerName(projectId) {
  return `pbp-project-${projectId}`;
}

// Get container IP address
function getContainerIP(projectId) {
  try {
    const containerName = getContainerName(projectId);
    const ip = execDocker(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`).trim();
    return ip || null;
  } catch (e) {
    return null;
  }
}

// Check if container is running
function isContainerRunning(projectId) {
  try {
    const containerName = getContainerName(projectId);
    const status = execDocker(`docker inspect -f '{{.State.Running}}' ${containerName}`).trim();
    return status === 'true';
  } catch (e) {
    return false;
  }
}

// Stop and remove container
function stopContainer(projectId) {
  const containerName = getContainerName(projectId);
  try {
    execDocker(`docker stop ${containerName}`, { timeout: 10000 });
  } catch (e) {}
  try {
    execDocker(`docker rm ${containerName}`, { timeout: 5000 });
  } catch (e) {}
}

// Remove container image
function removeContainerImage(projectId) {
  const imageName = `pbp-project-${projectId}:latest`;
  try {
    execDocker(`docker rmi ${imageName}`, { timeout: 10000 });
  } catch (e) {}
}

// Get container logs
function getContainerLogs(projectId, tailLines = 100) {
  const containerName = getContainerName(projectId);
  try {
    return execDocker(`docker logs --tail ${tailLines} ${containerName}`, { timeout: 10000 });
  } catch (e) {
    return `Erreur: impossible de récupérer les logs. ${e.message}`;
  }
}

// Restart container
function restartContainer(projectId) {
  const containerName = getContainerName(projectId);
  try {
    execDocker(`docker restart ${containerName}`, { timeout: 30000 });
    // Update IP in mapping after restart
    setTimeout(() => {
      const ip = getContainerIP(projectId);
      if (ip) containerMapping.set(projectId, ip);
    }, 2000);
    return true;
  } catch (e) {
    console.error('Failed to restart container:', e.message);
    return false;
  }
}

// Wait for container to be healthy
async function waitForContainerHealth(projectId, maxWait = DOCKER_HEALTH_TIMEOUT) {
  const startTime = Date.now();
  const ip = getContainerIP(projectId);
  if (!ip) return false;

  while (Date.now() - startTime < maxWait) {
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.get(`http://${ip}:3000/health`, { timeout: 2000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.status === 'ok');
            } catch { resolve(false); }
          });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (response) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
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
    
    // Check if it looks like a filename
    if (firstLine.includes('.') && !firstLine.includes(' ')) {
      const filename = firstLine.replace(/[`*]/g, '').trim();
      // Get content, skipping markdown code block markers
      let content = lines.slice(1).join('\n');
      content = content.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      if (content) {
        files[filename] = content;
      }
    }
  }

  return files;
}

// Build and run Docker container for a project
async function buildDockerProject(projectId, code, onProgress) {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, String(projectId));
  const publicDir = path.join(projectDir, 'public');
  const dataDir = path.join(projectDir, 'data');
  const containerName = getContainerName(projectId);
  const imageName = `pbp-project-${projectId}:latest`;

  try {
    // Step 1: Parse code into files (10%)
    onProgress({ step: 1, progress: 10, message: 'Analyse du code généré...' });
    const files = parseDockerProjectCode(code);
    
    if (Object.keys(files).length === 0) {
      throw new Error('Aucun fichier trouvé dans le code généré. Utilisez les marqueurs ### pour séparer les fichiers.');
    }

    // Create directories
    if (fs.existsSync(projectDir)) {
      // Keep data directory for persistence
      const tmpData = path.join('/tmp', `pbp-data-${projectId}`);
      if (fs.existsSync(dataDir)) {
        try { execSync(`mv ${dataDir} ${tmpData}`); } catch(e) {}
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(publicDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(tmpData)) {
        try { execSync(`mv ${tmpData}/* ${dataDir}/`); } catch(e) {}
        try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch(e) {}
      }
    } else {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(publicDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Step 2: Write all files (30%)
    onProgress({ step: 2, progress: 30, message: 'Écriture des fichiers du projet...' });
    
    for (const [filename, content] of Object.entries(files)) {
      const filePath = path.join(projectDir, filename);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content);
    }

    // Create Dockerfile for the project
    const dockerfile = `FROM ${DOCKER_BASE_IMAGE}
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public/ ./public/
ENV JWT_SECRET=${crypto.randomBytes(16).toString('hex')}
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
`;
    fs.writeFileSync(path.join(projectDir, 'Dockerfile'), dockerfile);

    // Step 3: Stop old container and build new image (50%)
    onProgress({ step: 3, progress: 50, message: 'Construction de l\'environnement...' });
    stopContainer(projectId);
    
    execDocker(`docker build -t ${imageName} ${projectDir}`, { timeout: 120000 });

    // Step 4: Run the container (70%)
    onProgress({ step: 4, progress: 70, message: 'Lancement du projet...' });
    
    const jwtSecret = crypto.randomBytes(32).toString('hex');
    execDocker(`docker run -d --name ${containerName} --network ${DOCKER_NETWORK} --restart unless-stopped -v ${dataDir}:/app/data -e JWT_SECRET=${jwtSecret} -e PORT=3000 ${imageName}`, { timeout: 30000 });

    // Step 5: Wait for health check (90%)
    onProgress({ step: 5, progress: 90, message: 'Vérification du démarrage...' });
    
    const healthy = await waitForContainerHealth(projectId);
    if (!healthy) {
      const logs = getContainerLogs(projectId, 50);
      console.error('Container health check failed. Logs:', logs);
      throw new Error('Le projet ne répond pas. Vérifiez les logs pour plus de détails.');
    }

    // Step 6: Get container IP and update mapping (100%)
    onProgress({ step: 6, progress: 100, message: 'Prêt !' });
    
    const ip = getContainerIP(projectId);
    if (ip) {
      containerMapping.set(projectId, ip);
    }

    return {
      success: true,
      url: `/run/${projectId}/`,
      containerIP: ip
    };

  } catch (e) {
    console.error('Docker build failed:', e.message);
    throw e;
  }
}

// Proxy request to container
function proxyToContainer(req, res, projectId, targetPath) {
  const containerIP = containerMapping.get(projectId);
  
  if (!containerIP) {
    // Try to get IP from Docker
    const ip = getContainerIP(projectId);
    if (ip) {
      containerMapping.set(projectId, ip);
      return proxyToContainer(req, res, projectId, targetPath);
    }
    
    // Return elegant error page
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Projet en cours de démarrage</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      background: linear-gradient(135deg, #0d1120 0%, #1a2744 100%);
      min-height: 100vh; 
      display: flex; 
      align-items: center; 
      justify-content: center;
      color: #e2e8f0;
    }
    .container { text-align: center; padding: 40px; }
    .loader {
      width: 50px; height: 50px;
      border: 4px solid rgba(212, 168, 32, 0.2);
      border-top-color: #D4A820;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.5rem; margin-bottom: 12px; color: #D4A820; }
    p { color: #8896c4; margin-bottom: 20px; }
    .retry { 
      display: inline-block;
      padding: 10px 24px;
      background: #D4A820;
      color: #1a2744;
      border: none;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
    }
    .retry:hover { background: #e5b921; }
  </style>
  <script>setTimeout(() => location.reload(), 5000);</script>
</head>
<body>
  <div class="container">
    <div class="loader"></div>
    <h1>Votre projet démarre...</h1>
    <p>L'environnement se prépare, veuillez patienter quelques instants.</p>
    <a href="javascript:location.reload()" class="retry">Réessayer</a>
  </div>
</body>
</html>`);
    return;
  }

  // Proxy the request
  const options = {
    hostname: containerIP,
    port: 3000,
    path: targetPath || '/',
    method: req.method,
    headers: { ...req.headers, host: `${containerIP}:3000` },
    timeout: 30000
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error('Proxy error:', e.message);
    // Container might have crashed, try to restart
    if (!isContainerRunning(projectId)) {
      restartContainer(projectId);
    }
    // Remove from mapping to force re-lookup
    containerMapping.delete(projectId);
    
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Redémarrage en cours</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      background: linear-gradient(135deg, #0d1120 0%, #1a2744 100%);
      min-height: 100vh; 
      display: flex; 
      align-items: center; 
      justify-content: center;
      color: #e2e8f0;
    }
    .container { text-align: center; padding: 40px; }
    .loader {
      width: 50px; height: 50px;
      border: 4px solid rgba(212, 168, 32, 0.2);
      border-top-color: #D4A820;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.5rem; margin-bottom: 12px; color: #D4A820; }
    p { color: #8896c4; margin-bottom: 20px; }
  </style>
  <script>setTimeout(() => location.reload(), 3000);</script>
</head>
<body>
  <div class="container">
    <div class="loader"></div>
    <h1>Votre projet redémarre automatiquement</h1>
    <p>Un petit souci technique. Nous relançons tout pour vous...</p>
  </div>
</body>
</html>`);
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Le projet met trop de temps à répondre.' }));
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// Rebuild container mapping from database on startup
async function rebuildContainerMapping() {
  if (!db || !isDockerAvailable()) return;
  
  try {
    const projects = db.prepare("SELECT id FROM projects WHERE build_status = 'done'").all();
    console.log(`Rebuilding container mapping for ${projects.length} projects...`);
    
    for (const project of projects) {
      const containerName = getContainerName(project.id);
      
      // Check if container exists and is running
      if (isContainerRunning(project.id)) {
        const ip = getContainerIP(project.id);
        if (ip) {
          containerMapping.set(project.id, ip);
          console.log(`  - Project ${project.id}: ${ip}`);
        }
      } else {
        // Try to start stopped container
        try {
          execDocker(`docker start ${containerName}`, { timeout: 10000 });
          await new Promise(r => setTimeout(r, 2000));
          const ip = getContainerIP(project.id);
          if (ip) {
            containerMapping.set(project.id, ip);
            console.log(`  - Project ${project.id}: ${ip} (restarted)`);
          }
        } catch (e) {
          console.log(`  - Project ${project.id}: container not available`);
        }
      }
    }
    
    console.log(`Container mapping rebuilt: ${containerMapping.size} active containers`);
  } catch (e) {
    console.error('Failed to rebuild container mapping:', e.message);
  }
}

// Initialize Docker system
function initializeDockerSystem() {
  if (!isDockerAvailable()) {
    console.log('Docker not available - Docker preview system disabled');
    return;
  }
  
  console.log('Initializing Docker preview system...');
  ensureDockerNetwork();
  rebuildContainerMapping();
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
  // DOCKER PROXY ROUTE: /run/:projectId/*
  // Proxies requests to isolated Docker containers running project previews
  // ═══════════════════════════════════════════════════════════════════════════
  if (url.startsWith('/run/')) {
    const parts = url.split('/').filter(Boolean); // ['run', 'projectId', ...]
    const projectId = parseInt(parts[1]);
    
    if (!projectId || isNaN(projectId)) {
      json(res, 400, { error: 'ID de projet invalide' });
      return;
    }
    
    // Build the target path (everything after /run/projectId)
    const targetPath = '/' + parts.slice(2).join('/') || '/';
    
    // Proxy to the container
    proxyToContainer(req, res, projectId, targetPath);
    return;
  }

  // Preview refresh endpoint (no auth required for simplicity, but validates project exists)
  if (url.match(/^\/api\/preview\/\d+\/refresh$/) && req.method==='POST') {
    const projectId = parseInt(url.split('/')[3]);
    const body = await getBody(req);
    const code = body.code;
    if (!code) {
      json(res, 400, { error: 'Code required' });
      return;
    }
    try {
      const result = savePreviewFiles(projectId, code);
      json(res, 200, { success: true, previewUrl: `/preview/${projectId}/`, framework: result.framework });
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
    const {email,password}=await getBody(req);
    const bcrypt=require('bcryptjs');
    const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u||!bcrypt.compareSync(password,u.password)) { json(res,401,{error:'Email ou mot de passe incorrect.'}); return; }
    json(res,200,{token:signToken({id:u.id,email:u.email,name:u.name,role:u.role,lang:u.lang}),user:{id:u.id,email:u.email,name:u.name,role:u.role,lang:u.lang}});
    return;
  }

  // ─── ANALYTICS TRACKING (NO AUTH - CALLED BY CLIENT SITES) ───
  if (url.match(/^\/api\/track\/\d+$/) && req.method==='POST') {
    const projectId = parseInt(url.split('/')[3]);
    const body = await getBody(req);
    const { event_type, event_data, page } = body;
    
    if (!event_type) { json(res, 400, { error: 'event_type required' }); return; }
    
    // Store analytics event
    try {
      const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
      const userAgent = req.headers['user-agent'] || '';
      const eventDataStr = event_data ? JSON.stringify({ ...event_data, page }) : JSON.stringify({ page });
      
      db.prepare('INSERT INTO analytics (project_id, event_type, event_data, ip_address, user_agent) VALUES (?,?,?,?,?)').run(
        projectId, event_type, eventDataStr, ipAddress.split(',')[0], userAgent.substring(0, 255)
      );
      json(res, 200, { ok: true });
    } catch(e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  const user=getAuth(req);
  if (!user) { json(res,401,{error:'Non autorisé.'}); return; }

  // ─── GENERATE (STREAMING) ───
  if (url==='/api/generate/stream' && req.method==='POST') {
    const {project_id,message}=await getBody(req);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    let project=null, history=[];
    if (project_id) {
      project=db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
      history=db.prepare('SELECT role,content FROM project_messages WHERE project_id=? ORDER BY id ASC LIMIT 30').all(project_id);
      // Notify other clients that someone is generating
      notifyProjectClients(project_id, 'user_action', { action: 'generating', userName: user.name }, user.id);
    }
    const savedApis=db.prepare('SELECT name,service,description FROM api_keys').all();
    const userMsg=ai?ai.buildProfessionalPrompt(message,project,savedApis):message;
    const messages=ai?ai.buildConversationContext(project,history,userMsg):[{role:'user',content:userMsg}];
    if (project_id) db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id,'user',message);
    const brief = project?.brief || message;
    streamClaude(messages, res, full=>{
      if (project_id) {
        db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id,'assistant',full);
        db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready',version=version+1 WHERE id=?").run(full,project_id);
        // Save version history
        saveProjectVersion(project_id, full, user.id, `Génération via chat: ${message.substring(0,50)}...`);
        // Auto-save preview files after generation
        try {
          const previewResult = savePreviewFiles(project_id, full);
          res.write(`data: ${JSON.stringify({type:'preview_ready',previewUrl:`/preview/${project_id}/`,framework:previewResult.framework})}\n\n`);
        } catch(e) {
          console.error('Preview save error:', e.message);
        }
        // Notify other clients about the new code
        notifyProjectClients(project_id, 'code_updated', { 
          userName: user.name, 
          previewUrl: `/preview/${project_id}/`,
          message: `${user.name} a généré une nouvelle version`
        }, user.id);
      }
    }, brief); return;
  }

  // ─── GENERATE FROM IMAGE (STREAMING) ───
  if (url==='/api/generate/image' && req.method==='POST') {
    const body = await getBody(req);
    const { project_id, image_base64, media_type, prompt } = body;
    if (!image_base64) { json(res, 400, { error: 'Image requise' }); return; }
    
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    
    let project = null;
    if (project_id) {
      project = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
      db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id,'user','[Image uploadée pour reproduction de design]');
      // Notify other clients
      notifyProjectClients(project_id, 'user_action', { action: 'generating_from_image', userName: user.name }, user.id);
    }
    
    const imagePrompt = prompt || "Analyse cette image et reproduis fidèlement ce design en HTML/CSS/JS moderne, responsive, professionnel. Adapte les couleurs, la typographie, la structure et les sections exactement comme dans l'image.";
    
    streamClaudeWithImage(image_base64, media_type || 'image/png', imagePrompt, res, full => {
      if (project_id) {
        db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id,'assistant',full);
        db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready',version=version+1 WHERE id=?").run(full,project_id);
        // Save version history
        saveProjectVersion(project_id, full, user.id, 'Génération depuis image');
        // Auto-save preview files
        try {
          const previewResult = savePreviewFiles(project_id, full);
          res.write(`data: ${JSON.stringify({type:'preview_ready',previewUrl:`/preview/${project_id}/`,framework:previewResult.framework})}\n\n`);
        } catch(e) {
          console.error('Preview save error:', e.message);
        }
        // Notify other clients
        notifyProjectClients(project_id, 'code_updated', { 
          userName: user.name, 
          previewUrl: `/preview/${project_id}/`,
          message: `${user.name} a généré un design depuis une image`
        }, user.id);
      }
    });
    return;
  }

  // ─── COMPILE (DOCKER ISOLATED PREVIEW) ───
  if (url==='/api/compile' && req.method==='POST') {
    const {project_id, mode}=await getBody(req);
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project?.generated_code) { json(res,400,{error:'Générez le code d\'abord.'}); return; }
    
    const buildId=crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO builds (id,project_id,status,progress,message) VALUES (?,?,?,?,?)').run(buildId,project_id,'building',0,'Démarrage...');
    db.prepare("UPDATE projects SET build_id=?,build_status='building' WHERE id=?").run(buildId,project_id);
    json(res,200,{buildId});
    
    // Check if Docker is available for isolated preview
    if (isDockerAvailable() && mode !== 'legacy') {
      // Docker isolated preview system
      const friendly = {
        1: 'Analyse du code généré...',
        2: 'Écriture des fichiers du projet...',
        3: 'Construction de l\'environnement...',
        4: 'Lancement du projet...',
        5: 'Vérification du démarrage...',
        6: 'Prêt !'
      };
      
      buildDockerProject(project_id, project.generated_code, (p) => {
        db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress, friendly[p.step] || p.message || 'Construction en cours...', buildId);
      }).then(result => {
        if (result.success) {
          db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(result.url, buildId);
          db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(result.url, project_id);
          db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id, `Projet "${project.title}" prêt à explorer !`, 'success');
        } else {
          db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run('Une erreur est survenue. Vérifiez les logs.', buildId);
          db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
        }
      }).catch(err => {
        console.error('Docker build error:', err.message);
        db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run('Erreur: ' + (err.message || 'Construction échouée'), buildId);
        db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
      });
    } else if (compiler) {
      // Legacy compiler fallback
      const friendly = {1:'Analyse et organisation du projet...',2:'Mise en place des composants...',3:'Application du design et des styles...',4:'Optimisation et finalisation...',5:'Vérification du résultat...',6:'Prêt !'};
      compiler.buildProject(buildId,project.generated_code,p=>{
        db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress, friendly[p.step]||'Construction en cours...', buildId);
      }).then(result=>{
        if (result.success) {
          const url2=`/preview/${buildId}/`;
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
    json(res,build?200:404,build||{error:'Build non trouvé.'}); return;
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
    const {title,client_name,brief,subdomain,domain,apis,notes,generated_code,status}=await getBody(req);
    db.prepare("UPDATE projects SET title=COALESCE(?,title),client_name=COALESCE(?,client_name),brief=COALESCE(?,brief),subdomain=COALESCE(?,subdomain),domain=COALESCE(?,domain),apis=COALESCE(?,apis),notes=COALESCE(?,notes),generated_code=COALESCE(?,generated_code),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=?").run(title,client_name,brief,subdomain,domain,apis?JSON.stringify(apis):null,notes,generated_code,status,id);
    json(res,200,{ok:true}); return;
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
    
    const subdomain = p.subdomain || `project-${id}`;
    
    // Copy preview files to sites directory
    try {
      const previewDir = path.join(PREVIEWS_DIR, String(id));
      if (!fs.existsSync(previewDir)) {
        // Try to create preview from generated code
        if (p.generated_code) {
          savePreviewFiles(id, p.generated_code);
        } else {
          json(res, 400, { error: 'Aucun code à publier.' }); return;
        }
      }
      
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
    
    // Delete all related records
    db.prepare('DELETE FROM project_messages WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project_versions WHERE project_id=?').run(id);
    db.prepare('DELETE FROM analytics WHERE project_id=?').run(id);
    db.prepare('DELETE FROM builds WHERE project_id=?').run(id);
    db.prepare('DELETE FROM projects WHERE id=?').run(id);
    
    // Clean up preview files
    const previewDir = path.join(PREVIEWS_DIR, String(id));
    if (fs.existsSync(previewDir)) {
      try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch(e) { console.warn('Preview cleanup error:', e.message); }
    }
    
    // Clean up Docker container and image
    if (isDockerAvailable()) {
      try {
        stopContainer(id);
        removeContainerImage(id);
        containerMapping.delete(id);
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
    
    const logs = getContainerLogs(id, 100);
    json(res, 200, { logs, container: getContainerName(id), running: isContainerRunning(id) });
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
    
    const success = restartContainer(id);
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

server.listen(PORT, ()=>{
  console.log(`Prestige Build Pro on port ${PORT}`);
  console.log(`API: ${ANTHROPIC_API_KEY?'OK':'MISSING'} | Compiler: ${compiler?'OK':'N/A'}`);
  
  // Initialize Docker preview system
  initializeDockerSystem();
});
