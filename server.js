const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || './prestige-pro.db';
const PREVIEWS_DIR = process.env.PREVIEWS_DIR || '/tmp/previews';

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
  `);
  const bcrypt = require('bcryptjs');
  if (!db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
    db.prepare('INSERT INTO users (email,password,name,role) VALUES (?,?,?,?)').run('admin@prestige-build.dev', bcrypt.hashSync('Admin2026!',10), 'Administrateur', 'admin');
  }
} catch(e) { console.error('DB:', e.message); }

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
function getAuth(req) { return verifyToken((req.headers['authorization']||'').replace('Bearer ','')); }
function json(res,code,data) { res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(data)); }
function cors(res) { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization'); }
function getBody(req) { return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{r(JSON.parse(b))}catch{r({})}})}); }

// ─── STREAM CLAUDE ───
function streamClaude(messages, res, onDone, brief) {
  if (!ANTHROPIC_API_KEY) { res.write(`data: ${JSON.stringify({type:'error',content:'Clé API non configurée sur le serveur.'})}\n\n`); res.end(); return; }
  const baseSystemPrompt = ai ? ai.SYSTEM_PROMPT : 'Tu es un expert en développement professionnel. Génère du code complet et de qualité production.';
  const sectorProfile = ai && brief ? ai.detectSectorProfile(brief) : null;
  const systemPrompt = sectorProfile ? `${baseSystemPrompt}\n\n${sectorProfile}` : baseSystemPrompt;
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
        // Auto-save preview files after generation
        try {
          const previewResult = savePreviewFiles(project_id, full);
          res.write(`data: ${JSON.stringify({type:'preview_ready',previewUrl:`/preview/${project_id}/`,framework:previewResult.framework})}\n\n`);
        } catch(e) {
          console.error('Preview save error:', e.message);
        }
      }
    }, brief); return;
  }

  // ─── COMPILE ───
  if (url==='/api/compile' && req.method==='POST') {
    const {project_id}=await getBody(req);
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project?.generated_code) { json(res,400,{error:'Générez le code d\'abord.'}); return; }
    if (!compiler) { json(res,503,{error:'Moteur de compilation non disponible.'}); return; }
    const buildId=crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO builds (id,project_id,status,progress,message) VALUES (?,?,?,?,?)').run(buildId,project_id,'building',0,'Démarrage...');
    db.prepare("UPDATE projects SET build_id=?,build_status='building' WHERE id=?").run(buildId,project_id);
    json(res,200,{buildId});
    // Friendly step messages — no technical terms shown to agents
    const friendly = {1:'Analyse et organisation du projet...',2:'Mise en place des composants...',3:'Application du design et des styles...',4:'Optimisation et finalisation...',5:'Vérification du résultat...',6:'Prêt !'};
    // Async build
    compiler.buildProject(buildId,project.generated_code,p=>{
      db.prepare('UPDATE builds SET progress=?,message=? WHERE id=?').run(p.progress, friendly[p.step]||'Construction en cours...', buildId);
    }).then(result=>{
      if (result.success) {
        const url2=`/preview/${buildId}/`;
        db.prepare("UPDATE builds SET status='done',progress=100,url=?,message='Prêt !' WHERE id=?").run(url2,buildId);
        db.prepare("UPDATE projects SET build_status='done',build_url=? WHERE id=?").run(url2,project_id);
        db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(project.user_id,`Projet "${project.title}" prêt à explorer !`, 'success');
      } else {
        // Clean error — never expose npm/vite details
        const cleanErr = 'Une correction est nécessaire. Utilisez le chat pour ajuster le projet.';
        db.prepare("UPDATE builds SET status='error',message=? WHERE id=?").run(cleanErr,buildId);
        db.prepare("UPDATE projects SET build_status='error' WHERE id=?").run(project_id);
      }
    }); return;
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
  if (url.match(/^\/api\/projects\/\d+\/publish$/) && req.method==='POST') {
    if (user.role!=='admin') { json(res,403,{error:'Admin seulement.'}); return; }
    const id=parseInt(url.split('/')[3]);
    db.prepare("UPDATE projects SET is_published=1,status='published',updated_at=datetime('now') WHERE id=?").run(id);
    const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(p.user_id,`Projet "${p.title}" publié !`,'success');
    json(res,200,{ok:true}); return;
  }
  if (url.match(/^\/api\/projects\/\d+$/) && req.method==='DELETE') {
    if (user.role!=='admin') { json(res,403,{error:'Interdit.'}); return; }
    const id=parseInt(url.split('/').pop());
    db.prepare('DELETE FROM project_messages WHERE project_id=?').run(id);
    db.prepare('DELETE FROM projects WHERE id=?').run(id);
    json(res,200,{ok:true}); return;
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
});
