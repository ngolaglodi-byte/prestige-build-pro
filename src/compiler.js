const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUILDS_DIR = process.env.BUILDS_DIR || '/tmp/pb-builds';
const DOMAIN = process.env.DOMAIN || 'prestige-build.dev';

// Ensure builds directory exists
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

// ─── DETECT PROJECT TYPE FROM CODE ───
function detectType(code) {
  const c = code.toLowerCase();
  if (c.includes('from "next/') || c.includes("from 'next/")) return 'nextjs';
  if (c.includes('from "react"') || c.includes("from 'react'") || c.includes('import react') || c.includes('usestate(') || c.includes('useeffect(')) return 'react';
  if (c.includes('from "vue"') || c.includes("from 'vue'") || c.includes('createapp(')) return 'vue';
  if (c.includes('express()') || c.includes('fastapi') || c.includes('flask') || c.includes('from "hono"')) return 'backend';
  if (c.includes('<!doctype') || c.includes('<html')) return 'html';
  return 'react'; // default to react for unknown
}

// ─── EXTRACT FILES FROM CLAUDE OUTPUT ───
function extractFiles(code) {
  const files = {};

  // Try ### filename.ext\n```lang\ncode\n``` pattern
  const pattern = /###\s+([^\n]+\.[\w]+)\n```(?:\w+)?\n([\s\S]*?)```/g;
  let m;
  while ((m = pattern.exec(code)) !== null) {
    files[m[1].trim()] = m[2];
  }

  // Try ## filename.ext pattern
  const pattern2 = /##\s+([^\n]+\.[\w]+)\n```(?:\w+)?\n([\s\S]*?)```/g;
  while ((m = pattern2.exec(code)) !== null) {
    if (!files[m[1].trim()]) files[m[1].trim()] = m[2];
  }

  // Single code block
  if (Object.keys(files).length === 0) {
    const single = code.match(/```(?:jsx?|tsx?|html|css|vue|svelte)?\n([\s\S]*?)```/);
    if (single) files['App.jsx'] = single[1];
  }

  return files;
}

