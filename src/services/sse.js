// ─── SSE (Server-Sent Events) CLIENT MANAGEMENT ───
// Real-time collaboration notifications.

module.exports = function(ctx) {
  function notifyProjectClients(projectId, event, data, excludeUserId = null) {
    const clients = ctx.projectSSEClients.get(projectId);
    if (!clients || clients.size === 0) return;

    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (excludeUserId && client.userId === excludeUserId) continue;
      try {
        client.res.write(message);
      } catch (e) {
        clients.delete(client);
      }
    }
  }

  function getProjectCollaborators(projectId) {
    const clients = ctx.projectSSEClients.get(projectId);
    if (!clients || clients.size === 0) return [];
    return Array.from(clients).map(c => ({
      userId: c.userId,
      userName: c.userName,
      connectedAt: c.connectedAt
    }));
  }

  function addSSEClient(projectId, client) {
    if (!ctx.projectSSEClients.has(projectId)) {
      ctx.projectSSEClients.set(projectId, new Set());
    }
    ctx.projectSSEClients.get(projectId).add(client);
  }

  function removeSSEClient(projectId, client) {
    const clients = ctx.projectSSEClients.get(projectId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) ctx.projectSSEClients.delete(projectId);
    }
  }

  return { notifyProjectClients, getProjectCollaborators, addSSEClient, removeSSEClient };
};
