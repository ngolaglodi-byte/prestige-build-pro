// ─── IDEMPOTENT FILE COPY ───
//
// Copies a file ONLY if source and destination differ (by size then byte content).
// Prevents mtime churn that triggers file watchers like Vite HMR.
//
// Background: fs.copyFileSync() always updates the dest file's mtime, even when
// content is identical. When a function that does 40+ such copies is called 6
// times in a generation pipeline, it produces 240+ mtime updates, causing Vite
// HMR to enter a restart loop. This helper makes the copy idempotent.
//
// Returns: { copied: boolean, reason: 'missing'|'size_diff'|'content_diff'|'identical'|'error_fallback' }
//
// Safety: on ANY error (stat failure, read failure, etc.), falls through to the
// unconditional copy. It's safer to copy-when-in-doubt than to skip-when-wrong.

'use strict';

const fs = require('fs');

function copyFileIfDiffers(srcFile, destFile) {
  // Fast path: destination doesn't exist → copy
  if (!fs.existsSync(destFile)) {
    fs.copyFileSync(srcFile, destFile);
    return { copied: true, reason: 'missing' };
  }

  try {
    const srcStat = fs.statSync(srcFile);
    const destStat = fs.statSync(destFile);

    // Size mismatch → content must differ → copy
    if (srcStat.size !== destStat.size) {
      fs.copyFileSync(srcFile, destFile);
      return { copied: true, reason: 'size_diff' };
    }

    // Same size: compare bytes. Cheap for shadcn files (<10KB each).
    const srcBuf = fs.readFileSync(srcFile);
    const destBuf = fs.readFileSync(destFile);
    if (!srcBuf.equals(destBuf)) {
      fs.copyFileSync(srcFile, destFile);
      return { copied: true, reason: 'content_diff' };
    }

    // Identical → skip. This is the whole point.
    return { copied: false, reason: 'identical' };
  } catch (e) {
    // Defensive: on any unexpected error (permission, race, etc.), fall through
    // to the unconditional copy. Losing idempotency is safer than losing data.
    try {
      fs.copyFileSync(srcFile, destFile);
      return { copied: true, reason: 'error_fallback', error: e.message };
    } catch (copyErr) {
      // Re-throw — there's nothing more we can do
      throw copyErr;
    }
  }
}

module.exports = { copyFileIfDiffers };
