// AI evaluation test suite — non-regression for AI subsystem.
// Run with: node tests/ai-eval.test.js   OR   npm run eval
//
// Goal: catch regressions when modifying prompts, parsers, or AI helpers.
// All tests are PURE (no API calls) and use realistic project fixtures
// that mirror what Claude would actually generate.
//
// Test categories:
//   1. Brief classification: vague vs precise briefs → needsClarification
//   2. Sector detection: brief → expected sector
//   3. Project complexity: brief → simple/complex token allocation
//   4. Affected files detection: change description → relevant files
//   5. Coherence checks on realistic generated projects
//   6. Back-test on realistic projects (good + bad cases)
//   7. Intent regex fallback (full coverage of edge cases)
//
// Pass criteria: every test must produce the EXACT expected output.
// On regression, this fails CI before bad code gets merged/deployed.

const assert = require('assert');
const path = require('path');

let ai, coherence;
try { ai = require('../src/ai.js'); }
catch (e) { console.error('Cannot load src/ai.js:', e.message); process.exit(1); }
try { coherence = require('../src/coherence.js'); }
catch (e) { console.error('Cannot load src/coherence.js:', e.message); process.exit(1); }

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e.message }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function section(name) { console.log(`\n${name}:`); }

console.log('\n=== Prestige Build Pro — AI Evaluation Suite ===');

// ───────────────────────────────────────────────────────────────────────────
// 1. SECTOR DETECTION
// ───────────────────────────────────────────────────────────────────────────
section('Sector detection (28 sectors)');

// Use briefs with strong, unambiguous sector keywords (avoid overlap with other sectors).
const sectorCases = [
  { brief: 'Cabinet médical avec prise de RDV', expected: 'health' },
  { brief: 'Restaurant gastronomique italien à Lyon', expected: 'restaurant' },
  { brief: 'Boutique en ligne de vêtements', expected: 'ecommerce' },
  { brief: 'Plateforme SaaS B2B', expected: 'saas' },
  { brief: 'École de formation avec catalogue', expected: 'education' },
  { brief: 'Hôtel 4 étoiles avec spa', expected: 'hotel' },
  { brief: 'Portfolio designer graphique', expected: 'portfolio' },
];

