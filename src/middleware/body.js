// ─── BODY PARSING & JSON RESPONSE ───

module.exports = function(ctx) {
  function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function getBody(req, maxSize = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > maxSize) {
          reject(new Error('Body too large'));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve({}); }
      });
      req.on('error', reject);
    });
  }

  return { json, getBody };
};
