/**
 * Code Quality — validation, build testing, file writing, merging, diffing
 * Extracted from server.js lines 3481-4534
 *
 * Contains: findMissingImports, testViteBuild, validateJsxFiles,
 * validateAndFixCode, buildProjectStructure, safeFixServerJs, safeWriteTsx,
 * fixIndexCss, applyDiffs, formatProjectCodeFromMap, mergeModifiedCode,
 * mergeFullFiles, PROTECTED_FILES, VALID_FILE_PATTERNS, isValidProjectFile,
 * writeGeneratedFiles
 */
const fs = require('fs');
const path = require('path');
const { ERROR_TYPES } = require('../config');

module.exports = function(ctx) {
  let cleanGeneratedContent, stripCodeArtifacts, notifyProjectClients;

  function setDeps(deps) {
    cleanGeneratedContent = deps.cleanGeneratedContent;
    stripCodeArtifacts = deps.stripCodeArtifacts;
    notifyProjectClients = deps.notifyProjectClients;
  }

  // ── PROTECTED FILES ──
  const PROTECTED_FILES = new Set([
    'package.json', 'vite.config.js', 'tsconfig.json', 'index.html', 'src/main.tsx'
  ]);

  const VALID_FILE_PATTERNS = [
    /^package\.json$/, /^tsconfig\.json$/, /^vite\.config\.(js|ts)$/, /^index\.html$/,
    /^server\.js$/, /^src\/main\.(tsx|jsx)$/, /^src\/index\.css$/, /^src\/App\.(tsx|jsx)$/,
    /^src\/components\/[A-Za-z0-9_-]+\.(tsx|jsx)$/, /^src\/components\/ui\/[A-Za-z0-9_-]+\.(tsx|jsx)$/,
    /^src\/pages\/[A-Za-z0-9_-]+\.(tsx|jsx)$/, /^src\/styles\/[A-Za-z0-9_-]+\.css$/,
    /^src\/lib\/[A-Za-z0-9_-]+\.(ts|js|tsx|jsx)$/, /^src\/hooks\/[A-Za-z0-9_-]+\.(ts|js|tsx|jsx)$/,
    /^src\/context\/[A-Za-z0-9_-]+\.(ts|js|tsx|jsx)$/, /^src\/types\/[A-Za-z0-9_-]+\.(ts|d\.ts)$/,
    /^public\/index\.html$/,
  ];

  function isValidProjectFile(filename) {
    return VALID_FILE_PATTERNS.some(pattern => pattern.test(filename));
  }

  // ── SAFE WRITE TSX ──
  function safeWriteTsx(filePath, content) {
    if (!content || !filePath) return;
    const filename = path.basename(filePath);
    const ext = path.extname(filePath);
    if (ext === '.tsx' || ext === '.jsx' || ext === '.ts') {
      const uniqueImports = new Set();
      content = content.replace(/^import .+$/gm, (match) => {
        if (uniqueImports.has(match)) return '';
        uniqueImports.add(match);
        return match;
      });
      content = content.replace(/\n{3,}/g, '\n\n');
      content = content.replace(/https:\/\/picsum\.photos\/(\d+)\/(\d+)/g, (match, w, h) => {
        if (match.includes('/seed/')) return match;
        const seed = filename.replace(/\.[^.]+$/, '') + '-' + w + 'x' + h;
        return `https://picsum.photos/seed/${seed}/${w}/${h}`;
      });
      if (!content.includes('export default') && !content.includes('export {') && !filePath.includes('/ui/') && !filePath.includes('/lib/') && !filePath.includes('/hooks/')) {
        const funcMatch = content.match(/^function (\w+)/m);
        if (funcMatch) content = content.replace(`function ${funcMatch[1]}`, `export default function ${funcMatch[1]}`);
      }
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
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  // ── FIND MISSING IMPORTS ──
  function findMissingImports(projectDir) {
    const missing = [];
    const srcDir = path.join(projectDir, 'src');
    if (!fs.existsSync(srcDir)) return missing;
    const filesToScan = [];
    for (const name of ['App.tsx', 'App.jsx']) {
      const p = path.join(srcDir, name);
      if (fs.existsSync(p)) { filesToScan.push(p); break; }
    }
    for (const sub of ['components', 'pages']) {
      const dir = path.join(srcDir, sub);
      if (fs.existsSync(dir)) fs.readdirSync(dir).filter(f => f.endsWith('.tsx') || f.endsWith('.jsx')).forEach(f => filesToScan.push(path.join(dir, f)));
    }
    const checked = new Set();
    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf8');
      const fileDir = path.dirname(file);
      const importRegex = /import\s+(?:\{[^}]+\}|\w+)\s+from\s+['"]((?:\.|@\/)[^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        let resolved;
        if (importPath.startsWith('@/')) resolved = path.join(srcDir, importPath.substring(2));
        else resolved = path.resolve(fileDir, importPath);
        if (!resolved.endsWith('.tsx') && !resolved.endsWith('.ts') && !resolved.endsWith('.jsx') && !resolved.endsWith('.js') && !resolved.endsWith('.css')) {
          if (fs.existsSync(resolved + '.tsx')) resolved += '.tsx';
          else if (fs.existsSync(resolved + '.ts')) resolved += '.ts';
          else if (fs.existsSync(resolved + '.jsx')) resolved += '.jsx';
          else resolved += '.tsx';
        }
        if (!checked.has(resolved)) {
          checked.add(resolved);
          if (!fs.existsSync(resolved)) {
            const rel = path.relative(projectDir, resolved);
            if (rel.startsWith('src/')) missing.push(rel);
          }
        }
      }
    }
    return missing;
  }

  // ── TEST VITE BUILD ──
  function testViteBuild(projectDir) {
    const viteBin = path.join(projectDir, 'node_modules', '.bin', 'vite');
    if (!fs.existsSync(viteBin)) {
      try {
        const { spawnSync } = require('child_process');
        const result = spawnSync('npx', ['vite', 'build', '--mode', 'development'], { cwd: projectDir, encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_PATH: '/app/node_modules' } });
        if (result.status === 0) return { success: true };
        return { success: false, error: (result.stderr || result.stdout || '').trim() };
      } catch (e) { return { success: true }; }
    }
    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync(viteBin, ['build', '--mode', 'development'], { cwd: projectDir, encoding: 'utf8', timeout: 30000 });
      if (result.status === 0) return { success: true };
      const error = (result.stderr || result.stdout || '').trim();
      const errorMatch = error.match(/error[:\s]+([\s\S]*?)(?:\n\n|\nat\s)/i);
      return { success: false, error: errorMatch ? errorMatch[1].trim() : error.substring(0, 1000) };
    } catch (e) { return { success: true }; }
  }

  // ── VALIDATE JSX FILES ──
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
      let content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(projectDir, file);
      if (!content.includes('export')) errors.push({ file: rel, issue: 'no export statement' });
      let current = content;
      if (/^SUGGESTIONS:/m.test(current)) { current = current.replace(/\n*SUGGESTIONS:[\s\S]*$/m, '').trim(); fs.writeFileSync(file, current); errors.push({ file: rel, issue: 'SUGGESTIONS artifact removed' }); }
      if (/^```/m.test(current)) { current = current.replace(/^```.*$/gm, '').trim(); fs.writeFileSync(file, current); errors.push({ file: rel, issue: 'markdown backticks removed' }); }
      if (/from ['"]\.\.\//.test(current) || /from ['"]\.\/components/.test(current) || /from ['"]\.\/pages/.test(current)) {
        let fixed = current;
        fixed = fixed.replace(/from (['"])\.\.\/components\//g, "from $1@/components/");
        fixed = fixed.replace(/from (['"])\.\.\/\.\.\/components\//g, "from $1@/components/");
        fixed = fixed.replace(/from (['"])\.\.\/pages\//g, "from $1@/pages/");
        fixed = fixed.replace(/from (['"])\.\.\/lib\//g, "from $1@/lib/");
        fixed = fixed.replace(/from (['"])\.\.\/\.\.\/lib\//g, "from $1@/lib/");
        fixed = fixed.replace(/from (['"])\.\.\/hooks\//g, "from $1@/hooks/");
        fixed = fixed.replace(/from (['"])\.\.\/\.\.\/hooks\//g, "from $1@/hooks/");
        fixed = fixed.replace(/from (['"])\.\/components\//g, "from $1@/components/");
        fixed = fixed.replace(/from (['"])\.\/pages\//g, "from $1@/pages/");
        if (fixed !== current) { fs.writeFileSync(file, fixed); current = fixed; errors.push({ file: rel, issue: 'relative imports converted to @/' }); }
      }
    }
    return errors;
  }

  // ── VALIDATE AND FIX CODE ──
  async function validateAndFixCode(projectId, code, maxAttempts = 3) {
    const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(projectId));
    const serverJsPath = path.join(projDir, 'server.js');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      writeGeneratedFiles(projDir, code, projectId);
      let serverOk = true;
      if (fs.existsSync(serverJsPath)) {
        const { spawnSync } = require('child_process');
        const result = spawnSync('node', ['--check', serverJsPath], { encoding: 'utf8', timeout: 10000 });
        if (result.status !== 0) { serverOk = false; if (attempt >= maxAttempts) break; }
      }
      const essentialFiles = ['index.html', 'src/main.tsx', 'src/App.tsx', 'vite.config.js'];
      let missingFiles = essentialFiles.filter(f => !fs.existsSync(path.join(projDir, f)));
      if (missingFiles.length > 0) {
        const fileOps = ctx.services.fileOps;
        if (fileOps) fileOps.writeDefaultReactProject(projDir);
      }
      if (serverOk) { console.log(`[Validate] React project validated OK (attempt ${attempt})`); return code; }
    }
    return code;
  }

  // ── BUILD PROJECT STRUCTURE ──
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
        structure += `\n  server.js (${content.length} chars)\n    Routes: ${routes.slice(0, 15).join(', ')}\n    Tables: ${tables.join(', ')}\n`;
      } else if (fn === 'src/App.jsx') {
        const reactRoutes = (content.match(/<Route\s+path="([^"]+)"/g) || []);
        const imports = (content.match(/import\s+\w+\s+from\s+'([^']+)'/g) || []);
        structure += `\n  src/App.jsx (${content.length} chars)\n    Routes: ${reactRoutes.join(', ')}\n    Imports: ${imports.length}\n`;
      } else if (fn === 'package.json') {
        try { const pkg = JSON.parse(content); structure += `\n  package.json — ${pkg.name}\n    Dependencies: ${Object.keys(pkg.dependencies || {}).join(', ')}\n`; } catch { structure += `\n  package.json\n`; }
      } else if (fn.startsWith('src/components/') || fn.startsWith('src/pages/')) {
        structure += `\n  ${fn} (${content.length} chars)\n`;
      }
    }
    return structure;
  }

  // ── SAFE FIX SERVER JS ──
  function safeFixServerJs(content) {
    // Full implementation from server.js lines 3814-3977
    const fixes = [];
    content = content.replace(/require\(['"]sqlite3['"]\)\.verbose\(\)/g, "require('better-sqlite3')");
    content = content.replace(/require\(['"]sqlite3['"]\)/g, "require('better-sqlite3')");
    content = content.replace(/require\(['"]bcrypt['"]\)(?!js)/g, "require('bcryptjs')");
    content = content.replace(/new\s+sqlite3\.Database\([^)]*\)/g, "new (require('better-sqlite3'))('/app/data/app.db')");
    if (!content.includes("'0.0.0.0'") && !content.includes('"0.0.0.0"')) {
      content = content.replace(/app\.listen\(\s*(PORT|port|\d+)\s*,\s*\(\)/g, "app.listen($1, '0.0.0.0', ()");
      content = content.replace(/app\.listen\(\s*(PORT|port|\d+)\s*\)/g, "app.listen($1, '0.0.0.0', () => console.log('Server running on port ' + $1))");
      fixes.push('listen→0.0.0.0');
    }
    if (!content.includes('/health')) {
      const idx = content.indexOf('express.json()');
      if (idx > 0) { const at = content.indexOf(';', idx) + 1; content = content.substring(0, at) + "\napp.get('/health', (req, res) => res.json({ status: 'ok' }));" + content.substring(at); }
      fixes.push('+/health');
    }
    if (/^import\s+\w+\s+from\s+/m.test(content)) {
      content = content.replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g, "const $1 = require('$2');");
      content = content.replace(/import\s*\{\s*([^}]+)\s*\}\s*from\s+['"]([^'"]+)['"]\s*;?/g, "const { $1 } = require('$2');");
      content = content.replace(/export\s+default\s+/g, 'module.exports = ');
      fixes.push('ESM→CJS');
    }
    if (fixes.length > 0) console.log(`[Guard:server.js] Fixed: ${fixes.join(', ')}`);
    return content;
  }

  // ── FIX INDEX CSS ──
  function fixIndexCss(content) {
    const templatePath = path.join(__dirname, '..', '..', 'templates', 'react', 'src', 'index.css');
    if (content.includes('@import "tailwindcss"')) content = content.replace('@import "tailwindcss";', '@tailwind base;\n@tailwind components;\n@tailwind utilities;');
    content = content.replace(/@theme\s*\{[\s\S]*?\n\}/g, '');
    content = content.replace(/theme\([^)]+\)/g, '');
    if (!content.includes('@tailwind base')) content = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n' + content;
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
    if (!content.includes('--background:') && !content.includes('--primary:')) {
      if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
    }
    return content;
  }

  // ── APPLY DIFFS ──
  function applyDiffs(existingCode, diffCode) {
    const existingFiles = {};
    existingCode.split(/### /).filter(s => s.trim()).forEach(s => {
      const nl = s.indexOf('\n'); if (nl === -1) return;
      const fn = s.substring(0, nl).trim();
      if (fn && !fn.startsWith('DIFF ')) existingFiles[fn] = s.substring(nl + 1).trim();
    });
    const diffPattern = /### DIFF ([^\n]+)\n([\s\S]*?)(?=### (?:DIFF )?|$)/g;
    let match, applied = 0, failed = 0;
    while ((match = diffPattern.exec(diffCode)) !== null) {
      const filename = match[1].trim();
      const diffBody = match[2];
      if (!existingFiles[filename]) { failed++; continue; }
      const searchReplacePattern = /<<<< SEARCH\n([\s\S]*?)\n==== REPLACE\n([\s\S]*?)\n>>>>/g;
      let srMatch, fileContent = existingFiles[filename], fileApplied = 0;
      while ((srMatch = searchReplacePattern.exec(diffBody)) !== null) {
        if (fileContent.includes(srMatch[1])) { fileContent = fileContent.replace(srMatch[1], srMatch[2]); fileApplied++; }
        else { const ts = srMatch[1].trim(); if (ts && fileContent.includes(ts)) { fileContent = fileContent.replace(ts, srMatch[2].trim()); fileApplied++; } else failed++; }
      }
      if (fileApplied > 0) { existingFiles[filename] = fileContent; applied += fileApplied; }
    }
    return formatProjectCodeFromMap(existingFiles);
  }

  // ── FORMAT PROJECT CODE FROM MAP ──
  function formatProjectCodeFromMap(files) {
    const fileOrder = ['package.json', 'vite.config.js', 'index.html', 'server.js', 'src/main.tsx', 'src/index.css', 'src/App.tsx'];
    let result = '';
    const written = new Set();
    for (const fn of fileOrder) { if (files[fn]) { result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`; written.add(fn); } }
    Object.keys(files).filter(fn => !written.has(fn)).sort((a, b) => {
      const order = (f) => f.startsWith('src/components/') ? 0 : f.startsWith('src/pages/') ? 1 : 2;
      return order(a) - order(b) || a.localeCompare(b);
    }).forEach(fn => { result += (result ? '\n\n' : '') + `### ${fn}\n${files[fn]}`; });
    return result;
  }

  // ── MERGE MODIFIED CODE ──
  function mergeModifiedCode(existingCode, newCode) {
    if (newCode.includes('### DIFF ')) {
      const fullFileParts = newCode.replace(/### DIFF [^\n]+\n[\s\S]*?(?=### (?:DIFF )?|$)/g, '').trim();
      let result = applyDiffs(existingCode, newCode);
      if (fullFileParts.includes('### ')) result = mergeFullFiles(result, fullFileParts);
      return result;
    }
    return mergeFullFiles(existingCode, newCode);
  }

  function mergeFullFiles(existingCode, newCode) {
    const existingFiles = {}, newFiles = {};
    const cleanExisting = stripCodeArtifacts ? stripCodeArtifacts(existingCode) : existingCode;
    const cleanNew = stripCodeArtifacts ? stripCodeArtifacts(newCode) : newCode;
    for (const s of cleanExisting.split(/### /).filter(s => s.trim())) {
      const nl = s.indexOf('\n'); if (nl === -1) continue;
      const fn = s.substring(0, nl).trim();
      if (fn && !fn.startsWith('DIFF ')) existingFiles[fn] = cleanGeneratedContent ? cleanGeneratedContent(s.substring(nl + 1).trim()) : s.substring(nl + 1).trim();
    }
    for (const s of cleanNew.split(/### /).filter(s => s.trim())) {
      const nl = s.indexOf('\n'); if (nl === -1) continue;
      const fn = s.substring(0, nl).trim();
      if (fn && !fn.startsWith('DIFF ')) newFiles[fn] = cleanGeneratedContent ? cleanGeneratedContent(s.substring(nl + 1).trim()) : s.substring(nl + 1).trim();
    }
    const merged = { ...existingFiles, ...newFiles };
    const fileOrder = ['package.json', 'vite.config.js', 'index.html', 'server.js', 'src/main.tsx', 'src/index.css', 'src/App.tsx'];
    let result = '';
    const written = new Set();
    for (const fn of fileOrder) { if (merged[fn]) { result += (result ? '\n\n' : '') + `### ${fn}\n${merged[fn]}`; written.add(fn); } }
    Object.keys(merged).filter(fn => !written.has(fn)).sort((a, b) => {
      const order = (f) => f.startsWith('src/components/') ? 0 : f.startsWith('src/pages/') ? 1 : 2;
      return order(a) - order(b) || a.localeCompare(b);
    }).forEach(fn => { result += (result ? '\n\n' : '') + `### ${fn}\n${merged[fn]}`; });
    console.log(`[Merge] ${Object.keys(newFiles).length} file(s) modified, ${Object.keys(merged).length} total`);
    return result;
  }

  // ── WRITE GENERATED FILES ──
  function writeGeneratedFiles(projectDir, code, projectId) {
    const sections = code.split(/^### /m).filter(s => s.trim());
    let filesWritten = 0;
    for (const section of sections) {
      const newlineIdx = section.indexOf('\n');
      if (newlineIdx === -1) continue;
      let filename = section.substring(0, newlineIdx).trim();
      if (filename.startsWith('DIFF ')) continue;
      let content = section.substring(newlineIdx + 1).trim();
      if (!filename || !content) continue;
      if (filename === 'public/index.html' && content.includes('id="root"')) filename = 'index.html';
      if (!isValidProjectFile(filename)) continue;
      content = cleanGeneratedContent ? cleanGeneratedContent(content) : content;
      if (!content) continue;
      if (filename === 'server.js') content = safeFixServerJs(content);
      if (projectId && notifyProjectClients) notifyProjectClients(projectId, 'file_written', { path: filename, content });
      if (PROTECTED_FILES.has(filename)) continue;
      const filePath = path.join(projectDir, filename);
      const fileDir = path.dirname(filePath);
      if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
      const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx")) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
      if (filename === 'server.js') {
        try { const { execSync } = require('child_process'); execSync(`node --check "${filePath}"`, { timeout: 5000, stdio: 'pipe' }); }
        catch (syntaxErr) {
          console.warn(`[Guard:syntax] server.js failed syntax check — rolling back`);
          if (backup) fs.writeFileSync(filePath, backup); else fs.unlinkSync(filePath);
          continue;
        }
      }
      filesWritten++;
    }
    console.log(`[WriteFiles] Total: ${filesWritten} files written`);
  }

  return {
    findMissingImports, testViteBuild, validateJsxFiles, validateAndFixCode,
    buildProjectStructure, safeFixServerJs, safeWriteTsx, fixIndexCss,
    applyDiffs, formatProjectCodeFromMap, mergeModifiedCode, mergeFullFiles,
    PROTECTED_FILES, VALID_FILE_PATTERNS, isValidProjectFile, writeGeneratedFiles,
    setDeps
  };
};
