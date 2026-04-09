// Unit tests for src/coherence.js — AST-based coherence checks for generated projects.
// Run with: node tests/coherence.test.js
//
// Coverage:
// - Import coherence: detects @/ imports pointing to non-existent files
// - DB column coherence: detects SQL queries using columns that don't exist in CREATE TABLE
// - API route coherence: detects frontend fetch() calls to undefined backend routes
// - Runtime checks: HTML structure validation, Vite log parsing
//
// All checks are designed to be WARNING-MODE: false positives must be very rare.
// Better to miss a real bug than to flag valid code.

const assert = require('assert');
const path = require('path');

// Lazy require — will fail if src/coherence.js doesn't exist yet (TDD red phase)
let coherence;
try {
  coherence = require('../src/coherence.js');
} catch (e) {
  console.error('Cannot load src/coherence.js:', e.message);
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function section(name) {
  console.log(`\n${name}:`);
}

console.log('\n=== Prestige Build Pro — Coherence Check Tests ===');

// ───────────────────────────────────────────────────────────────────────────
// IMPORT COHERENCE
// ───────────────────────────────────────────────────────────────────────────
section('Import coherence');

test('checkImportCoherence: all imports resolve → no issues', () => {
  const files = {
    'src/App.tsx': `import Home from '@/pages/Home';\nimport Header from '@/components/Header';\nexport default function App() { return <Home />; }`,
    'src/pages/Home.tsx': `export default function Home() { return <div />; }`,
    'src/components/Header.tsx': `export default function Header() { return <header />; }`
  };
  const issues = coherence.checkImportCoherence(files);
  assert.strictEqual(issues.length, 0, `expected 0 issues, got ${issues.length}: ${JSON.stringify(issues)}`);
});

test('checkImportCoherence: missing target file → 1 issue', () => {
  const files = {
    'src/App.tsx': `import Dashboard from '@/pages/Dashboard';\nexport default function App() { return <Dashboard />; }`
  };
  const issues = coherence.checkImportCoherence(files);
  assert.strictEqual(issues.length, 1, `expected 1 issue, got ${issues.length}`);
  assert.strictEqual(issues[0].type, 'MISSING_IMPORT');
  assert.ok(issues[0].message.includes('Dashboard'), `expected message to mention Dashboard, got: ${issues[0].message}`);
});

test('checkImportCoherence: UI component imports are always considered valid (canonical)', () => {
  const files = {
    'src/App.tsx': `import { Button } from '@/components/ui/button';\nimport { Card } from '@/components/ui/card';\nexport default function App() { return <Button />; }`
  };
  const issues = coherence.checkImportCoherence(files);
  assert.strictEqual(issues.length, 0);
});

test('checkImportCoherence: lib and hooks imports are always valid (canonical)', () => {
  const files = {
    'src/components/Foo.tsx': `import { cn } from '@/lib/utils';\nimport { useToast } from '@/hooks/useToast';\nexport default function Foo() { return null; }`
  };
  const issues = coherence.checkImportCoherence(files);
  assert.strictEqual(issues.length, 0);
});

test('checkImportCoherence: multiple missing imports across files → multiple issues', () => {
  // A.tsx exists → import A is OK. B and C don't exist → 2 issues.
  const files = {
    'src/App.tsx': `import A from '@/pages/A';\nimport B from '@/pages/B';\nexport default function App() { return <A />; }`,
    'src/pages/A.tsx': `import C from '@/components/C';\nexport default function A() { return <C />; }`
  };
  const issues = coherence.checkImportCoherence(files);
  assert.strictEqual(issues.length, 2, `expected 2 issues (B and C missing), got ${issues.length}`);
  assert.ok(issues.every(i => i.type === 'MISSING_IMPORT'));
  const messages = issues.map(i => i.message).join(' ');
  assert.ok(messages.includes('pages/B'), 'expected B to be flagged');
  assert.ok(messages.includes('components/C'), 'expected C to be flagged');
});

test('checkImportCoherence: import wrapped in string literal is ignored', () => {
  const files = {
    'src/App.tsx': `const docs = "import Foo from '@/pages/Foo';";\nexport default function App() { return <div>{docs}</div>; }`
  };
  const issues = coherence.checkImportCoherence(files);
  assert.strictEqual(issues.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// DB COLUMN COHERENCE
// ───────────────────────────────────────────────────────────────────────────
section('DB column coherence');

test('checkDbColumnCoherence: SELECT * → no issues (wildcard)', () => {
  const files = {
    'server.js': `db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER, email TEXT)");\napp.get('/api/users', (req,res) => { res.json(db.prepare('SELECT * FROM users').all()); });`
  };
  const issues = coherence.checkDbColumnCoherence(files);
  assert.strictEqual(issues.length, 0);
});

test('checkDbColumnCoherence: SELECT with valid columns → no issues', () => {
  const files = {
    'server.js': `db.exec(\`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT, name TEXT)\`);\nconst u = db.prepare('SELECT id, email, name FROM users WHERE id=?').get(1);`
  };
  const issues = coherence.checkDbColumnCoherence(files);
  assert.strictEqual(issues.length, 0, `expected 0, got: ${JSON.stringify(issues)}`);
});

test('checkDbColumnCoherence: SELECT with missing column → 1 issue', () => {
  const files = {
    'server.js': `db.exec(\`CREATE TABLE IF NOT EXISTS users (id INTEGER, email TEXT)\`);\ndb.prepare('SELECT id, firstName FROM users').all();`
  };
  const issues = coherence.checkDbColumnCoherence(files);
  assert.ok(issues.length >= 1, `expected at least 1 issue, got 0`);
  const missingCol = issues.find(i => i.type === 'UNKNOWN_COLUMN');
  assert.ok(missingCol, 'expected an UNKNOWN_COLUMN issue');
  assert.ok(missingCol.message.includes('firstName'), `expected message to mention firstName, got: ${missingCol.message}`);
});

test('checkDbColumnCoherence: INSERT with valid columns → no issues', () => {
  const files = {
    'server.js': `db.exec(\`CREATE TABLE IF NOT EXISTS posts (id INTEGER, title TEXT, body TEXT)\`);\ndb.prepare('INSERT INTO posts (title, body) VALUES (?, ?)').run('hi', 'world');`
  };
  const issues = coherence.checkDbColumnCoherence(files);
  assert.strictEqual(issues.length, 0);
});

test('checkDbColumnCoherence: query against unknown table is silently ignored', () => {
  // We don't flag unknown tables because the AI may use a table from another file
  // or rely on a migration we can't see. Stay conservative.
  const files = {
    'server.js': `db.prepare('SELECT id FROM unknown_table').get();`
  };
  const issues = coherence.checkDbColumnCoherence(files);
  assert.strictEqual(issues.length, 0);
});

test('checkDbColumnCoherence: empty files → no crash, no issues', () => {
  const issues = coherence.checkDbColumnCoherence({});
  assert.strictEqual(issues.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// API ROUTE COHERENCE
// ───────────────────────────────────────────────────────────────────────────
section('API route coherence');

test('checkApiRouteCoherence: frontend fetch matches backend route → no issues', () => {
  const files = {
    'server.js': `app.get('/api/users', (req,res) => res.json([]));\napp.post('/api/users', (req,res) => res.json({}));`,
    'src/pages/Users.tsx': `function load() { fetch('/api/users').then(r => r.json()); }\nfunction save() { fetch('/api/users', { method: 'POST' }); }`
  };
  const issues = coherence.checkApiRouteCoherence(files);
  assert.strictEqual(issues.length, 0, `expected 0, got: ${JSON.stringify(issues)}`);
});

test('checkApiRouteCoherence: frontend calls non-existent route → 1 issue', () => {
  const files = {
    'server.js': `app.get('/api/users', (req,res) => res.json([]));`,
    'src/pages/Dashboard.tsx': `fetch('/api/stats').then(r => r.json());`
  };
  const issues = coherence.checkApiRouteCoherence(files);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].type, 'MISSING_API_ROUTE');
  assert.ok(issues[0].message.includes('/api/stats'));
});

test('checkApiRouteCoherence: backend route with :param resolves frontend call with literal value', () => {
  const files = {
    'server.js': `app.get('/api/users/:id', (req,res) => res.json({}));`,
    'src/pages/User.tsx': `fetch('/api/users/' + userId).then(r => r.json());`
  };
  const issues = coherence.checkApiRouteCoherence(files);
  // The frontend uses a string concat — we should match the prefix /api/users/ to the param route
  assert.strictEqual(issues.length, 0, `expected 0, got: ${JSON.stringify(issues)}`);
});

test('checkApiRouteCoherence: backend route with template literal', () => {
  const files = {
    'server.js': `app.get('/api/users/:id', (req,res) => res.json({}));`,
    'src/pages/User.tsx': 'fetch(`/api/users/${userId}`).then(r => r.json());'
  };
  const issues = coherence.checkApiRouteCoherence(files);
  assert.strictEqual(issues.length, 0, `expected 0, got: ${JSON.stringify(issues)}`);
});

test('checkApiRouteCoherence: extra backend routes (not called by frontend) → no issue (OK)', () => {
  const files = {
    'server.js': `app.get('/api/users', (r,s) => s.json([]));\napp.get('/api/admin/stats', (r,s) => s.json({}));`,
    'src/pages/Home.tsx': `fetch('/api/users').then(r => r.json());`
  };
  const issues = coherence.checkApiRouteCoherence(files);
  assert.strictEqual(issues.length, 0);
});

test('checkApiRouteCoherence: external URLs (https://) are ignored', () => {
  const files = {
    'server.js': ``,
    'src/pages/Home.tsx': `fetch('https://api.stripe.com/v1/charges').then(r => r.json());\nfetch('https://api.example.com/data').then(r => r.json());`
  };
  const issues = coherence.checkApiRouteCoherence(files);
  assert.strictEqual(issues.length, 0);
});

test('checkApiRouteCoherence: empty files → no issues', () => {
  const issues = coherence.checkApiRouteCoherence({});
  assert.strictEqual(issues.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// RUNTIME / HTML CHECKS
// ───────────────────────────────────────────────────────────────────────────
section('Runtime checks');

test('parseViteLogs: detects compilation errors', () => {
  const logs = `vite v6.3.5 dev server running\n[vite] Internal server error: Failed to resolve import "@/pages/Dashboard"\nClick outside or fix the code to dismiss.`;
  const result = coherence.parseViteLogs(logs);
  assert.strictEqual(result.hasErrors, true);
  assert.ok(result.errors.length >= 1);
});

test('parseViteLogs: clean logs → no errors', () => {
  const logs = `vite v6.3.5 dev server running at http://0.0.0.0:5173/\n[vite] page reload src/App.tsx\n  ➜  Local:   http://localhost:5173/`;
  const result = coherence.parseViteLogs(logs);
  assert.strictEqual(result.hasErrors, false);
});

test('parseViteLogs: empty logs → no errors', () => {
  const result = coherence.parseViteLogs('');
  assert.strictEqual(result.hasErrors, false);
});

test('validateHtmlStructure: valid React shell → ok', () => {
  const html = `<!DOCTYPE html><html><head><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;
  const result = coherence.validateHtmlStructure(html);
  assert.strictEqual(result.ok, true);
});

test('validateHtmlStructure: missing root div → not ok', () => {
  const html = `<!DOCTYPE html><html><head><title>Test</title></head><body><script src="/src/main.tsx"></script></body></html>`;
  const result = coherence.validateHtmlStructure(html);
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes('root'));
});

test('validateHtmlStructure: missing script → not ok', () => {
  const html = `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`;
  const result = coherence.validateHtmlStructure(html);
  assert.strictEqual(result.ok, false);
});

test('validateHtmlStructure: empty body → not ok', () => {
  const result = coherence.validateHtmlStructure('');
  assert.strictEqual(result.ok, false);
});

// ───────────────────────────────────────────────────────────────────────────
// AGGREGATE / INTEGRATION
// ───────────────────────────────────────────────────────────────────────────
section('Aggregate runCoherenceChecks');

test('runCoherenceChecks: all clean → empty result', () => {
  const files = {
    'src/App.tsx': `import Home from '@/pages/Home';\nexport default function App() { return <Home />; }`,
    'src/pages/Home.tsx': `export default function Home() { return <div />; }`,
    'server.js': `db.exec(\`CREATE TABLE IF NOT EXISTS users (id INTEGER, email TEXT)\`);\napp.get('/api/users', (r,s) => s.json(db.prepare('SELECT id, email FROM users').all()));`
  };
  const result = coherence.runCoherenceChecks(files);
  assert.strictEqual(result.issues.length, 0);
  assert.ok(typeof result.stats === 'object');
});

test('runCoherenceChecks: malformed code → no crash, returns structured result', () => {
  const files = {
    'src/App.tsx': `import Foo from '@/' from broken { syntax`,
    'server.js': `db.prepare(\`SELECT FROM WHERE\`).all();\napp.get(`
  };
  // Should not throw
  const result = coherence.runCoherenceChecks(files);
  assert.ok(Array.isArray(result.issues));
  assert.ok(typeof result.stats === 'object');
});

test('runCoherenceChecks: all issues are warnings (V1 mode)', () => {
  const files = {
    'src/App.tsx': `import Missing from '@/pages/Missing';\nexport default function App() { return <Missing />; }`
  };
  const result = coherence.runCoherenceChecks(files);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every(i => i.severity === 'warning'),
    `expected all issues to be warnings, got: ${JSON.stringify(result.issues.map(i => i.severity))}`);
});

// ───────────────────────────────────────────────────────────────────────────
// PROJECT MEMORY INJECTION (Sprint B)
// ───────────────────────────────────────────────────────────────────────────
section('Project memory injection');

let ai;
try { ai = require('../src/ai.js'); } catch (e) { ai = null; }

test('buildConversationContext: memory is injected at top when present', () => {
  if (!ai || !ai.buildConversationContext) { console.log('  (skipped — ai module unavailable)'); return; }
  const project = { id: 1, title: 'Test', brief: 'cabinet medical', generated_code: '' };
  const memory = "Client n'aime pas le bleu.\nToujours sobre.";
  const ctx = ai.buildConversationContext(project, [], 'ajoute une page contact', [], null, memory);
  assert.ok(Array.isArray(ctx));
  assert.ok(ctx.length >= 1);
  const content = ctx.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  assert.ok(content.includes('MEMOIRE PROJET'), 'expected MEMOIRE PROJET marker');
  assert.ok(content.includes("n'aime pas le bleu"), 'expected memory content to be present');
});

test('buildConversationContext: no memory → no memory marker', () => {
  if (!ai || !ai.buildConversationContext) { console.log('  (skipped — ai module unavailable)'); return; }
  const project = { id: 1, title: 'Test', brief: 'site', generated_code: '' };
  const ctx = ai.buildConversationContext(project, [], 'hello', [], null, null);
  const content = ctx.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  assert.ok(!content.includes('MEMOIRE PROJET'), 'should NOT contain memory marker when none provided');
});

test('buildConversationContext: empty memory string is treated as no memory', () => {
  if (!ai || !ai.buildConversationContext) { console.log('  (skipped — ai module unavailable)'); return; }
  const project = { id: 1, title: 'Test', brief: 'site', generated_code: '' };
  const ctx = ai.buildConversationContext(project, [], 'hello', [], null, '   ');
  const content = ctx.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  assert.ok(!content.includes('MEMOIRE PROJET'));
});

// ───────────────────────────────────────────────────────────────────────────
// SUMMARY
// ───────────────────────────────────────────────────────────────────────────
console.log(`\n=== Results ===`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nFailures:`);
  failures.forEach(f => console.log(`  ✗ ${f.name}\n      ${f.error}`));
  process.exit(1);
}
console.log(`\nAll tests passed.\n`);
process.exit(0);
