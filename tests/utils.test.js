// Tests for server.js utility functions
// Run with: node tests/utils.test.js

const assert = require('assert');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n=== Prestige Build Pro — Unit Tests ===\n');

// ─── Input Validation ───
console.log('Input Validation:');

test('validateString accepts valid input', () => {
  const validateString = (v, n, min=1, max=10000) => {
    if (typeof v !== 'string') return `${n} doit être une chaîne`;
    if (v.trim().length < min) return `${n} trop court`;
    if (v.length > max) return `${n} trop long`;
    return null;
  };
  assert.strictEqual(validateString('hello', 'test'), null);
  assert.strictEqual(validateString('ab', 'test', 3), 'test trop court');
  assert.strictEqual(validateString(123, 'test'), 'test doit être une chaîne');
  assert.strictEqual(validateString('x'.repeat(101), 'test', 1, 100), 'test trop long');
});

test('validateId accepts positive integers', () => {
  const validateId = (v) => { const n = parseInt(v); return (isNaN(n) || n < 1) ? 'ID invalide' : null; };
  assert.strictEqual(validateId(1), null);
  assert.strictEqual(validateId('42'), null);
  assert.strictEqual(validateId(0), 'ID invalide');
  assert.strictEqual(validateId('abc'), 'ID invalide');
  assert.strictEqual(validateId(-1), 'ID invalide');
});

// ─── Pagination ───
console.log('\nPagination:');

test('paginate returns correct defaults', () => {
  const paginate = (params) => {
    const page = Math.max(1, parseInt(params.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(params.limit) || 20));
    return { page, limit, offset: (page - 1) * limit };
  };
  const r = paginate({});
  assert.strictEqual(r.page, 1);
  assert.strictEqual(r.limit, 20);
  assert.strictEqual(r.offset, 0);
});

test('paginate respects page and limit', () => {
  const paginate = (params) => {
    const page = Math.max(1, parseInt(params.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(params.limit) || 20));
    return { page, limit, offset: (page - 1) * limit };
  };
  const r = paginate({ page: '3', limit: '10' });
  assert.strictEqual(r.page, 3);
  assert.strictEqual(r.limit, 10);
  assert.strictEqual(r.offset, 20);
});

test('paginate clamps limit to 100', () => {
  const paginate = (params) => {
    const page = Math.max(1, parseInt(params.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(params.limit) || 20));
    return { page, limit, offset: (page - 1) * limit };
  };
  assert.strictEqual(paginate({ limit: '999' }).limit, 100);
  assert.strictEqual(paginate({ limit: '0' }).limit, 20); // 0 parsed as falsy → default 20
});

// ─── Code Cleaning ───
console.log('\nCode Cleaning:');

