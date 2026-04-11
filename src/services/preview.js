/**
 * Preview Engine — serve built files, parse multi-file code, detect framework
 * Extracted from server.js lines 5870-6245
 */
const fs = require('fs');
const path = require('path');

module.exports = function(ctx) {
  let cleanGeneratedContent, safeWriteTsx, isPathSafe;

  function setDeps(deps) {
    cleanGeneratedContent = deps.cleanGeneratedContent;
    safeWriteTsx = deps.safeWriteTsx;
    isPathSafe = deps.isPathSafe;
  }

  const MIME_TYPES = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.jsx': 'application/javascript', '.ts': 'application/javascript', '.tsx': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.map': 'application/json',
    '.xml': 'application/xml', '.txt': 'text/plain', '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
  };

  // ─── SERVE BUILT FILES ───
  function serveBuilt(res, buildId, filePath) {
    let compiler;
    try { compiler = require('../compiler'); } catch(e) {}
    const buildDir = compiler?.getBuiltFiles(buildId);
    if (!buildDir) { res.writeHead(404); res.end('Build not found'); return; }
    const clean = (filePath||'index.html').replace(/\.\./g,'').replace(/^\//,'') || 'index.html';
    const full = path.join(buildDir, clean);
    if (isPathSafe && !isPathSafe(buildDir, full)) { res.writeHead(403); res.end('Access denied'); return; }
    if (!fs.existsSync(full)) {
      const idx = path.join(buildDir,'index.html');
      if (fs.existsSync(idx)) { res.writeHead(200,{'Content-Type':'text/html','Access-Control-Allow-Origin':'*'}); res.end(fs.readFileSync(idx)); return; }
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(full);
    const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
    res.writeHead(200,{'Content-Type':mime[ext]||'text/plain','Access-Control-Allow-Origin':'*'});
    res.end(fs.readFileSync(full));
  }

  // ─── PARSE MULTI-FILE CODE ───
  function parseMultiFileCode(code) {
    const files = {};
    if (!code) return files;
    const pattern1 = /###\s+([^\n]+\.[\w]+)\n```(?:\w+)?\n([\s\S]*?)```/g;
    let m;
    while ((m = pattern1.exec(code)) !== null) files[m[1].trim()] = cleanGeneratedContent(m[2]);
    const pattern2 = /##\s+([^\n]+\.[\w]+)\n```(?:\w+)?\n([\s\S]*?)```/g;
    while ((m = pattern2.exec(code)) !== null) { if (!files[m[1].trim()]) files[m[1].trim()] = cleanGeneratedContent(m[2]); }
    const pattern3 = /(?:\*\*|`)([^*`\n]+\.[\w]+)(?:\*\*|`)\s*\n```(?:\w+)?\n([\s\S]*?)```/g;
    while ((m = pattern3.exec(code)) !== null) { if (!files[m[1].trim()]) files[m[1].trim()] = cleanGeneratedContent(m[2]); }
    const pattern4 = /###\s+([^\n]+\.[\w]+)\n(?!```)([\s\S]*?)(?=###\s+[^\n]+\.[\w]+|$)/g;
    while ((m = pattern4.exec(code)) !== null) {
      if (!files[m[1].trim()]) { const content = cleanGeneratedContent(m[2]); if (content) files[m[1].trim()] = content; }
    }
    if (Object.keys(files).length === 0) {
      const htmlMatch = code.match(/<!DOCTYPE[\s\S]*?<\/html>/i);
      if (htmlMatch) { files['index.html'] = cleanGeneratedContent(htmlMatch[0]); }
      else {
        const single = code.match(/```(?:html|jsx?|tsx?|vue)?\n([\s\S]*?)```/);
        if (single) {
          const content = cleanGeneratedContent(single[1]);
          if (content.includes('<!DOCTYPE') || content.includes('<html')) files['index.html'] = content;
          else files['App.jsx'] = content;
        }
      }
    }
    return files;
  }

  function detectFramework(code) {
    const c = code.toLowerCase();
    if (c.includes('react.createelement') || c.includes('reactdom') || c.includes('usestate(') || c.includes('useeffect(')) return 'react-cdn';
    if (c.includes('vue.createapp') || c.includes('v-bind') || c.includes('v-model') || c.includes('@click')) return 'vue-cdn';
    if (c.includes('from "react"') || c.includes("from 'react'")) return 'react';
    if (c.includes('from "vue"') || c.includes("from 'vue'")) return 'vue';
    if (c.includes('<!doctype') || c.includes('<html')) return 'html';
    return 'html';
  }

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

  function savePreviewFiles(projectId, code) {
    const previewDir = path.join(ctx.config.PREVIEWS_DIR, String(projectId));
    if (fs.existsSync(previewDir)) fs.rmSync(previewDir, { recursive: true, force: true });
    fs.mkdirSync(previewDir, { recursive: true });

    const files = parseMultiFileCode(code);
    const framework = detectFramework(code);
    let mainHtml = files['index.html'];
    if (!mainHtml) {
      if (framework === 'react-cdn' && files['App.jsx']) mainHtml = wrapReactCDN(files['App.jsx']);
      else if (framework === 'vue-cdn') {
        const vueCode = files['App.vue'] || files['app.js'] || Object.values(files)[0];
        if (vueCode) mainHtml = wrapVueCDN(vueCode);
      } else if (Object.keys(files).length > 0) {
        const jsxFile = Object.entries(files).find(([k]) => k.endsWith('.jsx') || k.endsWith('.js'));
        if (jsxFile) mainHtml = wrapReactCDN(jsxFile[1]);
      }
      if (!mainHtml) {
        const htmlMatch = code.match(/<!DOCTYPE[\s\S]*?<\/html>/i);
        if (htmlMatch) mainHtml = htmlMatch[0];
        else {
          const codeLength = code.length;
          const MAX_CODE_DISPLAY_LENGTH = ctx.config.MAX_CODE_DISPLAY_LENGTH || 50000;
          const truncatedCode = codeLength > MAX_CODE_DISPLAY_LENGTH ? code.substring(0, MAX_CODE_DISPLAY_LENGTH) + '\n\n... (code truncated, ' + codeLength + ' chars total)' : code;
          mainHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Preview</title><style>body{font-family:monospace;padding:20px;background:#1a1a2e;color:#e2e8f0;} pre{white-space:pre-wrap;word-wrap:break-word;}</style></head><body><h2 style="color:#D4A820;">Code généré</h2><p style="color:#8896c4;">Le code ne contient pas de HTML valide. Voici le contenu brut :</p><pre>' + escapeHtml(truncatedCode) + '</pre></body></html>';
        }
      }
    }
    mainHtml = injectErrorConsole(mainHtml);
    fs.writeFileSync(path.join(previewDir, 'index.html'), mainHtml);
    for (const [filename, content] of Object.entries(files)) {
      if (filename === 'index.html') continue;
      const filePath = path.join(previewDir, filename);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (safeWriteTsx && (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx"))) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
    }
    return { success: true, dir: previewDir, framework, fileCount: Object.keys(files).length + 1 };
  }

  // ─── CLIENT LOGS ───
  const CLIENT_LOG_MAX = 100;

  function addClientLog(projectId, level, message) {
    if (!projectId) return;
    const key = String(projectId);
    if (!ctx.clientLogs.has(key)) ctx.clientLogs.set(key, []);
    const logs = ctx.clientLogs.get(key);
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
    if (html.includes('</head>')) return html.replace('</head>', errorScript + '</head>');
    else if (html.includes('<body')) return html.replace(/<body([^>]*)>/, '<body$1>' + errorScript);
    else return errorScript + html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function servePreview(res, projectId, filePath) {
    const previewDir = path.join(ctx.config.PREVIEWS_DIR, String(projectId));
    if (!fs.existsSync(previewDir)) { res.writeHead(404); res.end('Preview not found. Generate code first.'); return; }
    const clean = (filePath || 'index.html').replace(/\.\./g, '').replace(/^\//, '') || 'index.html';
    const fullPath = path.join(previewDir, clean);
    if (isPathSafe && !isPathSafe(previewDir, fullPath)) { res.writeHead(403); res.end('Access denied.'); return; }
    if (!fs.existsSync(fullPath)) {
      const indexPath = path.join(previewDir, 'index.html');
      if (fs.existsSync(indexPath)) { res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }); res.end(fs.readFileSync(indexPath)); return; }
      res.writeHead(404); res.end('File not found'); return;
    }
    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(fullPath));
  }

  function cleanOldPreviews() {
    try {
      const PREVIEWS_DIR = ctx.config.PREVIEWS_DIR;
      if (!fs.existsSync(PREVIEWS_DIR)) return;
      const dirs = fs.readdirSync(PREVIEWS_DIR);
      const now = Date.now();
      const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
      dirs.forEach(dir => {
        const full = path.join(PREVIEWS_DIR, dir);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > PREVIEW_RETENTION_MS) fs.rmSync(full, { recursive: true, force: true });
        } catch(e) {}
      });
    } catch(e) {}
  }

  return {
    serveBuilt,
    parseMultiFileCode,
    detectFramework,
    wrapReactCDN,
    wrapVueCDN,
    savePreviewFiles,
    addClientLog,
    injectErrorConsole,
    escapeHtml,
    servePreview,
    cleanOldPreviews,
    setDeps
  };
};
