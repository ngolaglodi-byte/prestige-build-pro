/**
 * Anthropic API Rate Limit Handler
 * Extracted from server.js lines 120-214
 */
const https = require('https');
const { API_ERROR_MESSAGES, log } = require('../config');

module.exports = function(ctx) {
  const API_QUEUE = [];
  let apiRunning = false;

  function anthropicRequest(payload, opts, onResponse, onError, job, retryCount = 0) {
    // Defensive onError wrapper — anthropicRequest is called from many sites,
    // some of which historically did not pass onError. Without this wrapper a
    // network error would crash the process via "onError is not a function".
    const safeOnError = (typeof onError === 'function')
      ? onError
      : (e) => { console.error(`[anthropicRequest] unhandled (no onError): ${e.message}`); if (job) { job.status = job.status || 'error'; job.error = job.error || e.message; } };
    const r = https.request(opts, apiRes => {
      const status = apiRes.statusCode;

      // Retryable errors: 429 (rate limit) and 529 (overloaded)
      if (status === 429 || status === 529) {
        let body = '';
        apiRes.on('data', c => body += c);
        apiRes.on('end', () => {
          const retryAfter = parseInt(apiRes.headers['retry-after'] || '60');
          const wait = Math.min(retryAfter, 120) * 1000;
          if (retryCount < ctx.config.API_MAX_RETRIES) {
            console.log(`[API] ${status} rate limited, retry ${retryCount + 1}/${ctx.config.API_MAX_RETRIES} in ${wait / 1000}s`);
            if (job) job.progressMessage = `File d'attente API... (tentative ${retryCount + 1}/${ctx.config.API_MAX_RETRIES})`;
            setTimeout(() => anthropicRequest(payload, opts, onResponse, onError, job, retryCount + 1), wait);
          } else {
            console.error(`[API] Rate limit exhausted after ${ctx.config.API_MAX_RETRIES} retries`);
            onError(new Error(API_ERROR_MESSAGES[status] || 'Limite API atteinte.'));
          }
        });
        return;
      }

      // Non-retryable errors: 400, 401, 402, 403, 404, 413, 500
      if (status >= 400 && status !== 200) {
        let body = '';
        apiRes.on('data', c => body += c);
        apiRes.on('end', () => {
          console.error(`[API] HTTP ${status}: ${body.substring(0, 300)}`);

          // Parse API error message for better user feedback
          let friendlyMsg = API_ERROR_MESSAGES[status] || `Erreur API (${status}).`;
          try {
            const apiError = JSON.parse(body);
            const apiMsg = apiError?.error?.message || '';
            // Credit/billing issues — show clear message
            if (apiMsg.includes('credit balance') || apiMsg.includes('billing')) {
              friendlyMsg = 'Crédit API épuisé. Le compte Anthropic doit être rechargé. Contactez l\'administrateur.';
              console.error('[API] ⚠️ BILLING ISSUE — Anthropic account needs funding');
              if (job) job.progressMessage = '⚠️ Crédit API épuisé';
            }
            // Bad API key
            else if (status === 401) {
              friendlyMsg = 'Clé API Anthropic invalide. Contactez l\'administrateur.';
              console.error('[API] ⚠️ INVALID API KEY');
            }
            // Model not found
            else if (apiMsg.includes('model')) {
              friendlyMsg = `Modèle non disponible: ${apiMsg}`;
            }
            // Token limit
            else if (apiMsg.includes('token') || apiMsg.includes('too long')) {
              friendlyMsg = 'Le message est trop long. Essayez avec un texte plus court.';
            }
          } catch {}

          safeOnError(new Error(friendlyMsg));
        });
        return;
      }

      onResponse(apiRes);
    });
    r.on('error', e => {
      // User-initiated AbortController.abort() — never retry, propagate immediately so
      // the caller can mark the job as 'cancelled' (not 'error').
      if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ERR_CANCELED')) {
        console.log(`[API] Request aborted by user`);
        safeOnError(e);
        return;
      }
      if (retryCount < 2) {
        console.log(`[API] Network error, retrying in 5s: ${e.message}`);
        setTimeout(() => anthropicRequest(payload, opts, onResponse, onError, job, retryCount + 1), 5000);
      } else {
        safeOnError(new Error('Erreur réseau. Vérifiez la connexion internet du serveur.'));
      }
    });
    r.setTimeout(ctx.config.CLAUDE_CODE_TIMEOUT_MS, () => {
      r.destroy();
      safeOnError(new Error('Délai dépassé (5 min). Le brief est peut-être trop complexe — essayez en le simplifiant.'));
    });
    r.write(payload);
    r.end();
  }

  return { anthropicRequest };
};
