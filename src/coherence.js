// ─── COHERENCE CHECKS — AST-style validation of generated projects ───
//
// Detects 3 classes of cross-file inconsistencies that the LLM can introduce
// when generating large projects in multi-turn pipelines:
//
//   1. Missing imports         — `@/...` imports pointing to non-existent files
//   2. Unknown DB columns      — SQL queries referencing columns absent from CREATE TABLE
//   3. Missing API routes      — frontend fetch() calls to backend routes that don't exist
//
// Plus runtime helpers used by the post-generation health check:
//   - parseViteLogs()          — extracts errors from Vite container logs
//   - validateHtmlStructure()  — sanity check on the served index.html
//
// All checks are designed to be CONSERVATIVE:
//   - Better to miss a real bug than to flag valid code
//   - All issues emitted with severity='warning' (zero auto-fix risk in V1)
//   - No external dependencies (regex/string parsing only, no real AST library)
//   - Defensive against malformed input (never throws)
//
// Wired into server.js post-generation pipeline via runCoherenceChecks(files).

'use strict';

// ─── Constants ───
// Files that always exist in the canonical template (we never flag imports targeting them)
const CANONICAL_PREFIXES = [
  'components/ui/',
  'lib/',
  'hooks/'
];
const CANONICAL_FILES = new Set([
  'lib/utils',
  'hooks/useToast',
  'hooks/useIsMobile',
  'main',
]);

// ───────────────────────────────────────────────────────────────────────────
// IMPORT COHERENCE
// ───────────────────────────────────────────────────────────────────────────
// Parses `import X from '@/path'` statements in .tsx/.ts/.jsx/.js files and
// verifies that the target file exists in the project.
//
// Conservative rules:
// - Only @/ alias imports are checked (relative imports are skipped — too noisy)
// - Imports inside string literals are skipped (heuristic: line must start with `import`)
// - Canonical paths (components/ui/*, lib/*, hooks/*) are always considered valid
function checkImportCoherence(files) {
  const issues = [];
  if (!files || typeof files !== 'object') return issues;

  // Build a Set of normalized file paths (without extension) for O(1) lookup
  const fileIndex = new Set();
  for (const fn of Object.keys(files)) {
    if (!fn.startsWith('src/')) continue;
    // src/pages/Home.tsx → pages/Home
    const normalized = fn.replace(/^src\//, '').replace(/\.(tsx|ts|jsx|js)$/, '');
    fileIndex.add(normalized);
  }

  // Match `import ... from '@/path'` only at the start of a line (not in strings/comments)
  const IMPORT_RE = /^\s*import\s+[^;]+?from\s+['"]@\/([^'"]+)['"]/gm;

  for (const [fn, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (!/\.(tsx|ts|jsx|js)$/.test(fn)) continue;

    let match;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      const importPath = match[1];

      // Canonical: always valid
      if (CANONICAL_PREFIXES.some(p => importPath.startsWith(p))) continue;
      if (CANONICAL_FILES.has(importPath)) continue;

      // Strip trailing extension if any (for comparison)
      const normalized = importPath.replace(/\.(tsx|ts|jsx|js)$/, '');
      if (fileIndex.has(normalized)) continue;

      issues.push({
        file: fn,
        type: 'MISSING_IMPORT',
        severity: 'warning',
        message: `Import '@/${importPath}' but file not found in project`,
        hint: `Did the AI generate ${normalized}.tsx?`
      });
    }
  }

  return issues;
}

// ───────────────────────────────────────────────────────────────────────────
// DB COLUMN COHERENCE
// ───────────────────────────────────────────────────────────────────────────
// Extracts column names from CREATE TABLE statements and compares them to
// columns referenced in SELECT/INSERT/UPDATE queries within the same file (server.js).
//
// Conservative rules:
// - Wildcards (SELECT *) are always OK
// - Queries against unknown tables are silently ignored (we don't fail-loud on missing migrations)
// - Aggregate functions (COUNT(*), MAX(col)) are extracted properly
// - Aliases (SELECT col AS x) → only the real column is validated
// - Reserved SQL keywords are filtered out
function checkDbColumnCoherence(files) {
  const issues = [];
  if (!files || typeof files !== 'object') return issues;

  // Process each file independently. Each file has its own table schema scope.
  for (const [fn, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (!fn.endsWith('.js') && !fn.endsWith('.ts')) continue;

    const tables = parseCreateTables(content);
    if (Object.keys(tables).length === 0) continue; // no schema, nothing to validate

    const queries = extractDbQueries(content);
    for (const q of queries) {
      const tableSchema = tables[q.table];
      if (!tableSchema) continue; // unknown table — skip silently (could be from another file)

      for (const col of q.columns) {
        if (col === '*') continue;
        if (tableSchema.has(col)) continue;
        // Skip reserved/aggregate keywords that slip through
        if (isReservedSqlKeyword(col)) continue;
        issues.push({
          file: fn,
          type: 'UNKNOWN_COLUMN',
          severity: 'warning',
          message: `SQL ${q.kind} on '${q.table}' references column '${col}' which is not in CREATE TABLE`,
          hint: `Known columns: ${Array.from(tableSchema).join(', ')}`
        });
      }
    }
  }

  return issues;
}

// Parse CREATE TABLE statements (supports IF NOT EXISTS, multi-line)
function parseCreateTables(code) {
  const tables = {};
  // Match: CREATE TABLE [IF NOT EXISTS] name ( column_def, column_def, ... )
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^;]*?)\)\s*(?:;|`)/gis;
  let m;
  while ((m = re.exec(code)) !== null) {
    const tableName = m[1];
    const body = m[2];
    const cols = parseColumnDefinitions(body);
    if (cols.size > 0) tables[tableName] = cols;
  }
  return tables;
}

// Parses the body of a CREATE TABLE — extracts column names from definitions
// like "id INTEGER PRIMARY KEY, email TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id)"
function parseColumnDefinitions(body) {
  const cols = new Set();
  // Split by comma, but respect parens (for FOREIGN KEY(a,b))
  const parts = splitTopLevel(body, ',');
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    // Skip table-level constraints
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part)) continue;
    // First identifier is the column name
    const m = part.match(/^["`]?(\w+)["`]?/);
    if (m) cols.add(m[1]);
  }
  return cols;
}

