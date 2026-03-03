import { prisma } from './db';

export async function addBuddy(
  playerId:   string,
  targetLogin: string,
): Promise<{ ok: boolean; error?: string }> {
  const target = await prisma.player.findUnique({
    where: { login: targetLogin.toLowerCase() },
  });
  if (!target) return { ok: false, error: 'Player not found' };
  if (target.id === playerId) return { ok: false, error: 'Cannot add yourself' };

  try {
    await prisma.buddy.create({ data: { playerId, targetId: target.id } });
    return { ok: true };
  } catch {
    return { ok: false, error: 'Already in buddy list' };
  }
}

export async function removeBuddy(
  playerId:    string,
  targetLogin: string,
): Promise<void> {
  const target = await prisma.player.findUnique({
    where: { login: targetLogin.toLowerCase() },
  });
  if (!target) return;

  await prisma.buddy.deleteMany({
    where: { playerId, targetId: target.id },
  });
}

export async function blockBuddy(
  playerId:    string,
  targetLogin: string,
): Promise<void> {
  const target = await prisma.player.findUnique({
    where: { login: targetLogin.toLowerCase() },
  });
  if (!target) return;

  await prisma.buddy.upsert({
    where:  { playerId_targetId: { playerId, targetId: target.id } },
    create: { playerId, targetId: target.id, isBlocked: true },
    update: { isBlocked: true },
  });
}

export async function getBuddyList(playerId: string): Promise<Array<{
  login:    string;
  nickname: string;
  nation:   string;
  isOnline: boolean;
  isBlocked:boolean;
}>> {
  const rows = await prisma.buddy.findMany({
    where:   { playerId },
    include: {
      target: { select: { login: true, nickname: true, nation: true, isOnline: true } },
    },
  });

  return rows.map(r => ({
    login:    r.target.login,
    nickname: r.target.nickname,
    nation:   r.target.nation,
    isOnline: r.target.isOnline,
    isBlocked:r.isBlocked,
  }));
}
