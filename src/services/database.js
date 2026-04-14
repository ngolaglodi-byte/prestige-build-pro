// ─── DATABASE INITIALIZATION ───
// Schema creation, migrations, indexes, admin seeding.

const bcrypt = require('bcryptjs');

function initDatabase(ctx) {
  const Database = require('better-sqlite3');
  const db = new Database(ctx.config.DB_PATH);

  // SQLite hardening
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // ─── SCHEMA ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, name TEXT NOT NULL, role TEXT DEFAULT 'agent', lang TEXT DEFAULT 'fr', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT, client_name TEXT, project_type TEXT, brief TEXT, generated_code TEXT, status TEXT DEFAULT 'draft', is_published INTEGER DEFAULT 0, subdomain TEXT, domain TEXT, apis TEXT, notes TEXT, build_id TEXT, build_status TEXT DEFAULT 'none', build_url TEXT, version INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS project_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, service TEXT NOT NULL, key_value TEXT NOT NULL, description TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS project_api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, env_name TEXT NOT NULL, env_value TEXT NOT NULL, service TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS github_config (id INTEGER PRIMARY KEY, github_token TEXT NOT NULL, github_username TEXT NOT NULL, github_org TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT, type TEXT DEFAULT 'info', read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, project_id INTEGER, status TEXT DEFAULT 'building', progress INTEGER DEFAULT 0, message TEXT, url TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS analytics (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, event_type TEXT NOT NULL, event_data TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS project_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version_number INTEGER NOT NULL, generated_code TEXT, screenshot_url TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), message TEXT, FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS error_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, error_type TEXT NOT NULL, error_message TEXT, docker_logs TEXT, correction_attempt INTEGER DEFAULT 1, corrected INTEGER DEFAULT 0, corrected_code TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, project_id INTEGER, operation TEXT NOT NULL, model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, owner_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(owner_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS workspace_members (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT DEFAULT 'editor', invited_by INTEGER, joined_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(user_id) REFERENCES users(id), UNIQUE(workspace_id, user_id));
    CREATE TABLE IF NOT EXISTS project_memory (project_id INTEGER PRIMARY KEY, content TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')), updated_by INTEGER, FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS ai_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, user_id INTEGER NOT NULL, job_id TEXT, rating INTEGER NOT NULL, comment TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE INDEX IF NOT EXISTS idx_ai_feedback_project ON ai_feedback(project_id);
    CREATE INDEX IF NOT EXISTS idx_ai_feedback_created ON ai_feedback(created_at);

    -- SECURITY: append-only audit log
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_email TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      ip TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    -- Multi-turn conversation memory (Phase 9)
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      key_decisions TEXT,
      architecture_notes TEXT,
      turn_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_summaries_project ON conversation_summaries(project_id);
  `);

  // ─── ERROR TELEMETRY TABLE ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS error_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_type TEXT NOT NULL,
      error_signature TEXT NOT NULL,
      occurrence_count INTEGER DEFAULT 1,
      last_project_id INTEGER,
      auto_fixed INTEGER DEFAULT 0,
      rollback_triggered INTEGER DEFAULT 0,
      sample_message TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_error_patterns_sig ON error_patterns(error_type, error_signature);
    CREATE INDEX IF NOT EXISTS idx_error_patterns_count ON error_patterns(occurrence_count DESC);
  `);

  // ─── MIGRATIONS (backwards-compat) ───
  try { db.exec('ALTER TABLE projects ADD COLUMN github_repo TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN daily_generation_limit INTEGER DEFAULT 50'); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN monthly_generation_limit INTEGER DEFAULT 500'); } catch(e) {}
  try { db.exec('ALTER TABLE projects ADD COLUMN workspace_id INTEGER'); } catch(e) {}

  // ─── INDEXES ───
  try { db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_project_messages_project ON project_messages(project_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_project_type ON analytics(project_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics(created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(project_id);
    CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
    CREATE INDEX IF NOT EXISTS idx_error_history_project ON error_history(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_versions_project ON project_versions(project_id);

    -- Phase 5: Composite indexes for frequent queries
    CREATE INDEX IF NOT EXISTS idx_token_usage_user_op ON token_usage(user_id, operation, created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_project_messages_project_role ON project_messages(project_id, role);
    CREATE INDEX IF NOT EXISTS idx_error_history_project_corrected ON error_history(project_id, corrected);
    CREATE INDEX IF NOT EXISTS idx_project_versions_project_version ON project_versions(project_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_analytics_project_type_created ON analytics(project_id, event_type, created_at);
  `); console.log('[DB] Indexes created/verified'); } catch(e) { console.warn('[DB] Index creation:', e.message); }

  // ─── ADMIN SEED ───
  const ADMIN_EMAIL = 'admin@prestige-build.dev';
  const ADMIN_PASSWORD = 'Prestige2026!';
  const adminExists = db.prepare("SELECT id FROM users WHERE email=?").get(ADMIN_EMAIL);
  if (!adminExists) {
    db.prepare('INSERT INTO users (email,password,name,role) VALUES (?,?,?,?)').run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 12), 'Administrateur', 'admin');
    console.log(`[DB] Admin account created: ${ADMIN_EMAIL}`);
  } else {
    db.prepare('UPDATE users SET password=? WHERE email=?').run(bcrypt.hashSync(ADMIN_PASSWORD, 12), ADMIN_EMAIL);
  }

  const allUsers = db.prepare('SELECT id, email, role FROM users').all();
  console.log(`[DB] ${allUsers.length} user(s): ${allUsers.map(u => u.email + ' (' + u.role + ')').join(', ')}`);

  // ─── ANALYTICS RETENTION ───
  try {
    const deleted = db.prepare("DELETE FROM analytics WHERE created_at < datetime('now', '-90 days')").run();
    if (deleted.changes > 0) console.log(`[DB] Cleaned ${deleted.changes} analytics records older than 90 days`);
  } catch(e) {}

  // Backwards-compat: keep global.auditLog alias
  global.auditLog = function(req, user, action, resourceType, resourceId, details) {
    ctx.auditLog(req, user, action, resourceType, resourceId, details);
  };

  return db;
}

module.exports = { initDatabase };
