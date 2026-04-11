/**
 * Tool-Based Code Generation — CODE_TOOLS array + executeServerTool + helpers
 * Extracted from server.js lines 1210-2104
 *
 * NOTE: This module is very large. The CODE_TOOLS array and executeServerTool
 * function are the main exports. Cross-module deps are injected via setDeps().
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

module.exports = function(ctx) {
  let PROTECTED_FILES, cleanGeneratedContent, mergeEllipsis, getContainerName;
  let encryptValue;

  function setDeps(deps) {
    PROTECTED_FILES = deps.PROTECTED_FILES;
    cleanGeneratedContent = deps.cleanGeneratedContent;
    mergeEllipsis = deps.mergeEllipsis;
    getContainerName = deps.getContainerName;
    encryptValue = deps.encryptValue;
  }

  // ─── CODE_TOOLS ARRAY ───
  // This is the full tool definitions array used by Claude API calls.
  // Keeping it here centralizes the tool schema.
  const CODE_TOOLS = [
    { name: 'write_file', description: 'Create or overwrite a file. For modifications, use "// ... keep existing code" to skip unchanged sections (>5 lines). The server will merge with the existing file. Example:\nimport React from "react";\n// ... keep existing code\nexport default function App() {\n  return <div>NEW CONTENT</div>;\n}\nThis saves tokens — only send the changed parts.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to project root (e.g. src/components/Header.tsx)' }, content: { type: 'string', description: 'File content. Use "// ... keep existing code" for unchanged sections.' } }, required: ['path', 'content'] } },
    { name: 'edit_file', description: 'Search and replace text in a file. For small changes (color, text, name). The search is fuzzy — whitespace differences are tolerated.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to project root' }, search: { type: 'string', description: 'Text to find (whitespace-tolerant)' }, replace: { type: 'string', description: 'Text to replace it with' } }, required: ['path', 'search', 'replace'] } },
    { name: 'line_replace', description: 'Replace lines by line number range. Most precise edit tool — use when you know exactly which lines to change.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to project root' }, start_line: { type: 'number', description: 'First line to replace (1-based)' }, end_line: { type: 'number', description: 'Last line to replace (inclusive)' }, new_content: { type: 'string', description: 'New content to insert (replaces lines start_line through end_line)' } }, required: ['path', 'start_line', 'end_line', 'new_content'] } },
    { name: 'fetch_website', description: 'Fetch a website URL and get its content as clean text/markdown. Use when the user says "fais comme ce site" or references an external URL for design inspiration.',
      input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The full URL to fetch (e.g. https://stripe.com)' } }, required: ['url'] } },
    { name: 'read_console_logs', description: 'Read the frontend console logs (errors, warnings, network failures) from the project preview. Use FIRST when debugging.',
      input_schema: { type: 'object', properties: { project_id: { type: 'number', description: 'The project ID to read logs from' } }, required: ['project_id'] } },
    { name: 'run_security_check', description: 'Scan the project code for common security issues: exposed secrets, SQL injection risks, missing auth checks, XSS vulnerabilities.',
      input_schema: { type: 'object', properties: { project_id: { type: 'number', description: 'The project ID to scan' } }, required: ['project_id'] } },
    { name: 'parse_document', description: 'Parse a document (PDF or Word/DOCX) uploaded as base64 and extract its text content.',
      input_schema: { type: 'object', properties: { base64_content: { type: 'string', description: 'The document content encoded in base64' }, filename: { type: 'string', description: 'Original filename to detect type (e.g. brief.pdf, content.docx)' } }, required: ['base64_content', 'filename'] } },
    { name: 'generate_mermaid', description: 'Generate a Mermaid diagram to explain architecture, workflows, or data flows.',
      input_schema: { type: 'object', properties: { diagram: { type: 'string', description: 'The Mermaid diagram syntax (e.g. graph TD; A-->B)' }, title: { type: 'string', description: 'A short title for the diagram' } }, required: ['diagram'] } },
    { name: 'view_file', description: 'Read the contents of a file in the project. Use to examine code before editing.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to project root' }, start_line: { type: 'number', description: 'Start line (optional, default 1)' }, end_line: { type: 'number', description: 'End line (optional, default 500)' } }, required: ['path'] } },
    { name: 'search_files', description: 'Search for a text pattern across all project files. Returns matching lines with file paths.',
      input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Text or regex pattern to search for' }, file_glob: { type: 'string', description: 'File glob filter (e.g. "*.tsx", "src/pages/*")' } }, required: ['pattern'] } },
    { name: 'delete_file', description: 'Delete a file from the project.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path to delete' } }, required: ['path'] } },
    { name: 'rename_file', description: 'Rename or move a file in the project.',
      input_schema: { type: 'object', properties: { old_path: { type: 'string', description: 'Current file path' }, new_path: { type: 'string', description: 'New file path' } }, required: ['old_path', 'new_path'] } },
    { name: 'add_dependency', description: 'Add an npm package to the project. Only use for packages not already installed.',
      input_schema: { type: 'object', properties: { package_name: { type: 'string', description: 'Package name (e.g. "chart.js")' }, version: { type: 'string', description: 'Version (optional, e.g. "4.4.0")' }, dev: { type: 'boolean', description: 'Install as devDependency (default false)' } }, required: ['package_name'] } },
    { name: 'remove_dependency', description: 'Remove an npm package from the project.',
      input_schema: { type: 'object', properties: { package_name: { type: 'string', description: 'Package name to remove' } }, required: ['package_name'] } },
    { name: 'download_to_project', description: 'Download a file from a URL and save it into the project.',
      input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL to download from' }, save_path: { type: 'string', description: 'Path in the project to save to (e.g. "public/logo.png")' } }, required: ['url', 'save_path'] } },
    { name: 'read_project_analytics', description: 'Read production analytics for a published project.',
      input_schema: { type: 'object', properties: { project_id: { type: 'number', description: 'The project ID' } }, required: ['project_id'] } },
    { name: 'get_table_schema', description: 'Read the SQLite database schema and table structure of a project.',
      input_schema: { type: 'object', properties: { project_id: { type: 'number', description: 'The project ID' } }, required: ['project_id'] } },
    { name: 'search_images', description: 'Search for professional stock photos by keyword.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search keywords' }, count: { type: 'number', description: 'Number of images (default 3, max 10)' } }, required: ['query'] } },
    { name: 'enable_stripe', description: 'Configure Stripe payment integration for a project.',
      input_schema: { type: 'object', properties: { project_id: { type: 'number', description: 'The project ID' }, stripe_key_name: { type: 'string', description: 'Env var name for the Stripe key (default STRIPE_SECRET_KEY)' } }, required: ['project_id'] } },
    { name: 'generate_image', description: 'Generate a custom AI image for the project. Uses DALL-E 3 via OpenAI API.',
      input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'Detailed image description' }, save_path: { type: 'string', description: 'Path to save in project (e.g. "public/hero.jpg")' }, width: { type: 'number', description: 'Width in pixels (default 1200)' }, height: { type: 'number', description: 'Height in pixels (default 800)' } }, required: ['prompt', 'save_path'] } },
    { name: 'run_command', description: 'Execute a shell command inside the project container.',
      input_schema: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to run' }, cwd: { type: 'string', description: 'Working directory inside container (default: /app)' } }, required: ['command'] } },
  ];

  // ─── HTML TO TEXT ───
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
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return `Source: ${url}\n\n${text.substring(0, 5000)}`;
  }

  // ─── EXECUTE SERVER TOOL ───
  // This is the main dispatch function for server-side tools.
  // It handles fetch_website, read_console_logs, run_security_check, parse_document,
  // generate_mermaid, view_file, search_files, delete_file, rename_file,
  // add_dependency, remove_dependency, download_to_project, read_project_analytics,
  // get_table_schema, search_images, enable_stripe, generate_image, run_command
  function executeServerTool(toolName, toolInput) {
    const db = ctx.db;

    if (toolName === 'fetch_website' && toolInput.url) {
      return new Promise((resolve) => {
        const url = toolInput.url;
        const proto = url.startsWith('https') ? https : http;
        const req = proto.get(url, { timeout: 10000, headers: { 'User-Agent': 'PrestigeBuildBot/1.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
      const logs = ctx.clientLogs.get(String(toolInput.project_id)) || [];
      if (logs.length === 0) return Promise.resolve('Aucun log frontend capturé.');
      return Promise.resolve(logs.slice(-20).map(l => `[${l.level}] ${l.message}`).join('\n'));
    }

    if (toolName === 'run_security_check' && toolInput.project_id && db) {
      const project = db.prepare('SELECT generated_code FROM projects WHERE id=?').get(toolInput.project_id);
      if (!project?.generated_code) return Promise.resolve('Projet sans code.');
      const code = project.generated_code;
      const issues = [];
      if (/['"][A-Za-z0-9]{20,}['"]/.test(code) && /api.key|secret|token|password/i.test(code)) issues.push('CRITIQUE: Possible clé API ou secret en dur dans le code');
      if (/\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE)/i.test(code) || /`.*\$\{.*(?:SELECT|INSERT|UPDATE|DELETE)/i.test(code)) issues.push('CRITIQUE: Possible injection SQL (template literal dans une requête)');
      if (code.includes('/api/') && !code.includes('auth') && !code.includes('jwt') && !code.includes('token')) issues.push('ATTENTION: Routes API sans authentification visible');
      if (code.includes('dangerouslySetInnerHTML')) issues.push('ATTENTION: dangerouslySetInnerHTML détecté — risque XSS');
      if (/ANTHROPIC_API_KEY|STRIPE_SECRET|GOOGLE_API/.test(code) && !code.includes('process.env')) issues.push('ATTENTION: Clé API potentiellement en dur');
      if (issues.length === 0) return Promise.resolve('Aucun problème de sécurité détecté.');
      return Promise.resolve('Problèmes détectés:\n' + issues.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    }

    if (toolName === 'parse_document' && toolInput.base64_content && toolInput.filename) {
      return (async () => {
        try {
          const buffer = Buffer.from(toolInput.base64_content, 'base64');
          const ext = (toolInput.filename || '').toLowerCase();
          if (ext.endsWith('.pdf')) { try { const pdfParse = require('pdf-parse'); const data = await pdfParse(buffer); return `Document PDF (${data.numpages} pages):\n\n${(data.text || '').substring(0, 8000)}`; } catch (e) { return `Erreur parsing PDF: ${e.message}`; } }
          if (ext.endsWith('.docx') || ext.endsWith('.doc')) { try { const mammoth = require('mammoth'); const result = await mammoth.extractRawText({ buffer }); return `Document Word:\n\n${(result.value || '').substring(0, 8000)}`; } catch (e) { return `Erreur parsing Word: ${e.message}`; } }
          return `Document texte:\n\n${buffer.toString('utf8').substring(0, 8000)}`;
        } catch (e) { return `Erreur parsing document: ${e.message}`; }
      })();
    }

    if (toolName === 'generate_mermaid' && toolInput.diagram) {
      const title = toolInput.title ? `**${toolInput.title}**\n\n` : '';
      return Promise.resolve(`${title}\`\`\`mermaid\n${toolInput.diagram}\n\`\`\``);
    }

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
              if (regex.test(line)) results.push(`${path.relative(toolInput._projectDir, fp)}:${i + 1}: ${line.trim()}`);
            });
          } catch {}
        }
      };
      searchDir(toolInput._projectDir);
      return Promise.resolve(results.length > 0 ? results.slice(0, 30).join('\n') : 'Aucun résultat.');
    }

    if (toolName === 'delete_file' && toolInput.path && toolInput._projectDir) {
      if (PROTECTED_FILES && (PROTECTED_FILES.has(toolInput.path) || toolInput.path.startsWith('src/components/ui/') || toolInput.path.startsWith('src/lib/') || toolInput.path.startsWith('src/hooks/'))) {
        return Promise.resolve(`Impossible de supprimer un fichier système: ${toolInput.path}`);
      }
      const fp = path.join(toolInput._projectDir, toolInput.path);
      if (!fs.existsSync(fp)) return Promise.resolve(`Fichier introuvable: ${toolInput.path}`);
      fs.unlinkSync(fp);
      return Promise.resolve(`Supprimé: ${toolInput.path}`);
    }

    if (toolName === 'rename_file' && toolInput.old_path && toolInput.new_path && toolInput._projectDir) {
      if (PROTECTED_FILES && (PROTECTED_FILES.has(toolInput.old_path) || PROTECTED_FILES.has(toolInput.new_path))) return Promise.resolve(`Impossible de renommer un fichier système: ${toolInput.old_path}`);
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
        if (pkg[section][toolInput.package_name]) return Promise.resolve(`Déjà installé: ${toolInput.package_name}@${pkg[section][toolInput.package_name]}`);
        pkg[section][toolInput.package_name] = toolInput.version || 'latest';
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
        if (toolInput.project_id && getContainerName) {
          try {
            const containerName = getContainerName(toolInput.project_id);
            const { execSync } = require('child_process');
            execSync(`docker cp ${pkgPath} ${containerName}:/app/package.json`, { timeout: 10000 });
            const version = toolInput.version || 'latest';
            execSync(`docker exec ${containerName} npm install ${toolInput.package_name}@${version} --force 2>&1 | tail -3`, { timeout: 60000, encoding: 'utf8' });
            return Promise.resolve(`Installé: ${toolInput.package_name}@${version} (disponible immédiatement)`);
          } catch (installErr) { return Promise.resolve(`Ajouté au package.json: ${toolInput.package_name}. Rebuild nécessaire pour l'installer.`); }
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
          if (toolInput.project_id && getContainerName) { try { const { execSync } = require('child_process'); execSync(`docker exec ${getContainerName(toolInput.project_id)} npm uninstall ${toolInput.package_name} 2>&1 | tail -2`, { timeout: 30000 }); } catch {} }
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
      const projDir = path.join(ctx.config.DOCKER_PROJECTS_DIR, String(toolInput.project_id));
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
        const results = [];
        for (let i = 0; i < count; i++) {
          const seed = `${toolInput.query}-${i}`;
          const w = [800, 1200, 600][i % 3];
          const h = [600, 800, 400][i % 3];
          results.push({ url: `https://images.unsplash.com/photo-${Date.now() + i}?w=${w}&h=${h}&fit=crop&q=80`, fallback: `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`, alt: `${toolInput.query} - image ${i + 1}`, width: w, height: h });
        }
        resolve(`Images pour "${toolInput.query}" (${count} résultats):\n${results.map((r, i) => `${i + 1}. ${r.fallback}\n   alt="${r.alt}" (${r.width}x${r.height})`).join('\n')}\n\nUtilise les URLs "fallback" (picsum.photos) qui fonctionnent toujours.`);
      });
    }

    if (toolName === 'run_command' && toolInput.command) {
      return (async () => {
        try {
          const containerExecService = ctx.services.containerExec;
          const result = await containerExecService.execInContainer(
            toolInput._projectId || toolInput.project_id,
            toolInput.command,
            { cwd: toolInput.cwd }
          );
          let output = '';
          if (result.stdout) output += result.stdout;
          if (result.stderr) output += (output ? '\n\nSTDERR:\n' : '') + result.stderr;
          if (result.timedOut) output += '\n\n[TIMEOUT]';
          return output || '(no output)';
        } catch(e) { return `Erreur: ${e.message}`; }
      })();
    }

    if (toolName === 'enable_stripe' && toolInput.project_id && db) {
      const keyName = toolInput.stripe_key_name || 'STRIPE_SECRET_KEY';
      try {
        const existing = db.prepare('SELECT id FROM project_api_keys WHERE project_id=? AND env_name=?').get(toolInput.project_id, keyName);
        if (existing) return Promise.resolve(`Stripe déjà configuré (${keyName}).`);
        db.prepare('INSERT INTO project_api_keys (project_id, env_name, env_value, service) VALUES (?,?,?,?)').run(toolInput.project_id, keyName, encryptValue('CONFIGURE_VIA_ADMIN_PANEL'), 'stripe');
        return Promise.resolve(`Stripe activé. Variable ${keyName} créée.`);
      } catch (e) { return Promise.resolve(`Erreur: ${e.message}`); }
    }

    if (toolName === 'generate_image' && toolInput.prompt && toolInput.save_path) {
      return new Promise(async (resolve) => {
        const savePath = toolInput.save_path;
        const size = (toolInput.width || 1200) >= 1024 ? '1792x1024' : '1024x1024';
        const seed = toolInput.prompt.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
        const fallbackUrl = `https://picsum.photos/seed/${seed}/${toolInput.width || 1200}/${toolInput.height || 800}`;
        if (ctx.config.OPENAI_API_KEY) {
          try {
            const payload = JSON.stringify({ model: 'dall-e-3', prompt: toolInput.prompt, n: 1, size, quality: 'standard' });
            const imageData = await new Promise((res, rej) => {
              const req = https.request({ hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.config.OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(payload) } }, (apiRes) => {
                let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => { try { const r = JSON.parse(data); res(r.data?.[0]?.url || null); } catch { res(null); } });
              }); req.on('error', () => res(null)); req.setTimeout(30000, () => { req.destroy(); res(null); }); req.write(payload); req.end();
            });
            if (imageData && toolInput._projectDir) {
              const fullPath = path.join(toolInput._projectDir, savePath);
              const dir = path.dirname(fullPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              await new Promise((dl) => {
                https.get(imageData, { timeout: 20000 }, (imgRes) => { const file = fs.createWriteStream(fullPath); imgRes.pipe(file); file.on('finish', () => { file.close(); dl(); }); }).on('error', dl);
              });
              resolve(`Image IA generee et sauvee: ${savePath}\nURL pour le code: /${savePath}`);
              return;
            }
            if (imageData) { resolve(`Image IA generee: ${imageData}\nUtilise cette URL dans src=""`); return; }
          } catch (e) { console.warn(`[ImageGen] DALL-E failed: ${e.message}, falling back to picsum`); }
        }
        // Fallback: picsum
        if (toolInput._projectDir) {
          const fullPath = path.join(toolInput._projectDir, savePath);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          https.get(fallbackUrl, { timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              https.get(res.headers.location, { timeout: 15000 }, (r2) => { const file = fs.createWriteStream(fullPath); r2.pipe(file); file.on('finish', () => { file.close(); resolve(`Image sauvee: ${savePath}\nURL: /${savePath}`); }); }).on('error', () => resolve(`Image: ${fallbackUrl}`));
              return;
            }
            const file = fs.createWriteStream(fullPath);
            res.pipe(file); file.on('finish', () => { file.close(); resolve(`Image sauvee: ${savePath}\nURL: /${savePath}`); });
          }).on('error', () => resolve(`Image: ${fallbackUrl}`));
        } else { resolve(`Image URL: ${fallbackUrl}`); }
      });
    }

    return Promise.resolve(null);
  }

  // ─── PARSE TOOL RESPONSE ───
  function parseToolResponse(response) {
    const result = { files: {}, edits: [], text: '', serverToolCalls: [] };
    if (!response || !response.content) return result;
    for (const block of response.content) {
      if (block.type === 'text') { result.text += block.text; }
      else if (block.type === 'tool_use') {
        if (block.name === 'write_file' && block.input?.path && block.input?.content) {
          if (PROTECTED_FILES && PROTECTED_FILES.has(block.input.path)) { console.log(`[Tool] Blocked write to infra file: ${block.input.path}`); }
          else {
            let newContent = cleanGeneratedContent ? cleanGeneratedContent(block.input.content) : block.input.content;
            if (newContent && newContent.includes('// ... keep existing code') && mergeEllipsis) {
              // Merge with existing file — projDir context needed
              // This is handled by the caller context
            }
            if (newContent) result.files[block.input.path] = newContent;
          }
        } else if (block.name === 'line_replace' && block.input?.path && block.input?.start_line && block.input?.new_content) {
          result.edits.push({ path: block.input.path, lineReplace: true, startLine: block.input.start_line, endLine: block.input.end_line || block.input.start_line, newContent: block.input.new_content });
        } else if (block.name === 'edit_file' && block.input?.path && block.input?.search) {
          result.edits.push({ path: block.input.path, search: block.input.search, replace: block.input.replace || '' });
        } else if (['fetch_website', 'read_console_logs', 'run_security_check', 'parse_document', 'generate_mermaid', 'view_file', 'search_files', 'delete_file', 'rename_file', 'add_dependency', 'remove_dependency', 'download_to_project', 'read_project_analytics', 'get_table_schema', 'enable_stripe', 'search_images', 'generate_image', 'run_command'].includes(block.name)) {
          result.serverToolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    }
    return result;
  }

  // ─── TOOL RESPONSE TO CODE ───
  function toolResponseToCode(parsed) {
    let code = '';
    const fileOrder = ['package.json', 'vite.config.js', 'index.html', 'server.js', 'src/main.tsx', 'src/index.css', 'src/App.tsx'];
    const written = new Set();
    for (const fn of fileOrder) { if (parsed.files[fn]) { code += (code ? '\n\n' : '') + `### ${fn}\n${parsed.files[fn]}`; written.add(fn); } }
    Object.keys(parsed.files).filter(fn => !written.has(fn)).sort().forEach(fn => { code += (code ? '\n\n' : '') + `### ${fn}\n${parsed.files[fn]}`; });
    return code;
  }

  // ─── MERGE ELLIPSIS ───
  function mergeEllipsisFn(existing, partial) {
    const existingLines = existing.split('\n');
    const partialLines = partial.split('\n');
    const result = [];
    let existingIdx = 0;
    for (let i = 0; i < partialLines.length; i++) {
      const line = partialLines[i];
      if (line.trim() === '// ... keep existing code' || line.trim() === '/* ... keep existing code */') {
        let nextPartialLine = null;
        for (let j = i + 1; j < partialLines.length; j++) {
          if (partialLines[j].trim() !== '// ... keep existing code' && partialLines[j].trim() !== '/* ... keep existing code */' && partialLines[j].trim()) { nextPartialLine = partialLines[j].trim(); break; }
        }
        if (nextPartialLine) { while (existingIdx < existingLines.length) { if (existingLines[existingIdx].trim() === nextPartialLine) break; result.push(existingLines[existingIdx]); existingIdx++; } }
        else { while (existingIdx < existingLines.length) { result.push(existingLines[existingIdx]); existingIdx++; } }
      } else {
        result.push(line);
        if (existingIdx < existingLines.length && existingLines[existingIdx].trim() === line.trim()) existingIdx++;
      }
    }
    return result.join('\n');
  }

  // ─── APPLY TOOL EDITS ───
  function applyToolEdits(projectDir, edits) {
    let safeWriteTsx = ctx.services.codeQuality?.safeWriteTsx;
    let applied = 0;
    let failed = 0;
    const failedEdits = [];
    for (const edit of edits) {
      const filePath = path.join(projectDir, edit.path);
      if (!fs.existsSync(filePath)) { console.warn(`[ToolEdit] File not found: ${edit.path}`); failed++; failedEdits.push(edit); continue; }
      let content = fs.readFileSync(filePath, 'utf8');
      let matched = false;
      if (edit.lineReplace) {
        const lines = content.split('\n');
        const start = Math.max(0, edit.startLine - 1);
        const end = Math.min(lines.length, edit.endLine);
        lines.splice(start, end - start, edit.newContent);
        content = lines.join('\n');
        if (safeWriteTsx && (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx"))) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
        applied++;
        continue;
      }
      if (content.includes(edit.search)) { content = content.replace(edit.search, edit.replace); matched = true; }
      if (!matched) { const trimSearch = edit.search.trim(); if (trimSearch && content.includes(trimSearch)) { content = content.replace(trimSearch, edit.replace.trim()); matched = true; } }
      if (!matched) {
        const normalizeWs = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n');
        const normalizedContent = normalizeWs(content);
        const normalizedSearch = normalizeWs(edit.search.trim());
        if (normalizedSearch && normalizedContent.includes(normalizedSearch)) {
          const searchLines = edit.search.trim().split('\n').map(l => l.trim()).filter(Boolean);
          const contentLines = content.split('\n');
          for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
            let lineMatch = true;
            for (let j = 0; j < searchLines.length; j++) { if (contentLines[i + j].trim() !== searchLines[j]) { lineMatch = false; break; } }
            if (lineMatch) { const originalBlock = contentLines.slice(i, i + searchLines.length).join('\n'); content = content.replace(originalBlock, edit.replace.trim()); matched = true; break; }
          }
        }
      }
      if (!matched) {
        const searchLines = edit.search.trim().split('\n').map(l => l.trim()).filter(Boolean);
        if (searchLines.length > 0) {
          const firstLine = searchLines[0]; const lastLine = searchLines[searchLines.length - 1];
          const contentLines = content.split('\n');
          for (let i = 0; i < contentLines.length; i++) {
            if (contentLines[i].trim() === firstLine) {
              for (let j = i + 1; j < Math.min(i + searchLines.length + 5, contentLines.length); j++) {
                if (contentLines[j].trim() === lastLine) { const originalBlock = contentLines.slice(i, j + 1).join('\n'); content = content.replace(originalBlock, edit.replace.trim()); matched = true; break; }
              }
              if (matched) break;
            }
          }
        }
      }
      if (matched) {
        if (safeWriteTsx && (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".jsx"))) safeWriteTsx(filePath, content); else fs.writeFileSync(filePath, content);
        applied++;
      } else { failed++; failedEdits.push(edit); console.warn(`[ToolEdit] FAILED on ${edit.path}: "${edit.search.substring(0, 80)}..." — no match`); }
    }
    if (failedEdits.length > 0) console.log(`[ToolEdit] ${failed} edit(s) failed — will be retried by follow-up`);
    return { applied, failed, failedEdits };
  }

  return {
    CODE_TOOLS,
    executeServerTool,
    htmlToText,
    parseToolResponse,
    toolResponseToCode,
    mergeEllipsis: mergeEllipsisFn,
    applyToolEdits,
    setDeps
  };
};
