/**
 * File Operations — defaults, templates, parsing, content cleaning
 * Extracted from server.js lines 224-500, 574-856, 6598-6730
 */
const fs = require('fs');
const path = require('path');

module.exports = function(ctx) {
  // ─── DEFAULT FILES ───
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

  // ─── PREVIEW URL ───
  function getPreviewUrl(projectId) {
    const PUBLISH_DOMAIN = ctx.config.PUBLISH_DOMAIN || process.env.PUBLISH_DOMAIN || 'prestige-build.dev';
    const subdomainUrl = `https://preview-${projectId}.${PUBLISH_DOMAIN}`;
    const pathUrl = `/run/${projectId}/`;
    return { subdomain: subdomainUrl, path: pathUrl, preferred: subdomainUrl };
  }

  // ─── CADDY CUSTOM DOMAIN HELPER ───
  async function addCustomDomainToCaddy(customDomain, siteDir) {
    console.log(`[Custom Domain] ${customDomain} configured — route via server.js Host header detection`);
    return { success: true, domain: customDomain };
  }

  // ─── CLAUDE.MD TEMPLATE GENERATOR ───
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
`;
  }

  // ─── READ PROJECT FILES ───
  function readProjectFilesRecursive(projectDir) {
    const files = {};
    const validNames = ['package.json', 'vite.config.js', 'index.html', 'server.js'];
    const validDirs = ['src/components', 'src/components/ui', 'src/pages', 'src/styles', 'src/lib', 'src/hooks', 'src/context'];
    const validSrcFiles = ['src/main.tsx', 'src/index.css', 'src/App.tsx'];

    for (const name of validNames) {
      const p = path.join(projectDir, name);
      if (fs.existsSync(p)) files[name] = fs.readFileSync(p, 'utf8');
    }

    if (!files['index.html']) {
      const legacyIndex = path.join(projectDir, 'public', 'index.html');
      if (fs.existsSync(legacyIndex)) {
        const content = fs.readFileSync(legacyIndex, 'utf8');
        if (content.includes('id="root"')) files['index.html'] = content;
      }
    }

    for (const name of validSrcFiles) {
      const p = path.join(projectDir, name);
      if (fs.existsSync(p)) files[name] = fs.readFileSync(p, 'utf8');
    }

    for (const dir of validDirs) {
      const dirPath = path.join(projectDir, dir);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
          if (entry.endsWith('.tsx') || entry.endsWith('.ts') || entry.endsWith('.jsx') || entry.endsWith('.js') || entry.endsWith('.css')) {
            const relativePath = `${dir}/${entry}`;
            const fullPath = path.join(dirPath, entry);
            if (fs.statSync(fullPath).isFile()) files[relativePath] = fs.readFileSync(fullPath, 'utf8');
          }
        }
      }
    }

    return files;
  }

  // ─── FORMAT PROJECT CODE ───
  function formatProjectCode(files) {
    const fileOrder = ['package.json', 'vite.config.js', 'index.html', 'server.js', 'src/main.tsx', 'src/index.css', 'src/App.tsx'];
    let result = '';
    const written = new Set();
    for (const fn of fileOrder) {
      if (files[fn]) { result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`; written.add(fn); }
    }
    const remaining = Object.keys(files).filter(fn => !written.has(fn)).sort((a, b) => {
      const order = (f) => f.startsWith('src/components/') ? 0 : f.startsWith('src/pages/') ? 1 : 2;
      return order(a) - order(b) || a.localeCompare(b);
    });
    for (const fn of remaining) { result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`; }
    return result;
  }

  // ─── WRITE DEFAULT REACT PROJECT ───
  // Will be set via setDeps to get safeWriteTsx
  let safeWriteTsx;
  function setDeps(deps) {
    if (deps.safeWriteTsx) safeWriteTsx = deps.safeWriteTsx;
  }

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
        if (safeWriteTsx && (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx"))) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
        console.log(`[Defaults] Wrote default ${filename}`);
      }
    }

    const templateUiDir = path.join(__dirname, '..', '..', 'templates', 'react', 'src');
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
            needsRestore = true;
          } else {
            try {
              const content = fs.readFileSync(destFile, 'utf8');
              if (content.trim().length < 20 || (!content.includes('export ') && !content.includes('module.exports'))) needsRestore = true;
            } catch (_) { needsRestore = true; }
          }
          if (needsRestore) { fs.copyFileSync(srcFile, destFile); restored++; } else { trusted++; }
        }
      }
    }
    if (restored > 0 || trusted > 0) {
      console.log(`[Defaults] UI files: ${restored} restored (missing/broken), ${trusted} trusted (AI-customized OK)`);
    }
  }

  // ─── EXTRACT CREDENTIALS ───
  function extractCredentials(code) {
    if (!code) return null;
    const match = code.match(/\/\/\s*CREDENTIALS:\s*email=(\S+)\s+password=(\S+)/);
    if (match) return { email: match[1], password: match[2] };
    return null;
  }

  // ─── CLEAN GENERATED CONTENT ───
  function cleanGeneratedContent(content) {
    if (!content) return '';
    let cleaned = content;
    cleaned = cleaned.replace(/^```(?:javascript|js|json|html|css|jsx|tsx|typescript|ts|bash|sh|sql|yaml|yml|xml|text|txt|plain)?\s*$/gm, '');
    cleaned = cleaned.replace(/^`{3,}.*$/gm, '');
    cleaned = cleaned.replace(/\n*SUGGESTIONS:[\s\S]*$/m, '');
    const firstCodeLine = cleaned.search(/^(?:import |export |const |let |var |function |class |\/\/|\/\*|<|'use strict')/m);
    if (firstCodeLine > 0) cleaned = cleaned.substring(firstCodeLine);
    const lastBrace = cleaned.lastIndexOf('}');
    const lastSemicolon = cleaned.lastIndexOf(';');
    const lastCodeChar = Math.max(lastBrace, lastSemicolon);
    if (lastCodeChar > 0) {
      const after = cleaned.substring(lastCodeChar + 1).trim();
      if (after.length > 0 && /[a-zA-ZÀ-ÿ]/.test(after)) cleaned = cleaned.substring(0, lastCodeChar + 1) + '\n';
    }
    cleaned = cleaned.replace(/require\(['"]sqlite3['"]\)\.verbose\(\)/g, "require('better-sqlite3')");
    cleaned = cleaned.replace(/require\(['"]sqlite3['"]\)/g, "require('better-sqlite3')");
    cleaned = cleaned.replace(/new sqlite3\.Database\(/g, "new (require('better-sqlite3'))(");
    cleaned = cleaned.replace(/require\(['"]bcrypt['"]\)/g, "require('bcryptjs')");
    cleaned = cleaned.replace(/app\.get\(\s*['"](\*|\/\*)['"]\s*,/g, "app.get(/.*/,");
    cleaned = cleaned.replace(/app\.use\(\s*['"](\*|\/\*)['"]\s*,/g, "app.use(/.*/,");
    cleaned = cleaned.replace(/router\.get\(\s*['"](\*|\/\*)['"]\s*,/g, "router.get(/.*/,");
    cleaned = cleaned.replace(/router\.use\(\s*['"](\*|\/\*)['"]\s*,/g, "router.use(/.*/,");
    cleaned = cleaned.replace(/"express"\s*:\s*"\^?5[^"]*"/g, '"express": "4.18.2"');
    const pinDeps = ['express', 'better-sqlite3', 'bcryptjs', 'jsonwebtoken', 'cors', 'helmet', 'compression'];
    for (const dep of pinDeps) {
      cleaned = cleaned.replace(new RegExp(`"${dep}"\\s*:\\s*"\\^`, 'g'), `"${dep}": "`);
    }
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    cleaned = cleaned.trim();
    return cleaned;
  }

  // ─── STRIP CODE ARTIFACTS ───
  function stripCodeArtifacts(code) {
    if (!code) return '';
    let cleaned = code.replace(/^[\s\S]*?(?=### )/, '');
    cleaned = cleaned.replace(/\n*SUGGESTIONS:[\s\S]*$/, '');
    cleaned = cleaned.replace(/\n+(?:N'hésitez|N'hésite|Voilà|Les modifications|Si vous|C'est fait|Bonne continuation)[\s\S]*$/, '');
    return cleaned.trim();
  }

  // ─── VALIDATE REACT INDEX HTML ───
  function validateReactIndexHtml(projectDir) {
    const indexPath = path.join(projectDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      console.log(`[Validate] index.html missing — writing default`);
      fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML);
      return true;
    }
    let html = fs.readFileSync(indexPath, 'utf8');
    let changed = false;
    if (!html.includes('id="root"')) {
      console.warn(`[Validate] index.html missing <div id="root"> — fixing`);
      if (html.includes('<body>')) { html = html.replace('<body>', '<body>\n  <div id="root"></div>'); changed = true; }
      else { fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML); return true; }
    }
    if (!html.includes('src="/src/main.tsx"') && !html.includes("src='/src/main.jsx'")) {
      console.warn(`[Validate] index.html missing main.jsx entry — fixing`);
      if (html.includes('</body>')) { html = html.replace('</body>', '  <script type="module" src="/src/main.tsx"></script>\n</body>'); changed = true; }
    }
    if (!html.includes('</html>')) { html += '\n</html>'; changed = true; }
    if (changed) { fs.writeFileSync(indexPath, html); console.log(`[Validate] index.html repaired`); }
    return true;
  }

  // ─── PARSE DOCKER PROJECT CODE ───
  function parseDockerProjectCode(code) {
    const files = {};
    if (!code) return files;
    const sections = code.split(/###\s+/);
    for (const section of sections) {
      if (!section.trim()) continue;
      const lines = section.split('\n');
      const firstLine = lines[0].trim();
      if (firstLine.includes('.') && !firstLine.includes('  ')) {
        let filename = firstLine.replace(/[`*]/g, '').trim();
        let content = lines.slice(1).join('\n');
        content = cleanGeneratedContent(content);
        if (filename === 'public/index.html' && content.includes('id="root"')) filename = 'index.html';
        const { isValidProjectFile } = ctx.services.codeQuality || {};
        if (content && isValidProjectFile && isValidProjectFile(filename)) files[filename] = content;
        else if (content) files[filename] = content;
      }
    }
    return files;
  }

  // ─── DEPRECATED STREAM FUNCTIONS ───
  function streamClaude(messages, res, onDone, brief, options = {}) {
    console.warn('[streamClaude] Deprecated: This function should not be used for project generation. Use Claude Code instead.');
    res.write(`data: ${JSON.stringify({type:'info',content:'Utilisation de Claude Code pour la génération...'})}\n\n`);
    res.write(`data: ${JSON.stringify({type:'done'})}\n\n`);
    res.end();
    if (onDone) onDone('');
  }

  function streamClaudeWithImage(imageBase64, mediaType, prompt, res, onDone) {
    console.warn('[streamClaudeWithImage] Deprecated: This function should not be used for project generation. Use Claude Code instead.');
    res.write(`data: ${JSON.stringify({type:'info',content:'Utilisation de Claude Code pour la génération...'})}\n\n`);
    res.write(`data: ${JSON.stringify({type:'done'})}\n\n`);
    res.end();
    if (onDone) onDone('');
  }

  return {
    DEFAULT_PACKAGE_JSON,
    DEFAULT_SERVER_JS,
    DEFAULT_INDEX_HTML,
    DEFAULT_VITE_CONFIG,
    DEFAULT_MAIN_JSX,
    DEFAULT_INDEX_CSS,
    DEFAULT_APP_JSX,
    getPreviewUrl,
    addCustomDomainToCaddy,
    generateClaudeMdTemplate,
    readProjectFilesRecursive,
    formatProjectCode,
    writeDefaultReactProject,
    extractCredentials,
    cleanGeneratedContent,
    stripCodeArtifacts,
    validateReactIndexHtml,
    parseDockerProjectCode,
    streamClaude,
    streamClaudeWithImage,
    setDeps
  };
};
