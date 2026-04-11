// ─── LIGHTWEIGHT ROUTER ───
// Minimal route dispatcher — replaces the if/else chain in server.js.
// Supports :param patterns and regex.

class Router {
  constructor() {
    this._routes = [];
  }

  _add(method, pattern, handler) {
    let regex, paramNames = [];

    if (pattern instanceof RegExp) {
      regex = pattern;
    } else {
      // Convert "/api/projects/:id/versions/:vid" → regex with capture groups
      const parts = pattern.replace(/([.+?^${}()|[\]\\])/g, '\\$1');
      const paramPattern = parts.replace(/:([a-zA-Z_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      });
      regex = new RegExp(`^${paramPattern}$`);
    }

    this._routes.push({ method, regex, handler, paramNames, raw: pattern });
  }

  get(pattern, handler) { this._add('GET', pattern, handler); }
  post(pattern, handler) { this._add('POST', pattern, handler); }
  put(pattern, handler) { this._add('PUT', pattern, handler); }
  delete(pattern, handler) { this._add('DELETE', pattern, handler); }

  async handle(req, res) {
    const url = req.url.split('?')[0];

    for (const route of this._routes) {
      if (route.method !== req.method) continue;
      const match = url.match(route.regex);
      if (match) {
        // Build params object
        req.params = {};
        if (route.paramNames.length > 0) {
          route.paramNames.forEach((name, i) => {
            req.params[name] = match[i + 1];
          });
        } else {
          // For regex patterns, expose capture groups as array
          req.params._captures = match.slice(1);
        }
        try {
          await route.handler(req, res);
        } catch (e) {
          console.error(`[Router] Error in ${route.method} ${route.raw}:`, e.message);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Erreur interne du serveur.' }));
          }
        }
        return true;
      }
    }

    return false; // No route matched
  }
}

module.exports = { Router };
