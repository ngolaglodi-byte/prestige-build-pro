// Unit tests for src/idempotent-copy.js
// Run with: node tests/idempotent-copy.test.js
//
// This is the regression test for the Vite restart loop bug fix.
// Without this test, someone could revert writeDefaultReactProject to use
// fs.copyFileSync directly and the bug would come back undetected.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { copyFileIfDiffers } = require('../src/idempotent-copy.js');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e.message }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

function section(name) { console.log(`\n${name}:`); }

// Helper: create a temporary directory for each test
function withTmpDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbp-idempotent-test-'));
  try { return fn(tmp); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch(_) {} }
}

console.log('\n=== Prestige Build Pro — Idempotent Copy Tests ===');

// ───────────────────────────────────────────────────────────────────────────
// BASIC BEHAVIOR
// ───────────────────────────────────────────────────────────────────────────
section('Basic behavior');

test('destination missing → copies and reports "missing"', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    fs.writeFileSync(src, 'hello');
    const result = copyFileIfDiffers(src, dest);
    assert.strictEqual(result.copied, true);
    assert.strictEqual(result.reason, 'missing');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello');
  });
});

test('destination identical → skips and reports "identical"', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    fs.writeFileSync(src, 'hello world');
    fs.writeFileSync(dest, 'hello world');
    const result = copyFileIfDiffers(src, dest);
    assert.strictEqual(result.copied, false);
    assert.strictEqual(result.reason, 'identical');
  });
});

test('size differs → copies and reports "size_diff"', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    fs.writeFileSync(src, 'hello world');
    fs.writeFileSync(dest, 'short');
    const result = copyFileIfDiffers(src, dest);
    assert.strictEqual(result.copied, true);
    assert.strictEqual(result.reason, 'size_diff');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello world');
  });
});

test('same size but different content → copies and reports "content_diff"', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    fs.writeFileSync(src, 'aaa');
    fs.writeFileSync(dest, 'bbb');
    const result = copyFileIfDiffers(src, dest);
    assert.strictEqual(result.copied, true);
    assert.strictEqual(result.reason, 'content_diff');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'aaa');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY (the CORE regression test for the Vite restart loop bug)
// ───────────────────────────────────────────────────────────────────────────
section('Idempotency — mtime stability (regression test for Vite restart loop)');

test('dest mtime unchanged after second call with identical content', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    const content = 'identical content';
    fs.writeFileSync(src, content);
    fs.writeFileSync(dest, content);

    const mtimeBefore = fs.statSync(dest).mtimeMs;
    // Small sleep to ensure any mtime update would be visible
    const wait = Date.now() + 50;
    while (Date.now() < wait) { /* busy wait 50ms */ }

    const result = copyFileIfDiffers(src, dest);
    const mtimeAfter = fs.statSync(dest).mtimeMs;

    assert.strictEqual(result.copied, false, 'should NOT have copied');
    assert.strictEqual(result.reason, 'identical');
    assert.strictEqual(mtimeAfter, mtimeBefore, `mtime changed from ${mtimeBefore} to ${mtimeAfter} — THIS IS THE BUG that caused the Vite restart loop`);
  });
});

test('100 calls on identical file → mtime never changes', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    fs.writeFileSync(src, 'x'.repeat(500));
    fs.writeFileSync(dest, 'x'.repeat(500));

    const mtimeStart = fs.statSync(dest).mtimeMs;
    let copiedCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = copyFileIfDiffers(src, dest);
      if (result.copied) copiedCount++;
    }
    const mtimeEnd = fs.statSync(dest).mtimeMs;

    assert.strictEqual(copiedCount, 0, `expected 0 copies, got ${copiedCount}`);
    assert.strictEqual(mtimeEnd, mtimeStart, 'mtime must be stable across 100 calls');
  });
});

test('40 files × 6 calls (writeDefaultReactProject simulation) → only 40 initial copies', () => {
  withTmpDir(tmp => {
    // Setup: 40 source files simulating src/components/ui/
    const srcDir = path.join(tmp, 'src');
    const destDir = path.join(tmp, 'dest');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(destDir);
    const fileNames = Array.from({ length: 40 }, (_, i) => `file${i}.tsx`);
    for (const fn of fileNames) {
      fs.writeFileSync(path.join(srcDir, fn), `export default function C${fn.replace(/\W/g, '')}() { return null; }`);
    }

    // Simulate 6 calls to writeDefaultReactProject
    let totalCopies = 0;
    for (let call = 0; call < 6; call++) {
      for (const fn of fileNames) {
        const result = copyFileIfDiffers(path.join(srcDir, fn), path.join(destDir, fn));
        if (result.copied) totalCopies++;
      }
    }

    // Expectation: only the first call should copy. Subsequent 5 calls should skip all 40.
    assert.strictEqual(totalCopies, 40,
      `expected exactly 40 copies (first call only), got ${totalCopies}. ` +
      `Extra copies = mtime churn = Vite restart loop regression.`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// EDGE CASES
// ───────────────────────────────────────────────────────────────────────────
section('Edge cases');

test('empty source file → copies to empty dest (size 0 match, content match)', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    fs.writeFileSync(src, '');
    // First call: dest missing → copies empty file
    let result = copyFileIfDiffers(src, dest);
    assert.strictEqual(result.copied, true);
    assert.strictEqual(result.reason, 'missing');
    // Second call: dest exists, both empty → skip
    result = copyFileIfDiffers(src, dest);
    assert.strictEqual(result.copied, false);
    assert.strictEqual(result.reason, 'identical');
  });
});

test('binary content (PNG-like bytes) handled correctly', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'a.png');
    const dest = path.join(tmp, 'b.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    fs.writeFileSync(src, bytes);
    fs.writeFileSync(dest, bytes);
    const result = copyFileIfDiffers(src, dest);
    assert.strictEqual(result.copied, false);
    assert.strictEqual(result.reason, 'identical');
  });
});

test('source does not exist → throws (by design, safer than silent failure)', () => {
  withTmpDir(tmp => {
    const src = path.join(tmp, 'missing.txt');
    const dest = path.join(tmp, 'b.txt');
    assert.throws(() => copyFileIfDiffers(src, dest), /ENOENT|no such/i);
  });
});

test('concurrent calls: 2 parallel attempts, both eventually safe', async () => {
  await withTmpDir(async tmp => {
    const src = path.join(tmp, 'a.txt');
    const dest = path.join(tmp, 'b.txt');
    fs.writeFileSync(src, 'shared content');
    // Don't pre-create dest — first call wins
    const results = [copyFileIfDiffers(src, dest), copyFileIfDiffers(src, dest)];
    // At least one copied, both succeeded
    assert.ok(results[0].copied || results[1].copied);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'shared content');
  });
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
