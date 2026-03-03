import { prisma } from './db';
import { log }    from './config';

// ─── Increment / Decrement points ─────────────────────────────────────────────

export async function addPoints(playerId: string, delta: number): Promise<void> {
  await prisma.player.update({
    where: { id: playerId },
    data:  { ladderPoints: { increment: delta } },
  });
}

export async function setPoints(playerId: string, points: number): Promise<void> {
  await prisma.player.update({
    where: { id: playerId },
    data:  { ladderPoints: Math.max(0, points) },
  });
}

// ─── Post match result ────────────────────────────────────────────────────────

/**
 * Update ladder after a match.
 * positions: array of { login, rank, time } ordered best-first.
 * Simple Elo-like calculation:
 *   winner gets +N points, others get proportionally fewer, last gets 0.
 */
export async function postMatchResult(
  positions: Array<{ login: string; rank: number }>,
  baseReward = 100,
): Promise<void> {
  if (positions.length === 0) return;
  const total = positions.length;

  for (const pos of positions) {
    const player = await prisma.player.findUnique({ where: { login: pos.login } });
    if (!player) continue;
    const ratio  = (total - pos.rank) / Math.max(1, total - 1);
    const delta  = Math.round(baseReward * ratio);
    const isWin  = pos.rank === 0;
    const isLoss = pos.rank === total - 1;

    await prisma.player.update({
      where: { id: player.id },
      data:  {
        ladderPoints: { increment: delta },
        wins:   { increment: isWin  ? 1 : 0 },
        losses: { increment: isLoss ? 1 : 0 },
      },
    });
  }
}

// ─── Track Records ────────────────────────────────────────────────────────────

export async function submitRecord(
  playerId:    string,
  trackUid:    string,
  timeMs:      number,
  checkpoints: number[],
  respawns:    number,
  trackName?:  string,
  environment?:string,
  serverLogin?:string,
  gameMode?:   string,
): Promise<{ improved: boolean; previous?: number }> {
  const existing = await prisma.trackRecord.findUnique({
    where: { playerId_trackUid: { playerId, trackUid } },
  });

  const improved = !existing || timeMs < existing.time;

  if (improved) {
    await prisma.trackRecord.upsert({
      where:  { playerId_trackUid: { playerId, trackUid } },
      create: {
        playerId, trackUid, time: timeMs,
        checkpoints:  JSON.stringify(checkpoints),
        respawns, trackName, environment, serverLogin, gameMode,
      },
      update: {
        time:         timeMs,
        checkpoints:  JSON.stringify(checkpoints),
        respawns, trackName, environment, serverLogin, gameMode,
      },
    });
  }

  return { improved, previous: existing?.time };
}

export async function getTrackRecords(
  trackUid: string,
  limit = 50,
): Promise<Array<{
  rank:     number;
  login:    string;
  nickname: string;
  nation:   string;
  time:     number;
  setAt:    string;
}>> {
  const records = await prisma.trackRecord.findMany({
    where:   { trackUid },
    include: { player: { select: { login: true, nickname: true, nation: true } } },
    orderBy: { time: 'asc' },
    take:    limit,
  });

  return records.map((r, i) => ({
    rank:     i + 1,
    login:    r.player.login,
    nickname: r.player.nickname,
    nation:   r.player.nation,
    time:     r.time,
    setAt:    r.setAt.toISOString(),
  }));
}

// ─── Ladder Snapshot & Rankings ───────────────────────────────────────────────

/**
 * Rebuild the cached ladder snapshot.
 * Called by the background task every N minutes.
 */
export async function rebuildSnapshot(): Promise<void> {
  const players = await prisma.player.findMany({
    where:   { isBanned: false },
    orderBy: { ladderPoints: 'desc' },
    select:  {
      id: true, login: true, nickname: true, nation: true, ladderPoints: true,
    },
  });

  // Wipe and rewrite in a single transaction
  await prisma.$transaction([
    prisma.ladderSnapshot.deleteMany(),
    prisma.ladderSnapshot.createMany({
      data: players.map((p, i) => ({
        playerId: p.id,
        login:    p.login,
        nickname: p.nickname,
        nation:   p.nation,
        points:   p.ladderPoints,
        rank:     i + 1,
      })),
    }),
  ]);

  log.info(`[ladder] snapshot rebuilt (${players.length} players)`);
}

/** Read rankings from the snapshot (fast, no joins) */
export async function getRankings(
  limit = 100,
  offset = 0,
  nation?: string,
): Promise<Array<{
  rank:    number;
  login:   string;
  nickname:string;
  nation:  string;
  points:  number;
}>> {
  const where = nation && nation !== 'WOR' ? { nation } : {};
  const rows = await prisma.ladderSnapshot.findMany({
    where,
    orderBy: { rank: 'asc' },
    take:    limit,
    skip:    offset,
  });
  return rows.map(r => ({
    rank:     r.rank,
    login:    r.login,
    nickname: r.nickname,
    nation:   r.nation,
    points:   r.points,
  }));
}

export async function getPlayerRank(playerId: string): Promise<number | null> {
  const snap = await prisma.ladderSnapshot.findUnique({ where: { playerId } });
  return snap?.rank ?? null;
}
