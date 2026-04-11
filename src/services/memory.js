// ─── IN-MEMORY CACHE WITH TTL ───
// Redis-like cache for single-server deployments.

class MemoryCache {
  constructor() {
    this._store = new Map();
  }

  get(key) {
    const item = this._store.get(key);
    if (!item) return null;
    if (item.expiry && item.expiry < Date.now()) {
      this._store.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttlMs = 0) {
    const expiry = ttlMs > 0 ? Date.now() + ttlMs : null;
    this._store.set(key, { value, expiry });
  }

  del(key) { this._store.delete(key); }

  has(key) { return this.get(key) !== null; }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, item] of this._store) {
        if (item.expiry && item.expiry < now) this._store.delete(key);
      }
    }, 5 * 60 * 1000);
  }
}

module.exports = { MemoryCache };