// Splits a string by `sep` while respecting parenthesis depth
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === sep && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current) out.push(current);
  return out;
}

// Extracts SQL queries from db.prepare(...) / db.exec(...) calls
// Returns: [{ kind: 'SELECT'|'INSERT'|'UPDATE', table, columns: [] }, ...]
function extractDbQueries(code) {
  const queries = [];

  // Match db.prepare("...") and db.prepare(`...`) and similar
  // Capture the SQL string contents (handles ', ", and `)
  const prepRe = /db\.(?:prepare|exec)\s*\(\s*([`'"])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = prepRe.exec(code)) !== null) {
    const sql = m[2];
    // Remove SQL comments
    const cleanSql = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    parseSqlStatements(cleanSql, queries);
  }

  return queries;
}

function parseSqlStatements(sql, out) {
  // Try SELECT
  const selectMatch = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+["`]?(\w+)["`]?/i);
  if (selectMatch) {
    const colList = selectMatch[1].trim();
    const table = selectMatch[2];
    if (colList === '*' || colList.includes('*')) {
      // wildcard — no specific columns to check
      out.push({ kind: 'SELECT', table, columns: ['*'] });
    } else {
      const cols = parseSelectColumns(colList);
      out.push({ kind: 'SELECT', table, columns: cols });
    }
  }

  // Try INSERT INTO table (col1, col2) VALUES
  const insertMatch = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?(\w+)["`]?\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const table = insertMatch[1];
    const cols = insertMatch[2].split(',').map(c => c.trim().replace(/^["`]|["`]$/g, '')).filter(Boolean);
    out.push({ kind: 'INSERT', table, columns: cols });
  }

  // Try UPDATE table SET col1=?, col2=?
  const updateMatch = sql.match(/UPDATE\s+["`]?(\w+)["`]?\s+SET\s+([\s\S]+?)(?:\s+WHERE|\s*$)/i);
  if (updateMatch) {
    const table = updateMatch[1];
    const setClause = updateMatch[2];
    const cols = setClause.split(',').map(s => {
      const eq = s.split('=')[0];
      return eq.trim().replace(/^["`]|["`]$/g, '');
    }).filter(Boolean);
    out.push({ kind: 'UPDATE', table, columns: cols });
  }
}

// Parses a SELECT column list, handling: col1, col2 AS x, COUNT(*) AS y, table.col, MAX(col)
function parseSelectColumns(colList) {
  const out = [];
  const parts = splitTopLevel(colList, ',');
  for (const raw of parts) {
    let part = raw.trim();
    // Strip alias: "col AS name" → "col"
    part = part.replace(/\s+AS\s+\w+\s*$/i, '');
    // Wildcard
    if (part === '*' || part.endsWith('.*')) continue;
    // Aggregate function: COUNT(*), MAX(col), etc. — extract inner column if any
    const fnMatch = part.match(/^\w+\s*\(\s*([^)]*)\s*\)/);
    if (fnMatch) {
      const inner = fnMatch[1].trim();
      if (inner === '*' || inner === '') continue;
      // recurse for nested
      out.push(...parseSelectColumns(inner));
      continue;
    }
    // Qualified: "users.email" → "email"
    const qualMatch = part.match(/^\w+\.(\w+)$/);
    if (qualMatch) { out.push(qualMatch[1]); continue; }
    // Plain identifier
    const idMatch = part.match(/^["`]?(\w+)["`]?$/);
    if (idMatch) { out.push(idMatch[1]); continue; }
    // Anything else (expression, literal) → ignore
  }
  return out;
}

const SQL_KEYWORDS = new Set([
  'NULL', 'TRUE', 'FALSE', 'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE',
  'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'ON',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'USING',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
  'COUNT', 'SUM', 'MAX', 'MIN', 'AVG', 'DISTINCT', 'ALL', 'ANY',
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME'
]);
function isReservedSqlKeyword(word) {
  return SQL_KEYWORDS.has(word.toUpperCase());
}

// ───────────────────────────────────────────────────────────────────────────
// API ROUTE COHERENCE
// ───────────────────────────────────────────────────────────────────────────
// Cross-file check: extract routes defined in server.js (app.get/post/put/delete)
// and routes called in frontend files (fetch('/api/...')). Flag frontend calls
// to routes that don't exist on the backend.
//
// Conservative rules:
// - External URLs (http://, https://) are ignored
// - Backend routes with :params match frontend prefixes (e.g., /api/users/:id matches /api/users/123)
// - Template literals are partially handled (extract literal prefix)
// - Frontend routes not called by backend → no issue (extras are OK)
function checkApiRouteCoherence(files) {
  const issues = [];
  if (!files || typeof files !== 'object') return issues;

  // 1. Extract backend routes
  const backendRoutes = []; // [{ method, path, paramRegex }]
  const serverContent = files['server.js'] || '';
  if (typeof serverContent === 'string' && serverContent.length > 0) {
    const ROUTE_RE = /app\.(get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi;
    let m;
    while ((m = ROUTE_RE.exec(serverContent)) !== null) {
      const method = m[1].toLowerCase();
      const routePath = m[2];
      backendRoutes.push({
        method,
        path: routePath,
        paramRegex: routePathToRegex(routePath)
      });
    }
  }

  // 2. Extract frontend fetch calls and validate against backend routes
  for (const [fn, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (!/\.(tsx|ts|jsx|js)$/.test(fn)) continue;
    if (fn === 'server.js') continue; // skip backend itself

    const frontendCalls = extractFetchCalls(content);
    for (const call of frontendCalls) {
      // External URL: skip
      if (/^https?:\/\//i.test(call.path)) continue;
      // Not /api/: skip (could be a static asset or relative URL)
      if (!call.path.startsWith('/api/')) continue;

      const matched = backendRoutes.some(r => r.paramRegex.test(call.path));
      if (!matched) {
        issues.push({
          file: fn,
          type: 'MISSING_API_ROUTE',
          severity: 'warning',
          message: `Frontend calls '${call.path}' but no matching app.get/post/put/delete found in server.js`,
          hint: `Did the AI forget to add the backend route?`
        });
      }
    }
  }

  return issues;
}

// Converts a route path like /api/users/:id to a RegExp that matches concrete paths
// like /api/users/123 or /api/users/abc
function routePathToRegex(routePath) {
  // Escape regex special chars except `:` for params
  const escaped = routePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Replace :param with regex match-non-slash
  const withParams = escaped.replace(/:(\w+)/g, '[^/?]+');
  // Allow trailing query string or extra segments? Be strict for now.
  return new RegExp('^' + withParams + '(?:[/?].*)?$');
}

// Extracts fetch('...') and fetch(`...`) calls. For template literals, extracts
// the literal prefix (everything before the first ${...}) so we can still match.
//
// Important: a `fetch('/api/users/' + id)` call must NOT produce both a plain
// match ('/api/users/') AND a concat match ('/api/users/X'). The plain regex
// uses a negative lookahead to skip strings followed by `+`.
function extractFetchCalls(code) {
  const calls = [];
  // Plain string: fetch('/api/foo') or fetch("/api/foo"), but NOT followed by +
  // The (?!\s*\+) lookahead excludes string-concat patterns which are handled separately.
  const plainRe = /fetch\s*\(\s*(['"])([^'"]+)\1(?!\s*\+)/g;
  let m;
  while ((m = plainRe.exec(code)) !== null) {
    calls.push({ path: m[2] });
  }
  // Template literal: fetch(`/api/users/${id}`) → replace ${...} with a placeholder
  const tplRe = /fetch\s*\(\s*`([^`]*)`/g;
  while ((m = tplRe.exec(code)) !== null) {
    const tpl = m[1];
    const literalized = tpl.replace(/\$\{[^}]+\}/g, 'X');
    calls.push({ path: literalized });
  }
  // String concat: fetch('/api/users/' + userId) — extract literal prefix + 'X' placeholder
  // so it matches :param backend routes via routePathToRegex.
  const concatRe = /fetch\s*\(\s*['"]([^'"]+)['"]\s*\+/g;
  while ((m = concatRe.exec(code)) !== null) {
    calls.push({ path: m[1] + 'X' });
  }
  return calls;
}

// ───────────────────────────────────────────────────────────────────────────
// RUNTIME / HTML CHECKS (used after generation when the container is up)
// ───────────────────────────────────────────────────────────────────────────

// Parses Vite container logs and returns the list of compilation/runtime errors.
// Used by the post-generation HTTP health check.
function parseViteLogs(logs) {
  if (typeof logs !== 'string' || logs.length === 0) {
    return { hasErrors: false, errors: [] };
  }
  const errors = [];
  const lines = logs.split('\n');
  // Conservative regex: only true errors, not generic words
  const errorPatterns = [
    /\[vite\][^\n]*error/i,
    /\[vite\][^\n]*Failed to (resolve|compile|load)/i,
    /SyntaxError:/,
    /TypeError:/,
    /ReferenceError:/,
    /\bERR_[A-Z_]+/,
    /Cannot find module/,
    /Module not found/,
    /Unexpected token/
  ];
  for (const line of lines) {
    if (errorPatterns.some(re => re.test(line))) {
      errors.push(line.trim());
    }
  }
  return { hasErrors: errors.length > 0, errors };
}

// Quick sanity check on the served HTML shell. Catches:
// - server.js crashed (no HTML returned)
// - index.html missing the React mount point
// - bundles not loaded
function validateHtmlStructure(html) {
  if (typeof html !== 'string' || html.length < 50) {
    return { ok: false, reason: 'empty or too short HTML response' };
  }
  if (!/<div[^>]*id\s*=\s*["']root["']/i.test(html)) {
    return { ok: false, reason: 'missing <div id="root"> mount point' };
  }
  if (!/<script[^>]*src\s*=/i.test(html) && !/<script[^>]*type\s*=\s*["']module["']/i.test(html)) {
    return { ok: false, reason: 'no <script> tag found — bundles not loaded' };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// AGGREGATE — runCoherenceChecks() is the main entry point
// ───────────────────────────────────────────────────────────────────────────
// Runs all 3 static checks and returns a structured result.
// Never throws, even on malformed input.
function runCoherenceChecks(files) {
  const allIssues = [];
  const stats = { import: 0, db: 0, api: 0, total: 0 };

  try {
    const importIssues = checkImportCoherence(files);
    stats.import = importIssues.length;
    allIssues.push(...importIssues);
  } catch (e) {
    // Defensive: never crash the caller
    stats.importError = e.message;
  }

  try {
    const dbIssues = checkDbColumnCoherence(files);
    stats.db = dbIssues.length;
    allIssues.push(...dbIssues);
  } catch (e) {
    stats.dbError = e.message;
  }

  try {
    const apiIssues = checkApiRouteCoherence(files);
    stats.api = apiIssues.length;
    allIssues.push(...apiIssues);
  } catch (e) {
    stats.apiError = e.message;
  }

  stats.total = allIssues.length;
  return { issues: allIssues, stats };
}

module.exports = {
  // Main entry point
  runCoherenceChecks,
  // Individual checks (for testing + targeted re-runs)
  checkImportCoherence,
  checkDbColumnCoherence,
  checkApiRouteCoherence,
  // Runtime helpers
  parseViteLogs,
  validateHtmlStructure,
  // Internal helpers exposed for advanced use / testing
  parseCreateTables,
  extractDbQueries,
  routePathToRegex,
  extractFetchCalls
};