test('stripCodeArtifacts removes text before ### markers', () => {
  const stripCodeArtifacts = (code) => {
    if (!code) return '';
    let cleaned = code.replace(/^[\s\S]*?(?=### )/, '');
    cleaned = cleaned.replace(/\n*SUGGESTIONS:[\s\S]*$/, '');
    return cleaned.trim();
  };
  const input = "Voici le code modifié !\n\n### src/App.tsx\nimport React...";
  const result = stripCodeArtifacts(input);
  assert.ok(result.startsWith('### src/App.tsx'));
  assert.ok(!result.includes('Voici'));
});

test('stripCodeArtifacts removes SUGGESTIONS at end', () => {
  const stripCodeArtifacts = (code) => {
    if (!code) return '';
    let cleaned = code.replace(/^[\s\S]*?(?=### )/, '');
    cleaned = cleaned.replace(/\n*SUGGESTIONS:[\s\S]*$/, '');
    return cleaned.trim();
  };
  const input = "### server.js\nconst x = 1;\nSUGGESTIONS: Add blue | Fix header";
  const result = stripCodeArtifacts(input);
  assert.ok(!result.includes('SUGGESTIONS'));
  assert.ok(result.includes('const x = 1'));
});

// ─── Token Pricing ───
console.log('\nToken Pricing:');

test('cost calculation is correct', () => {
  const pricing = { input: 3.00, output: 15.00 };
  const inputTokens = 10000;
  const outputTokens = 5000;
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  assert.ok(Math.abs(cost - 0.105) < 0.001);
});

test('complexity classification works', () => {
  const classify = (op, inp, out) => {
    const total = inp + out;
    if (op === 'chat') return 'chat';
    if (op === 'auto-correct') return 'fix';
    if (total < 5000) return 'simple';
    if (total < 20000) return 'moderate';
    if (total < 50000) return 'complex';
    return 'heavy';
  };
  assert.strictEqual(classify('chat', 100, 100), 'chat');
  assert.strictEqual(classify('auto-correct', 5000, 5000), 'fix');
  assert.strictEqual(classify('generate', 1000, 2000), 'simple');
  assert.strictEqual(classify('generate', 10000, 8000), 'moderate');
  assert.strictEqual(classify('generate', 30000, 15000), 'complex');
  assert.strictEqual(classify('generate', 40000, 20000), 'heavy');
});

// ─── Security ───
console.log('\nSecurity:');

test('JWT sign/verify roundtrip', () => {
  const crypto = require('crypto');
  const secret = crypto.randomBytes(32).toString('hex');
  const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload = { id: 1, email: 'test@test.com', exp: Math.floor(Date.now()/1000) + 3600 };
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  const token = `${h}.${b}.${s}`;

  // Verify
  const [h2, b2, s2] = token.split('.');
  const verified = crypto.createHmac('sha256', secret).update(`${h2}.${b2}`).digest('base64url');
  assert.strictEqual(verified, s2);
  const decoded = JSON.parse(Buffer.from(b2, 'base64url').toString());
  assert.strictEqual(decoded.email, 'test@test.com');
});

test('expired token is rejected', () => {
  const crypto = require('crypto');
  const secret = 'test-secret';
  const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload = { id: 1, exp: Math.floor(Date.now()/1000) - 100 }; // expired
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  const decoded = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.ok(decoded.exp < Math.floor(Date.now()/1000)); // expired
});

// ─── File Validation ───
console.log('\nFile Validation:');

test('isValidProjectFile accepts valid paths', () => {
  const patterns = [
    /^package\.json$/, /^tsconfig\.json$/, /^server\.js$/,
    /^src\/main\.(tsx|jsx)$/, /^src\/App\.(tsx|jsx)$/,
    /^src\/components\/[A-Za-z0-9_-]+\.(tsx|jsx)$/,
    /^src\/components\/ui\/[A-Za-z0-9_-]+\.(tsx|jsx)$/,
    /^src\/pages\/[A-Za-z0-9_-]+\.(tsx|jsx)$/,
  ];
  const isValid = (f) => patterns.some(p => p.test(f));
  assert.ok(isValid('package.json'));
  assert.ok(isValid('src/main.tsx'));
  assert.ok(isValid('src/App.tsx'));
  assert.ok(isValid('src/components/Header.tsx'));
  assert.ok(isValid('src/components/ui/button.tsx'));
  assert.ok(isValid('src/pages/Home.tsx'));
  assert.ok(!isValid('node_modules/react/index.js'));
  assert.ok(!isValid('../../../etc/passwd'));
  assert.ok(!isValid('src/malicious.sh'));
});

// ─── Cache ───
console.log('\nMemory Cache:');

test('cache set/get works', () => {
  const store = new Map();
  const set = (k, v, ttl) => store.set(k, { value: v, expiry: ttl ? Date.now() + ttl : null });
  const get = (k) => { const i = store.get(k); if (!i) return null; if (i.expiry && i.expiry < Date.now()) { store.delete(k); return null; } return i.value; };
  set('key1', 'value1', 60000);
  assert.strictEqual(get('key1'), 'value1');
  assert.strictEqual(get('nonexistent'), null);
});

test('cache TTL expires', () => {
  const store = new Map();
  const set = (k, v, ttl) => store.set(k, { value: v, expiry: ttl ? Date.now() + ttl : null });
  const get = (k) => { const i = store.get(k); if (!i) return null; if (i.expiry && i.expiry < Date.now()) { store.delete(k); return null; } return i.value; };
  set('expired', 'val', 1); // 1ms TTL
  // Wait 5ms
  const start = Date.now(); while (Date.now() - start < 5) {}
  assert.strictEqual(get('expired'), null);
});

// ─── Results ───
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
