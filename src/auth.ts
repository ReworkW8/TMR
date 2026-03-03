import { prisma }   from './db';
import { normalisePassword, generateToken, stripTmCodes, VALID_NATIONS } from './crypto';
import { config, log } from './config';

export interface AuthOk {
  ok:         true;
  token:      string;
  expiresAt:  Date;
  playerId:   string;
  login:      string;
  nickname:   string;
  nation:     string;
  ladder:     number;
  coppers:    number;
  wins:       number;
  losses:     number;
}

export interface AuthFail {
  ok:    false;
  error: string;
}

export type AuthResult = AuthOk | AuthFail;

// ─── Authenticate ─────────────────────────────────────────────────────────────

export async function authenticate(
  login:    string,
  password: string,
  ip?:      string,
): Promise<AuthResult> {
  const normalLogin = login.trim().toLowerCase();
  const normalPwd   = normalisePassword(password);

  const player = await prisma.player.findUnique({ where: { login: normalLogin } });

  if (!player)                      return { ok: false, error: 'Unknown player' };
  if (player.isBanned)              return { ok: false, error: `Banned: ${player.banReason ?? 'no reason'}` };
  if (player.passwordMd5 !== normalPwd) return { ok: false, error: 'Wrong password' };

  // Invalidate old sessions for this player (keep last 3 to support multi-client)
  const oldSessions = await prisma.session.findMany({
    where:   { playerId: player.id, isActive: true },
    orderBy: { lastSeenAt: 'desc' },
    skip:    3,
  });
  if (oldSessions.length > 0) {
    await prisma.session.updateMany({
      where: { id: { in: oldSessions.map(s => s.id) } },
      data:  { isActive: false },
    });
  }

  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  const token     = generateToken();

  await prisma.session.create({
    data: {
      token,
      playerId:  player.id,
      ip,
      expiresAt,
      lastSeenAt: new Date(),
    },
  });

  await prisma.player.update({
    where: { id: player.id },
    data:  { isOnline: true, lastLoginAt: new Date(), lastLoginIp: ip },
  });

  log.info(`[auth] login ok: ${normalLogin} from ${ip ?? 'unknown'}`);

  return {
    ok:        true,
    token,
    expiresAt,
    playerId:  player.id,
    login:     player.login,
    nickname:  player.nickname,
    nation:    player.nation,
    ladder:    player.ladderPoints,
    coppers:   player.coppers,
    wins:      player.wins,
    losses:    player.losses,
  };
}

// ─── Validate Session ─────────────────────────────────────────────────────────

export async function validateSession(token: string): Promise<{
  valid:    boolean;
  playerId?: string;
  login?:   string;
  nickname?:string;
  nation?:  string;
  ladder?:  number;
  coppers?: number;
}> {
  const session = await prisma.session.findFirst({
    where:   { token, isActive: true },
    include: { player: true },
  });

  if (!session) return { valid: false };

  const now = Date.now();
  if (now > session.expiresAt.getTime()) {
    // Expire it
    await prisma.session.update({
      where: { id: session.id },
      data:  { isActive: false },
    });
    await tryMarkOffline(session.playerId);
    return { valid: false };
  }

  // Slide the expiry window
  await prisma.session.update({
    where: { id: session.id },
    data:  { lastSeenAt: new Date(), expiresAt: new Date(now + config.sessionTtlMs) },
  });

  const p = session.player;
  return {
    valid:    true,
    playerId: p.id,
    login:    p.login,
    nickname: p.nickname,
    nation:   p.nation,
    ladder:   p.ladderPoints,
    coppers:  p.coppers,
  };
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logout(token: string): Promise<void> {
  const session = await prisma.session.findFirst({ where: { token } });
  if (!session) return;

  await prisma.session.update({
    where: { id: session.id },
    data:  { isActive: false },
  });

  await tryMarkOffline(session.playerId);
  log.info(`[auth] logout: ${token.slice(0, 8)}…`);
}

// ─── Register ─────────────────────────────────────────────────────────────────

export interface RegisterResult {
  ok:    boolean;
  error?: string;
}

export async function register(
  login:    string,
  password: string,
  nickname: string,
  nation:   string,
  email?:   string,
): Promise<RegisterResult> {
  const normalLogin = login.trim().toLowerCase();

  if (normalLogin.length < 2 || normalLogin.length > 50)
    return { ok: false, error: 'Login must be 2–50 characters' };
  if (!/^[a-z0-9._\-]+$/.test(normalLogin))
    return { ok: false, error: 'Login may only contain a-z, 0-9, . _ -' };
  if (password.length < 4)
    return { ok: false, error: 'Password too short (min 4)' };

  const normalNation = nation.toUpperCase();
  if (!VALID_NATIONS.has(normalNation))
    return { ok: false, error: `Unknown nation code: ${nation}` };

  const existing = await prisma.player.findUnique({ where: { login: normalLogin } });
  if (existing) return { ok: false, error: 'Login already taken' };

  const nick    = nickname.trim() || normalLogin;
  const pwdHash = normalisePassword(password);

  await prisma.player.create({
    data: {
      login:           normalLogin,
      passwordMd5:     pwdHash,
      nickname:        nick,
      nicknameStripped: stripTmCodes(nick),
      nation:          normalNation,
      email:           email || null,
      ladderPoints:    1000,
      coppers:         0,
    },
  });

  log.info(`[auth] registered: ${normalLogin} (${normalNation})`);
  return { ok: true };
}

// ─── Get Player ───────────────────────────────────────────────────────────────

export async function getPlayerByLogin(login: string) {
  return prisma.player.findUnique({
    where: { login: login.trim().toLowerCase() },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tryMarkOffline(playerId: string): Promise<void> {
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
