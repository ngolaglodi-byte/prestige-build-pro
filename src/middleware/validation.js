// ─── INPUT VALIDATION HELPERS ───

const path = require('path');

module.exports = function(ctx) {
  function validateString(value, name, minLen = 1, maxLen = 10000) {
    if (typeof value !== 'string') return `${name} doit être une chaîne de caractères`;
    if (value.trim().length < minLen) return `${name} trop court (min ${minLen} caractères)`;
    if (value.length > maxLen) return `${name} trop long (max ${maxLen} caractères)`;
    return null;
  }

  function validateId(value, name = 'ID') {
    const num = parseInt(value);
    if (isNaN(num) || num < 1) return `${name} invalide`;
    return null;
  }

  function paginate(req) {
    const urlParts = req.url.split('?');
    const params = urlParts.length > 1 ? new URLSearchParams(urlParts[1]) : new URLSearchParams();
    const page = Math.max(1, parseInt(params.get('page')) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(params.get('limit')) || 20));
    const offset = (page - 1) * limit;
    return { page, limit, offset };
  }

  function isPathSafe(basePath, targetPath) {
    const resolved = path.resolve(targetPath);
    const base = path.resolve(basePath);
    return resolved.startsWith(base + path.sep) || resolved === base;
  }

  function isValidJson(filePath) {
    const fs = require('fs');
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      JSON.parse(content);
      return true;
    } catch(e) {
      return false;
    }
  }

  return { validateString, validateId, paginate, isPathSafe, isValidJson };
};
