/**
 * Background maintenance tasks.
 * All tasks are lightweight and run on simple setInterval timers.
 */

import { prisma }                 from './db';
import { expireStaleServers }     from './servers';
import { rebuildSnapshot }        from './ladder';
import { config, log }            from './config';

// ─── Session cleanup ──────────────────────────────────────────────────────────

async function cleanExpiredSessions(): Promise<void> {
  const result = await prisma.session.updateMany({
    where: {
      isActive:  true,
      expiresAt: { lt: new Date() },
    },
    data: { isActive: false },
  });

  if (result.count > 0) {
    log.debug(`[tasks] expired ${result.count} session(s)`);

    // Mark any player whose ALL sessions are now inactive as offline
    const affected = await prisma.session.findMany({
      where: {
        isActive:   false,
        expiresAt:  { lt: new Date(Date.now() + 5_000) }, // just expired
      },
      select:  { playerId: true },
      distinct: ['playerId'],
    });

    for (const { playerId } of affected) {
      const active = await prisma.session.count({
        where: { playerId, isActive: true },
      });
      if (active === 0) {
        await prisma.player.update({
          where: { id: playerId },
          data:  { isOnline: false },
        });
      }
    }
  }
}

// ─── Online-player sanity check ───────────────────────────────────────────────

/**
 * Any player marked isOnline but with no active session gets corrected.
 * Runs every 10 min.
 */
async function syncOnlineStatus(): Promise<void> {
  const onlinePlayers = await prisma.player.findMany({
    where:  { isOnline: true },
    select: { id: true },
  });

  for (const { id } of onlinePlayers) {
    const activeSessions = await prisma.session.count({
      where: { playerId: id, isActive: true },
    });
    if (activeSessions === 0) {
      await prisma.player.update({ where: { id }, data: { isOnline: false } });
    }
  }
}

// ─── Start all tasks ──────────────────────────────────────────────────────────

export function startTasks(): void {
  // Server timeout: every minute
  setInterval(async () => {
    try { await expireStaleServers(config.serverTimeoutMs); }
    catch (e) { log.error('[tasks] server timeout error', e); }
  }, 60_000);

  // Session cleanup: every 5 minutes
  setInterval(async () => {
    try { await cleanExpiredSessions(); }
    catch (e) { log.error('[tasks] session cleanup error', e); }
  }, 5 * 60_000);

  // Online player sync: every 10 minutes
  setInterval(async () => {
    try { await syncOnlineStatus(); }
    catch (e) { log.error('[tasks] online sync error', e); }
  }, 10 * 60_000);

  // Ladder snapshot: configurable interval
  const ladderInterval = config.ladderRebuildIntervalMs;
  setInterval(async () => {
    try { await rebuildSnapshot(); }
    catch (e) { log.error('[tasks] ladder rebuild error', e); }
  }, ladderInterval);

  // Run ladder rebuild immediately on startup
  rebuildSnapshot().catch(e => log.error('[tasks] initial ladder build error', e));

  log.info('[tasks] background tasks started');
}