// ─── CREATE REACT PROJECT ───
function createReactProject(buildDir, files) {
  // Create Vite React structure
  fs.mkdirSync(path.join(buildDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(buildDir, 'public'), { recursive: true });

  // package.json
  fs.writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify({
    name: 'preview-app',
    version: '1.0.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: {
      react: '^18.2.0',
      'react-dom': '^18.2.0',
      'react-router-dom': '^6.8.0',
      axios: '^1.4.0',
      'lucide-react': '^0.263.1',
      recharts: '^2.7.2'
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.0.0',
      vite: '^4.4.0',
      tailwindcss: '^3.3.0',
      autoprefixer: '^10.4.14',
      postcss: '^8.4.27'
    }
  }, null, 2));

  // vite.config.js
  fs.writeFileSync(path.join(buildDir, 'vite.config.js'),
    `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: './' });`
  );

  // tailwind.config.js
  fs.writeFileSync(path.join(buildDir, 'tailwind.config.js'),
    `export default { content: ['./src/**/*.{js,jsx,ts,tsx}'], theme: { extend: {} }, plugins: [] };`
  );

  // postcss.config.js
  fs.writeFileSync(path.join(buildDir, 'postcss.config.js'),
    `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };`
  );

  // index.html
  fs.writeFileSync(path.join(buildDir, 'index.html'),
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Preview</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`
  );

  // main.jsx
  fs.writeFileSync(path.join(buildDir, 'src/main.jsx'),
    `import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App.jsx';
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`
  );

  // index.css with Tailwind
  fs.writeFileSync(path.join(buildDir, 'src/index.css'),
    `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n* { box-sizing: border-box; }\nbody { margin: 0; font-family: system-ui, sans-serif; }`
  );

  // Write generated files
  for (const [filename, content] of Object.entries(files)) {
    const cleanName = filename.replace(/^src\//, '');
    const filePath = path.join(buildDir, 'src', cleanName);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  // Ensure App.jsx exists
  const appFile = path.join(buildDir, 'src/App.jsx');
  if (!fs.existsSync(appFile)) {
    const firstFile = Object.values(files)[0] || '';
    fs.writeFileSync(appFile, firstFile || `export default function App() { return <div style={{padding:'20px'}}>App Preview</div>; }`);
  }
}

// ─── CREATE HTML PROJECT ───
function createHtmlProject(buildDir, files, rawCode) {
  // Extract HTML
  const htmlMatch = rawCode.match(/<!DOCTYPE[\s\S]*?<\/html>/i) || rawCode.match(/<html[\s\S]*?<\/html>/i);
  const htmlContent = htmlMatch ? htmlMatch[0] : (Object.values(files)[0] || rawCode);

  fs.writeFileSync(path.join(buildDir, 'index.html'), htmlContent);

  // Write other files
  for (const [filename, content] of Object.entries(files)) {
    if (!filename.endsWith('.html')) {
      const filePath = path.join(buildDir, filename);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  }

  // Simple package.json for serve
  fs.writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify({
    name: 'preview-html', version: '1.0.0',
    scripts: { build: 'echo "HTML ready"', start: 'npx serve .' },
    dependencies: {}
  }, null, 2));
}

// ─── BUILD PROJECT ───
async function buildProject(buildId, code, onProgress) {
  const buildDir = path.join(BUILDS_DIR, buildId);
  const outDir = path.join(buildDir, 'dist');

  try {
    fs.mkdirSync(buildDir, { recursive: true });
    const type = detectType(code);
    const files = extractFiles(code);

    onProgress({ step: 1, message: `Détection du type: ${type}`, progress: 10 });

    if (type === 'html') {
      createHtmlProject(buildDir, files, code);
      // For HTML, just copy to dist
      fs.mkdirSync(outDir, { recursive: true });
      const htmlFile = path.join(buildDir, 'index.html');
      if (fs.existsSync(htmlFile)) {
        fs.copyFileSync(htmlFile, path.join(outDir, 'index.html'));
        // Copy other static files
        for (const [filename, content] of Object.entries(files)) {
          if (!filename.endsWith('.html')) {
            const destPath = path.join(outDir, filename);
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.writeFileSync(destPath, content);
          }
        }
      }
      onProgress({ step: 6, message: 'HTML prêt', progress: 100 });
      return { success: true, type, buildDir, outDir };
    }

    // React/Vue project
    onProgress({ step: 2, message: 'Création de la structure du projet', progress: 20 });
    createReactProject(buildDir, files);

    onProgress({ step: 3, message: 'Installation des dépendances (npm install)...', progress: 30 });
    execSync('npm install --prefer-offline --no-audit --no-fund', {
      cwd: buildDir, timeout: 120000,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    onProgress({ step: 4, message: 'Compilation du projet (Vite build)...', progress: 60 });
    execSync('npm run build', {
      cwd: buildDir, timeout: 60000,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, NODE_ENV: 'production' }
    });

    onProgress({ step: 5, message: 'Vérification du build', progress: 90 });

    const distDir = path.join(buildDir, 'dist');
    if (!fs.existsSync(distDir)) throw new Error('Build failed - dist directory not found');

    onProgress({ step: 6, message: 'Compilation terminée !', progress: 100 });
    return { success: true, type, buildDir, outDir: distDir };

  } catch (err) {
    return { success: false, error: err.message, buildDir };
  }
}

// ─── SERVE BUILT PROJECT ───
function getBuiltFiles(buildId) {
  const distDir = path.join(BUILDS_DIR, buildId, 'dist');
  const htmlDir = path.join(BUILDS_DIR, buildId);

  // Check dist first (React build)
  if (fs.existsSync(path.join(distDir, 'index.html'))) return distDir;
  // Check HTML project
  if (fs.existsSync(path.join(htmlDir, 'index.html'))) return htmlDir;
  return null;
}

function cleanOldBuilds() {
  try {
    if (!fs.existsSync(BUILDS_DIR)) return;
    const dirs = fs.readdirSync(BUILDS_DIR);
    const now = Date.now();
    dirs.forEach(dir => {
      const full = path.join(BUILDS_DIR, dir);
      const stat = fs.statSync(full);
      // Delete builds older than 2 hours
      if (now - stat.mtimeMs > 7200000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    });
  } catch (e) {}
}

// Clean old builds every 30 minutes
setInterval(cleanOldBuilds, 1800000);

module.exports = { buildProject, getBuiltFiles, detectType, extractFiles, BUILDS_DIR };
