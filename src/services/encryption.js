// ─── ENCRYPTION FOR SENSITIVE DATA AT REST ───
// AES-256-GCM with explicit ENCRYPTION_KEY.

const crypto = require('crypto');

module.exports = function(ctx) {
  const ENCRYPT_KEY = ctx.config.ENCRYPT_KEY;
  const ENCRYPT_PREFIX = ctx.config.ENCRYPT_PREFIX;

  function encryptValue(text) {
    if (text === null || text === undefined || text === '') return text;
    const str = typeof text === 'string' ? text : String(text);
    if (str.startsWith(ENCRYPT_PREFIX)) return str;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
    let enc = cipher.update(str, 'utf8', 'hex');
    enc += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return ENCRYPT_PREFIX + iv.toString('hex') + ':' + tag + ':' + enc;
  }

  function decryptValue(encrypted) {
    if (encrypted === null || encrypted === undefined || encrypted === '') return encrypted;
    if (typeof encrypted !== 'string') return encrypted;
    if (!encrypted.startsWith(ENCRYPT_PREFIX)) return encrypted;
    try {
      const payload = encrypted.slice(ENCRYPT_PREFIX.length);
      const [ivHex, tagHex, enc] = payload.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
      decipher.setAuthTag(tag);
      let dec = decipher.update(enc, 'hex', 'utf8');
      dec += decipher.final('utf8');
      return dec;
    } catch (e) {
      console.error('[Encrypt] Failed to decrypt value:', e.message);
      return null;
    }
  }

  return { encryptValue, decryptValue };
};
