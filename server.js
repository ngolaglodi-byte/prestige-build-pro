const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || './prestige-pro.db';

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
function streamClaude(messages, res, onDone) {
  if (!ANTHROPIC_API_KEY) { res.write(`data: ${JSON.stringify({type:'error',content:'Clé API non configurée sur le serveur.'})}\n\n`); res.end(); return; }
  const systemPrompt = ai ? ai.SYSTEM_PROMPT : 'Tu es un expert en développement professionnel. Génère du code complet et de qualité production.';
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

// ─── SERVER ───
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method==='OPTIONS') { res.writeHead(200); res.end(); return; }
  const url = req.url.split('?')[0];

  // Serve compiled preview files
  if (url.startsWith('/preview/')) {
    const parts = url.split('/').filter(Boolean);
    serveBuilt(res, parts[1], parts.slice(2).join('/'));
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
    streamClaude(messages, res, full=>{
      if (project_id) {
        db.prepare('INSERT INTO project_messages (project_id,role,content) VALUES (?,?,?)').run(project_id,'assistant',full);
        db.prepare("UPDATE projects SET generated_code=?,updated_at=datetime('now'),status='ready',version=version+1 WHERE id=?").run(full,project_id);
      }
    }); return;
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
