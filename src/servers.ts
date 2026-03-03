import { prisma }   from './db';
import { log }      from './config';

export interface ServerInfo {
  id:               string;
  serverLogin:      string;
  serverName:       string;
  ip:               string;
  port:             number;
  currentPlayers:   number;
  maxPlayers:       number;
  currentSpecs:     number;
  maxSpectators:    number;
  environment:      string;
  gameMode:         string;
  ladderMode:       number;
  isPassworded:     boolean;
  isLadder:         boolean;
  isOfficial:       boolean;
  currentMapName:   string;
  currentMapUid:    string;
}

// ─── Register ─────────────────────────────────────────────────────────────────

export async function registerServer(opts: {
  serverLogin:   string;
  serverName:    string;
  serverComment?: string;
  serverPassword?: string;
  ip:            string;
  port?:         number;
  queryPort?:    number;
  maxPlayers?:   number;
  maxSpectators?:number;
  environment?:  string;
  gameMode?:     string;
  ladderMode?:   number;
  ownerLogin?:   string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // Check IP ban
  const ban = await prisma.bannedIp.findUnique({ where: { ip: opts.ip } });
  if (ban) {
    if (!ban.expiresAt || ban.expiresAt > new Date()) {
      log.warn(`[servers] banned IP tried to register: ${opts.ip}`);
      return { ok: false, error: 'Server IP is banned' };
    }
  }

  const server = await prisma.gameServer.upsert({
    where: { serverLogin: opts.serverLogin },
    create: {
      serverLogin:    opts.serverLogin,
      serverName:     opts.serverName,
      serverComment:  opts.serverComment ?? '',
      serverPassword: opts.serverPassword ?? null,
      ip:             opts.ip,
      port:           opts.port ?? 2350,
      queryPort:      opts.queryPort ?? 5000,
      maxPlayers:     opts.maxPlayers ?? 32,
      maxSpectators:  opts.maxSpectators ?? 10,
      environment:    opts.environment ?? 'Stadium',
      gameMode:       opts.gameMode ?? 'TimeAttack',
      ladderMode:     opts.ladderMode ?? 0,
      ownerLogin:     opts.ownerLogin ?? null,
      isOnline:       true,
      lastHeartbeatAt: new Date(),
    },
    update: {
      serverName:      opts.serverName,
      serverComment:   opts.serverComment ?? '',
      serverPassword:  opts.serverPassword ?? null,
      ip:              opts.ip,
      port:            opts.port ?? 2350,
      queryPort:       opts.queryPort ?? 5000,
      maxPlayers:      opts.maxPlayers ?? 32,
      maxSpectators:   opts.maxSpectators ?? 10,
      environment:     opts.environment ?? 'Stadium',
      gameMode:        opts.gameMode ?? 'TimeAttack',
      ladderMode:      opts.ladderMode ?? 0,
      ownerLogin:      opts.ownerLogin ?? null,
      isOnline:        true,
      currentPlayers:  0,
      currentSpecs:    0,
      lastHeartbeatAt: new Date(),
    },
  });

  log.info(`[servers] registered: ${opts.serverLogin} (${opts.ip}:${opts.port ?? 2350})`);
  return { ok: true, id: server.id };
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

export async function heartbeat(
  serverLogin:    string,
  playerCount:    number,
  maxPlayers?:    number,
  spectCount?:    number,
  gameMode?:      string,
  mapUid?:        string,
  mapName?:       string,
): Promise<boolean> {
  const server = await prisma.gameServer.findUnique({ where: { serverLogin } });
  if (!server) return false;

  await prisma.gameServer.update({
    where: { serverLogin },
    data: {
      isOnline:        true,
      currentPlayers:  Math.max(0, playerCount),
      maxPlayers:      maxPlayers ?? server.maxPlayers,
      currentSpecs:    Math.max(0, spectCount ?? 0),
      gameMode:        gameMode  ?? server.gameMode,
      currentMapUid:   mapUid   ?? server.currentMapUid,
      currentMapName:  mapName  ?? server.currentMapName,
      lastHeartbeatAt: new Date(),
    },
  });
  return true;
}

// ─── Unregister ───────────────────────────────────────────────────────────────

export async function unregisterServer(serverLogin: string): Promise<void> {
  await prisma.gameServer.updateMany({
    where: { serverLogin },
    data:  { isOnline: false, currentPlayers: 0, currentSpecs: 0 },
  });
  log.info(`[servers] unregistered: ${serverLogin}`);
}

// ─── Get Server List ──────────────────────────────────────────────────────────

export async function getServerList(filter?: {
  environment?: string;
  gameMode?:    string;
  hasPlayers?:  boolean;
  onlyLadder?:  boolean;
}): Promise<ServerInfo[]> {
  const where: Record<string, unknown> = {
    isOnline:   true,
    hideServer: 0,
  };

  if (filter?.environment)
    where.environment = filter.environment;
  if (filter?.gameMode)
    where.gameMode = filter.gameMode;
  if (filter?.hasPlayers)
    where.currentPlayers = { gt: 0 };
  if (filter?.onlyLadder)
    where.isLadder = true;

  const servers = await prisma.gameServer.findMany({
    where,
    orderBy: [
      { currentPlayers: 'desc' },
      { registeredAt:   'asc'  },
    ],
  });

  return servers.map(s => ({
    id:             s.id,
    serverLogin:    s.serverLogin,
    serverName:     s.serverName,
    ip:             s.ip,
    port:           s.port,
    currentPlayers: s.currentPlayers,
    maxPlayers:     s.maxPlayers,
    currentSpecs:   s.currentSpecs,
    maxSpectators:  s.maxSpectators,
    environment:    s.environment,
    gameMode:       s.gameMode,
    ladderMode:     s.ladderMode,
    isPassworded:   !!s.serverPassword,
    isLadder:       s.isLadder,
    isOfficial:     s.isOfficial,
    currentMapName: s.currentMapName ?? '',
    currentMapUid:  s.currentMapUid  ?? '',
  }));
}

// ─── Expire stale servers ─────────────────────────────────────────────────────

export async function expireStaleServers(timeoutMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs);
  const result = await prisma.gameServer.updateMany({
    where: {
      isOnline: true,
      OR: [
        { lastHeartbeatAt: { lt: cutoff } },
        { lastHeartbeatAt: null },
      ],
    },
    data: { isOnline: false, currentPlayers: 0, currentSpecs: 0 },
  });
  if (result.count > 0)
    log.info(`[servers] marked ${result.count} stale server(s) offline`);
  return result.count;
}