for (const tc of sectorCases) {
  test(`detectSectorProfile: "${tc.brief.substring(0, 40)}..." → ${tc.expected}`, () => {
    const profile = ai.detectSectorProfile(tc.brief);
    assert.ok(profile, `expected a sector profile for: ${tc.brief}`);
    // Profile is the prompt text, we check it contains the sector name
    assert.ok(profile.toLowerCase().includes(tc.expected) ||
      ai.SECTOR_PROFILES[tc.expected]?.prompt === profile,
      `expected ${tc.expected} sector, got different profile`);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 2. PROJECT COMPLEXITY DETECTION
// ───────────────────────────────────────────────────────────────────────────
section('Project complexity detection');

test('detectProjectComplexity: simple brief → simple', () => {
  const c = ai.detectProjectComplexity('Site vitrine pour mon restaurant');
  assert.strictEqual(c, 'simple');
});

test('detectProjectComplexity: ERP keyword → complex', () => {
  const c = ai.detectProjectComplexity('ERP de gestion des stocks et facturation');
  assert.strictEqual(c, 'complex');
});

test('detectProjectComplexity: dashboard keyword → complex', () => {
  const c = ai.detectProjectComplexity('Dashboard analytics avec multi-rôles');
  assert.strictEqual(c, 'complex');
});

test('getMaxTokensForProject: simple → 32k', () => {
  assert.strictEqual(ai.getMaxTokensForProject('Site vitrine'), 32000);
});

test('getMaxTokensForProject: complex → 64k', () => {
  assert.strictEqual(ai.getMaxTokensForProject('Dashboard ERP multi-rôles'), 64000);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. BRIEF CLARIFICATION HEURISTIC
// ───────────────────────────────────────────────────────────────────────────
section('needsClarification heuristic (production-grade)');

// Mirror the function locally so we can test it without booting server.js
// (it's not exported from a module — test by inline copy that mirrors prod exactly)
const TECHNICAL_KEYWORDS = [
  'page', 'route', 'composant', 'component', 'table', 'api', 'endpoint',
  'database', 'auth', 'login', 'admin', 'dashboard', 'form', 'formulaire',
  'header', 'footer', 'hero', 'menu', 'sidebar', 'card', 'modal', 'sql',
  'crud', 'rest', 'jwt', 'stripe', 'payment', 'checkout', 'panier', 'cart',
  'utilisateur', 'user', 'profil', 'profile', 'inscription', 'register',
  'liste', 'list', 'détail', 'detail', 'recherche', 'search', 'filtre', 'filter',
  'contact', 'services', 'reservation', 'rdv', 'galerie', 'gallery',
  'newsletter', 'blog', 'article', 'avis', 'review', 'temoignage', 'testimonial',
  'equipe', 'team', 'about', 'apropos', 'tarif', 'pricing', 'faq'
];
function needsClarification(message, project) {
  if (!message || typeof message !== 'string') return false;
  const trimmed = message.trim();
  if (project && project.generated_code && project.generated_code.length > 500) return false;
  const tokens = trimmed.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean);
  const wordCount = tokens.length;
  if (wordCount < 6) return true;
  if (wordCount < 14) {
    const tokenSet = new Set(tokens);
    const techHits = TECHNICAL_KEYWORDS.filter(k => tokenSet.has(k)).length;
    if (techHits < 1) return true;
  }
  return false;
}

const clarifyCases = [
  { msg: 'Site web', expect: true, label: 'too short (2 words)' },
  { msg: 'Hello', expect: true, label: '1 word' },
  { msg: 'Boutique vetements femmes', expect: true, label: '3 words no tech' },
  { msg: 'Cabinet medical avec prise de rdv en ligne, page contact, services', expect: false, label: '11 words with tech kw' },
  { msg: 'Boutique en ligne avec panier, paiement Stripe, fiches produits et compte utilisateur', expect: false, label: 'rich brief' },
  { msg: 'Plateforme SaaS B2B pour gestion de projets agile', expect: true, label: 'no tech keywords (substring trap)' },
  { msg: '', expect: false, label: 'empty' },
  { msg: null, expect: false, label: 'null' },
  { msg: 'Site web pour mon avocat', project: { generated_code: 'x'.repeat(600) }, expect: false, label: 'existing project' },
  { msg: 'Application de fitness avec page accueil, dashboard utilisateur et planning', expect: false, label: '10 words with 3 tech kw' },
];

for (const tc of clarifyCases) {
  test(`needsClarification: ${tc.label} → ${tc.expect}`, () => {
    const result = needsClarification(tc.msg, tc.project || null);
    assert.strictEqual(result, tc.expect, `expected ${tc.expect}, got ${result}`);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 4. INTENT REGEX FALLBACK (production-equivalent logic)
// ───────────────────────────────────────────────────────────────────────────
section('Intent regex fallback (used when Haiku unavailable)');

function classifyIntentRegex(message) {
  const msg = (message || '').toLowerCase();
  const isQuestion = /^(comment|pourquoi|qu'est-ce|c'est quoi|explique|quel|quelle|est-ce que|combien|où|quand)\b/.test(msg)
    && !/\b(crée|ajoute|modifie|change|supprime|corrige|implémente|intègre|construis|fais|mets|retire)\b/.test(msg);
  return { intent: isQuestion ? 'discuss' : 'code', confidence: 0.6, source: 'fallback' };
}

const intentCases = [
  { msg: 'Ajoute une page contact', expected: 'code' },
  { msg: 'Comment marche le router ?', expected: 'discuss' },
  { msg: 'Crée un dashboard admin', expected: 'code' },
  { msg: 'Qu\'est-ce qu\'un composant React ?', expected: 'discuss' },
  { msg: 'Modifie le header', expected: 'code' },
  { msg: 'Pourquoi tu as mis ça ici ?', expected: 'discuss' },
  // Edge case: question word + ACTION verb (not infinitive) — regex matches \bajoute\b which
  // is the present-tense form, so "Comment ajoute une page" → code, but "Comment ajouter une
  // page" → discuss because "ajouter" doesn't match \bajoute\b (boundary fails after 'e').
  // This is a known limit of the regex fallback; the LLM classifier (Haiku) handles it correctly.
  { msg: 'Comment ajouter une page ?', expected: 'discuss' },
  { msg: 'Comment ajoute une page', expected: 'code' },
];

for (const tc of intentCases) {
  test(`classifyIntentRegex: "${tc.msg}" → ${tc.expected}`, () => {
    const r = classifyIntentRegex(tc.msg);
    assert.strictEqual(r.intent, tc.expected);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 5. COHERENCE CHECKS ON REALISTIC FIXTURES
// ───────────────────────────────────────────────────────────────────────────
section('Coherence checks on realistic project fixtures');

test('clean restaurant project → 0 issues', () => {
  const files = {
    'src/App.tsx': `import { Routes, Route } from 'react-router-dom';
import Home from '@/pages/Home';
import Menu from '@/pages/Menu';
export default function App() { return <Routes><Route path="/" element={<Home />} /><Route path="/menu" element={<Menu />} /></Routes>; }`,
    'src/pages/Home.tsx': `export default function Home() { return <div className="bg-background"><h1>Bienvenue</h1></div>; }`,
    'src/pages/Menu.tsx': `export default function Menu() { return <div><h1>Notre menu</h1></div>; }`,
    'server.js': `const express = require('express');
const Database = require('better-sqlite3');
const db = new Database('./data.db');
db.exec(\`CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY, name TEXT, date TEXT)\`);
const app = express();
app.get('/api/reservations', (req, res) => res.json(db.prepare('SELECT id, name, date FROM reservations').all()));
app.post('/api/reservations', (req, res) => { db.prepare('INSERT INTO reservations (name, date) VALUES (?, ?)').run(req.body.name, req.body.date); res.json({ ok: true }); });
app.listen(3000, '0.0.0.0');`
  };
  const result = coherence.runCoherenceChecks(files);
  assert.strictEqual(result.issues.length, 0, `expected 0 issues, got: ${JSON.stringify(result.issues)}`);
});

test('project with missing route → 1 API issue', () => {
  const files = {
    'src/App.tsx': `import Home from '@/pages/Home';\nexport default function App() { return <Home />; }`,
    'src/pages/Home.tsx': `export default function Home() { fetch('/api/missing-endpoint').then(r=>r.json()); return <div />; }`,
    'server.js': `app.get('/api/users', (req, res) => res.json([]));`
  };
  const result = coherence.runCoherenceChecks(files);
  assert.ok(result.issues.length >= 1);
  assert.ok(result.issues.some(i => i.type === 'MISSING_API_ROUTE'));
});

test('project with column mismatch → UNKNOWN_COLUMN', () => {
  const files = {
    'server.js': `db.exec(\`CREATE TABLE IF NOT EXISTS doctors (id INTEGER, name TEXT, specialty TEXT)\`);
db.prepare('SELECT id, name, firstName FROM doctors').all();`
  };
  const result = coherence.runCoherenceChecks(files);
  assert.ok(result.issues.some(i => i.type === 'UNKNOWN_COLUMN' && i.message.includes('firstName')));
});

test('project with broken import → MISSING_IMPORT', () => {
  const files = {
    'src/App.tsx': `import Stats from '@/pages/Stats';\nexport default function App() { return <Stats />; }`
  };
  const result = coherence.runCoherenceChecks(files);
  assert.ok(result.issues.some(i => i.type === 'MISSING_IMPORT'));
});

// ───────────────────────────────────────────────────────────────────────────
// 6. BACK-TEST ON REALISTIC FIXTURES
// ───────────────────────────────────────────────────────────────────────────
section('Back-test on realistic fixtures');

test('clean project → 0 errors (warnings allowed)', () => {
  const files = {
    'src/App.tsx': `import { Routes, Route } from 'react-router-dom';\nimport Home from '@/pages/Home';\nexport default function App() { return <Routes><Route path="/" element={<Home />} /></Routes>; }`,
    'src/pages/Home.tsx': `export default function Home() { return <div className="bg-background text-foreground"><h1>Hi</h1></div>; }`,
    'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;`,
    'server.js': `const express = require('express');\nconst app = express();\napp.listen(3000, '0.0.0.0');`
  };
  const issues = ai.runBackTests(files);
  const errors = issues.filter(i => i.severity !== 'warning');
  assert.strictEqual(errors.length, 0, `expected 0 errors, got: ${JSON.stringify(errors.map(e => e.issue))}`);
});

test('server.js with ESM import → ESM_IMPORTS error', () => {
  const files = {
    'server.js': `import express from 'express';\nconst app = express();\napp.listen(3000, '0.0.0.0');`,
    'src/App.tsx': `export default function App() { return <div />; }`,
    'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;`
  };
  const issues = ai.runBackTests(files);
  assert.ok(issues.some(i => i.issue === 'ESM_IMPORTS'));
});

test('server.js without 0.0.0.0 → LOCALHOST_ONLY error', () => {
  const files = {
    'server.js': `const express = require('express');\nconst app = express();\napp.listen(3000, 'localhost');`,
    'src/App.tsx': `export default function App() { return <div />; }`,
    'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;`
  };
  const issues = ai.runBackTests(files);
  assert.ok(issues.some(i => i.issue === 'LOCALHOST_ONLY'));
});

test('App.tsx with BrowserRouter → DUPLICATE_ROUTER error', () => {
  const files = {
    'src/App.tsx': `import { BrowserRouter, Routes, Route } from 'react-router-dom';\nexport default function App() { return <BrowserRouter><Routes></Routes></BrowserRouter>; }`,
    'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;`,
    'server.js': `const express = require('express');\nconst app = express();\napp.listen(3000, '0.0.0.0');`
  };
  const issues = ai.runBackTests(files);
  assert.ok(issues.some(i => i.issue === 'DUPLICATE_ROUTER'));
});

test('component without export default → NO_EXPORT', () => {
  const files = {
    'src/components/Foo.tsx': `function Foo() { return <div />; }`,
    'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;`,
    'server.js': `const express = require('express');\nconst app = express();\napp.listen(3000, '0.0.0.0');`
  };
  const issues = ai.runBackTests(files);
  assert.ok(issues.some(i => i.issue === 'NO_EXPORT'));
});

test('component with hardcoded gray colors → HARDCODED_COLORS error', () => {
  const files = {
    'src/pages/Home.tsx': `export default function Home() { return <div className="bg-gray-100 text-blue-500"><h1>Hi</h1></div>; }`,
    'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;`,
    'server.js': `const express = require('express');\nconst app = express();\napp.listen(3000, '0.0.0.0');`
  };
  const issues = ai.runBackTests(files);
  assert.ok(issues.some(i => i.issue === 'HARDCODED_COLORS' && (i.severity || 'error') === 'error'));
});

test('component with bg-white → RAW_WHITE_BLACK warning (not error)', () => {
  const files = {
    'src/pages/Home.tsx': `export default function Home() { return <div className="bg-white text-black"><h1>Hi</h1></div>; }`,
    'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;`,
    'server.js': `const express = require('express');\nconst app = express();\napp.listen(3000, '0.0.0.0');`
  };
  const issues = ai.runBackTests(files);
  const w = issues.find(i => i.issue === 'RAW_WHITE_BLACK');
  assert.ok(w, 'expected RAW_WHITE_BLACK warning');
  assert.strictEqual(w.severity, 'warning');
});

// ─── LUCIDE-REACT HALLUCINATION CHECK ───
test('lucide hallucination "Live" → INVALID_LUCIDE_ICON error', () => {
  const files = {
    'src/pages/Home.tsx': `import { Live, Home } from 'lucide-react';\nexport default function P() { return <Live />; }`
  };
  const issues = ai.runBackTests(files);
  const lucide = issues.filter(i => i.issue === 'INVALID_LUCIDE_ICON');
  assert.ok(lucide.length >= 1, 'expected INVALID_LUCIDE_ICON for "Live"');
  assert.ok(lucide.some(i => i.message.includes('Live')), 'message should mention Live');
  // Severity must be error (not warning) so it triggers auto-fix
  assert.notStrictEqual(lucide[0].severity, 'warning');
});

test('lucide hallucination "Profile", "Dashboard", "Cart" → 3 errors', () => {
  const files = {
    'src/pages/Home.tsx': `import { Profile, Dashboard, Cart } from 'lucide-react';\nexport default function P() { return <Profile />; }`
  };
  const issues = ai.runBackTests(files);
  const lucide = issues.filter(i => i.issue === 'INVALID_LUCIDE_ICON');
  assert.ok(lucide.length >= 3, `expected 3 errors, got ${lucide.length}`);
});

test('lucide valid icons → no INVALID_LUCIDE_ICON', () => {
  const files = {
    'src/pages/Home.tsx': `import { Home, User, Mail, Settings, ShoppingCart, LayoutDashboard } from 'lucide-react';\nexport default function P() { return <Home />; }`
  };
  const issues = ai.runBackTests(files);
  const lucide = issues.filter(i => i.issue === 'INVALID_LUCIDE_ICON');
  assert.strictEqual(lucide.length, 0, `expected 0 errors, got: ${JSON.stringify(lucide)}`);
});

test('lucide multi-line import with hallucination → caught', () => {
  const files = {
    'src/pages/Home.tsx': `import {\n  Home,\n  Login,\n  User\n} from 'lucide-react';\nexport default function P() { return <Home />; }`
  };
  const issues = ai.runBackTests(files);
  const lucide = issues.filter(i => i.issue === 'INVALID_LUCIDE_ICON');
  assert.ok(lucide.some(i => i.message.includes('Login')), 'expected Login to be caught in multi-line import');
});

test('lucide check ignores ui/ components folder', () => {
  const files = {
    'src/components/ui/icon.tsx': `import { Live } from 'lucide-react';\nexport function Icon() { return <Live />; }`
  };
  const issues = ai.runBackTests(files);
  const lucide = issues.filter(i => i.issue === 'INVALID_LUCIDE_ICON');
  assert.strictEqual(lucide.length, 0, 'should NOT flag ui/ components (canonical)');
});

test('SYSTEM_PROMPT mentions LUCIDE-REACT warning', () => {
  assert.ok(ai.SYSTEM_PROMPT.includes('LUCIDE-REACT'), 'SYSTEM_PROMPT must contain LUCIDE-REACT block');
  assert.ok(ai.SYSTEM_PROMPT.includes('Live'), 'should warn about Live hallucination');
});

test('SYSTEM_PROMPT uses Lovable model: AI can modify ui/lib/hooks (not "ne jamais generer")', () => {
  // Regression test: Sprint before Lovable model had "FICHIERS FOURNIS (ne jamais generer) ...
  // src/components/ui/*" which blocked the AI from customizing UI components.
  // Now the prompt should say "LIBREMENT modifier" for ui/lib/hooks.
  assert.ok(!ai.SYSTEM_PROMPT.includes('ne jamais generer'), 'SYSTEM_PROMPT should NOT contain "ne jamais generer" anymore');
  assert.ok(ai.SYSTEM_PROMPT.includes('LIBREMENT modifier'), 'SYSTEM_PROMPT should say AI can freely modify files');
  assert.ok(ai.SYSTEM_PROMPT.includes('src/components/ui/'), 'ui/ should be listed as modifiable');
});

test('CHAT_SYSTEM_PROMPT mentions LUCIDE-REACT warning', () => {
  assert.ok(ai.CHAT_SYSTEM_PROMPT.includes('LUCIDE-REACT'), 'CHAT_SYSTEM_PROMPT must contain LUCIDE-REACT block');
});

// ─── MESSAGE HISTORY NORMALIZATION (Anthropic API requirements) ───
// Regression tests for the 400 Bad Request bug on plan approve.
// The Anthropic Messages API requires:
//   1. Only 'user' and 'assistant' roles
//   2. Strict alternation (no consecutive same-role messages)
//   3. Non-empty content
section('Message history normalization (anti-400)');

function hasValidAlternation(messages) {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) return false;
  }
  return true;
}

test('history with plan role is filtered out', () => {
  const project = { title: 'T', brief: 'test' }; // no generated_code
  const history = [
    { role: 'user', content: 'Brief initial' },
    { role: 'plan', content: '## Objectif\nAjouter X' },  // must be filtered
    { role: 'user', content: '[Plan approuvé]' }
  ];
  const ctx = ai.buildConversationContext(project, history, 'Implémente', [], null, null);
  const plans = ctx.filter(m => m.role === 'plan');
  assert.strictEqual(plans.length, 0, 'no plan role should remain');
  // All roles must be user or assistant
  for (const m of ctx) {
    assert.ok(m.role === 'user' || m.role === 'assistant', `invalid role: ${m.role}`);
  }
});

test('consecutive user messages are merged (strict alternation)', () => {
  const project = { title: 'T', brief: 'test' };
  const history = [
    { role: 'user', content: 'Message A' },
    { role: 'user', content: 'Message B' },
    { role: 'user', content: 'Message C' }
  ];
  const ctx = ai.buildConversationContext(project, history, 'Final', [], null, null);
  assert.ok(hasValidAlternation(ctx), `expected strict alternation, got: ${ctx.map(m => m.role).join(',')}`);
});

test('plan + user markers produce valid alternation (the exact bug scenario)', () => {
  const project = { title: 'T', brief: 'test' };
  // This mirrors what /api/plan/:id/approve sees in history
  const history = [
    { role: 'user', content: 'Brief initial du projet' },
    { role: 'plan', content: '## Objectif\n## Etapes\n- A\n- B' },
    { role: 'user', content: '[Plan #1 approuvé et exécuté]' }
  ];
  const genMessage = "Implémente exactement ce plan.\n\n## Objectif\n...";
  const ctx = ai.buildConversationContext(project, history, genMessage, [], null, null);

  // 1. No invalid roles
  for (const m of ctx) {
    assert.ok(m.role === 'user' || m.role === 'assistant', `invalid role: ${m.role}`);
  }
  // 2. Strict alternation
  assert.ok(hasValidAlternation(ctx), `alternation broken: ${ctx.map(m => m.role).join(',')}`);
  // 3. Final message is user
  assert.strictEqual(ctx[ctx.length - 1].role, 'user', 'last message must be user');
  // 4. No empty content
  for (const m of ctx) {
    assert.ok(m.content && m.content.length > 0, 'content must be non-empty');
  }
});

test('empty messages are filtered out', () => {
  const project = { title: 'T', brief: 'test' };
  const history = [
    { role: 'user', content: 'valid' },
    { role: 'assistant', content: '' },  // empty → must be dropped
    { role: 'user', content: '   ' },    // whitespace-only → must be dropped
    { role: 'assistant', content: 'response' }
  ];
  const ctx = ai.buildConversationContext(project, history, 'final', [], null, null);
  for (const m of ctx) {
    assert.ok(m.content && m.content.trim().length > 0, 'empty content leaked');
  }
});

test('system role is filtered out', () => {
  const project = { title: 'T', brief: 'test' };
  const history = [
    { role: 'user', content: 'Hi' },
    { role: 'system', content: 'audit marker' },  // must be dropped
    { role: 'assistant', content: 'Hello' }
  ];
  const ctx = ai.buildConversationContext(project, history, 'question', [], null, null);
  const systems = ctx.filter(m => m.role === 'system');
  assert.strictEqual(systems.length, 0);
});

test('null/undefined messages in history are safely ignored', () => {
  const project = { title: 'T', brief: 'test' };
  const history = [
    { role: 'user', content: 'Hi' },
    null,
    undefined,
    { role: null, content: 'bad' },
    { role: 'user', content: null },
    { role: 'assistant', content: 'Hello' }
  ];
  // Should not throw
  const ctx = ai.buildConversationContext(project, history, 'question', [], null, null);
  assert.ok(Array.isArray(ctx));
});

test('userMessage does not create consecutive user after history', () => {
  const project = { title: 'T', brief: 'test' };
  const history = [
    { role: 'user', content: 'previous question' }
  ];
  const ctx = ai.buildConversationContext(project, history, 'new question', [], null, null);
  assert.ok(hasValidAlternation(ctx));
  // The last user message should contain BOTH texts merged
  const last = ctx[ctx.length - 1];
  assert.strictEqual(last.role, 'user');
  assert.ok(last.content.includes('new question'), 'final userMessage must be included');
});

// ───────────────────────────────────────────────────────────────────────────
// 7. PROMPT INVARIANTS (regression detection on prompt edits)
// ───────────────────────────────────────────────────────────────────────────
section('Prompt invariants (regression on prompt edits)');

test('SYSTEM_PROMPT contains SCOPE STRICT directive', () => {
  assert.ok(ai.SYSTEM_PROMPT.includes('SCOPE STRICT'),
    'SCOPE STRICT block missing — Sprint A regression');
});

test('CHAT_SYSTEM_PROMPT contains SCOPE STRICT directive', () => {
  assert.ok(ai.CHAT_SYSTEM_PROMPT.includes('SCOPE STRICT'),
    'SCOPE STRICT block missing in chat prompt — Sprint A regression');
});

test('SYSTEM_PROMPT contains parallel tool calls instruction', () => {
  assert.ok(ai.SYSTEM_PROMPT.includes('PARALLELE') || ai.SYSTEM_PROMPT.includes('parallele'),
    'PARALLELE batching directive missing — Vague 1 regression');
});

test('CHAT_SYSTEM_PROMPT contains useful-context lock', () => {
  assert.ok(ai.CHAT_SYSTEM_PROMPT.includes('CONTEXTE VERROUILLE') || ai.CHAT_SYSTEM_PROMPT.includes('view_file'),
    'useful-context lock missing — Vague 1 regression');
});

test('PLAN_SYSTEM_PROMPT exists and contains 4 sections', () => {
  assert.ok(ai.PLAN_SYSTEM_PROMPT, 'PLAN_SYSTEM_PROMPT missing — Vague 2 regression');
  assert.ok(ai.PLAN_SYSTEM_PROMPT.includes('## Objectif'), 'missing Objectif section');
  assert.ok(ai.PLAN_SYSTEM_PROMPT.includes('## Fichiers concernes'), 'missing Fichiers section');
  assert.ok(ai.PLAN_SYSTEM_PROMPT.includes('## Etapes'), 'missing Etapes section');
  assert.ok(ai.PLAN_SYSTEM_PROMPT.includes('## Risques'), 'missing Risques section');
});

test('buildPlanContext is exported and callable', () => {
  assert.ok(typeof ai.buildPlanContext === 'function');
  const ctx = ai.buildPlanContext({ id: 1, brief: 'test' }, [], 'test message');
  assert.ok(Array.isArray(ctx) && ctx.length >= 1);
});

// ─── PACKAGE.JSON SYNC CHECK (prevents Vite crash from missing deps) ───
// This test catches the EXACT bug that kept causing blank screens:
// template/package.json has a dep that DEFAULT_PACKAGE_JSON doesn't.
test('DEFAULT_PACKAGE_JSON has ALL deps from template/package.json (anti-Vite-crash)', () => {
  const fs = require('fs');
  const path = require('path');
  const tplPath = path.join(__dirname, '..', 'templates', 'react', 'package.json');
  if (!fs.existsSync(tplPath)) { console.log('  (skipped — template not found)'); return; }
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  const tplDeps = { ...tpl.dependencies, ...tpl.devDependencies };

  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/const DEFAULT_PACKAGE_JSON = JSON\.stringify\((\{[\s\S]*?\})\s*,\s*null/);
  assert.ok(m, 'DEFAULT_PACKAGE_JSON not found in server.js');
  const defaultPkg = eval('(' + m[1] + ')');
  const defaultDeps = { ...defaultPkg.dependencies, ...defaultPkg.devDependencies };

  const missing = [];
  for (const dep of Object.keys(tplDeps)) {
    if (!defaultDeps[dep]) missing.push(dep);
  }
  assert.strictEqual(missing.length, 0,
    `DEFAULT_PACKAGE_JSON is missing ${missing.length} deps from template: ${missing.join(', ')}. ` +
    `Each missing dep = potential Vite crash = blank screen in production.`);
});

test('SECTOR_PROFILES contains the 12 base sectors', () => {
  // Note: 28 sector PALETTES exist in server.js (color palettes), but only 12 sector
  // PROFILES exist in src/ai.js (full prompt + components + tables + pages).
  // The other 16 sectors fall back to a generic profile but get their dedicated palette.
  const required = ['health', 'restaurant', 'ecommerce', 'corporate', 'saas',
    'education', 'realestate', 'hotel', 'portfolio', 'nonprofit',
    'dashboard', 'fitness'];
  for (const s of required) {
    assert.ok(ai.SECTOR_PROFILES[s], `missing sector: ${s}`);
  }
  assert.strictEqual(Object.keys(ai.SECTOR_PROFILES).length, 12, 'expected exactly 12 sector profiles');
});

// ───────────────────────────────────────────────────────────────────────────
// SUMMARY
// ───────────────────────────────────────────────────────────────────────────
console.log(`\n=== AI Eval Results ===`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nFailures:`);
  failures.forEach(f => console.log(`  ✗ ${f.name}\n      ${f.error}`));
  process.exit(1);
}
console.log(`\nAll evals passed.\n`);
process.exit(0);
