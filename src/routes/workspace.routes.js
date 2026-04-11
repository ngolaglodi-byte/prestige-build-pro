// ─── WORKSPACE ROUTES ───
// Workspaces CRUD, members management

module.exports = function(ctx, router) {
  const { json, getBody } = require('../middleware/body')(ctx);
  const db = ctx.db;

  // ─── LIST WORKSPACES ───
  router.get('/api/workspaces', async (req, res) => {
    const user = req.user;
    const owned = db.prepare('SELECT * FROM workspaces WHERE owner_id=? ORDER BY created_at DESC').all(user.id);
    const memberOf = db.prepare(`SELECT w.* FROM workspaces w JOIN workspace_members wm ON w.id=wm.workspace_id WHERE wm.user_id=? ORDER BY w.created_at DESC`).all(user.id);
    const all = [...owned, ...memberOf.filter(w => !owned.find(o => o.id === w.id))];
    const result = all.map(w => {
      const members = db.prepare('SELECT wm.*, u.email, u.name FROM workspace_members wm JOIN users u ON wm.user_id=u.id WHERE wm.workspace_id=?').all(w.id);
      const myRole = w.owner_id === user.id ? 'owner' : (members.find(m => m.user_id === user.id)?.role || 'viewer');
      const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects WHERE workspace_id=?').get(w.id)?.c || 0;
      return { ...w, myRole, memberCount: members.length + 1, projectCount };
    });
    json(res, 200, result);
  });

  // ─── CREATE WORKSPACE ───
  router.post('/api/workspaces', async (req, res) => {
    const user = req.user;
    const { name, description } = await getBody(req);
    if (!name || typeof name !== 'string' || name.trim().length < 2) { json(res, 400, { error: 'Nom requis (min 2 caractères).' }); return; }
    const result = db.prepare('INSERT INTO workspaces (name, description, owner_id) VALUES (?,?,?)').run(name.trim(), description || '', user.id);
    json(res, 201, { id: result.lastInsertRowid, name: name.trim() });
  });

  // ─── DELETE WORKSPACE ───
  router.delete('/api/workspaces/:id', async (req, res) => {
    const user = req.user;
    const wid = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    if (w.owner_id !== user.id && user.role !== 'admin') { json(res, 403, { error: 'Seul le propriétaire peut supprimer.' }); return; }
    db.prepare('DELETE FROM workspace_members WHERE workspace_id=?').run(wid);
    db.prepare('UPDATE projects SET workspace_id=NULL WHERE workspace_id=?').run(wid);
    db.prepare('DELETE FROM workspaces WHERE id=?').run(wid);
    json(res, 200, { ok: true });
  });

  // ─── LIST WORKSPACE MEMBERS ───
  router.get('/api/workspaces/:id/members', async (req, res) => {
    const wid = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    const owner = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(w.owner_id);
    const members = db.prepare('SELECT wm.role, wm.joined_at, u.id, u.email, u.name FROM workspace_members wm JOIN users u ON wm.user_id=u.id WHERE wm.workspace_id=?').all(wid);
    json(res, 200, { owner: { ...owner, role: 'owner' }, members });
  });

  // ─── ADD WORKSPACE MEMBER ───
  router.post('/api/workspaces/:id/members', async (req, res) => {
    const user = req.user;
    const wid = parseInt(req.params.id);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    if (w.owner_id !== user.id && user.role !== 'admin') { json(res, 403, { error: 'Seul le propriétaire peut inviter.' }); return; }
    const { email, role } = await getBody(req);
    if (!email) { json(res, 400, { error: 'Email requis.' }); return; }
    const invitee = db.prepare('SELECT id FROM users WHERE email=?').get(email.trim().toLowerCase());
    if (!invitee) { json(res, 404, { error: 'Utilisateur introuvable.' }); return; }
    const validRoles = ['editor', 'viewer'];
    const memberRole = validRoles.includes(role) ? role : 'editor';
    try {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES (?,?,?,?)').run(wid, invitee.id, memberRole, user.id);
      db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?,?,?)').run(invitee.id, `Vous avez été invité au workspace "${w.name}" par ${user.name}`, 'info');
      json(res, 201, { ok: true, userId: invitee.id, role: memberRole });
    } catch (e) {
      json(res, 409, { error: 'Déjà membre de ce workspace.' });
    }
  });

  // ─── REMOVE WORKSPACE MEMBER ───
  router.delete('/api/workspaces/:id/members/:uid', async (req, res) => {
    const user = req.user;
    const wid = parseInt(req.params.id);
    const uid = parseInt(req.params.uid);
    const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wid);
    if (!w) { json(res, 404, { error: 'Workspace introuvable.' }); return; }
    if (w.owner_id !== user.id && user.role !== 'admin' && user.id !== uid) {
      json(res, 403, { error: 'Accès refusé.' }); return;
    }
    db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(wid, uid);
    json(res, 200, { ok: true });
  });
};
