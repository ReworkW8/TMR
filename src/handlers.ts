/**
 * XML-RPC method handlers for the Trackmania United 2006 master server.
 *
 * Every method the game client or dedicated server sends is handled here.
 * Each handler receives the parsed params array and returns an RpcValue
 * (to be wrapped in successResponse) OR throws an RpcError to produce a fault.
 */

import { RpcValue } from './xmlrpc';
import * as auth    from './auth';
import * as srv     from './servers';
import * as ladder  from './ladder';
import * as buddies from './buddies';
import { log }      from './config';
import { prisma }   from './db';

// ─── Error helper ─────────────────────────────────────────────────────────────

export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

function deny(code: number, msg: string): never { throw new RpcError(code, msg); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asStr(v: unknown, name: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  deny(400, `${name} must be a string`);
}

function asInt(v: unknown, name: string): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  deny(400, `${name} must be an integer`);
}

function asStruct(v: unknown, name: string): Record<string, RpcValue> {
  if (v && typeof v === 'object' && !Array.isArray(v))
    return v as Record<string, RpcValue>;
  deny(400, `${name} must be a struct`);
}

function opt<T>(v: T | null | undefined, def: T): T {
  return (v === null || v === undefined) ? def : v;
}

/** Resolve a player by session token. Throws 401 if invalid. */
async function sessionPlayer(token: string) {
  const s = await auth.validateSession(token);
  if (!s.valid) deny(401, 'Invalid or expired session');
  return s;
}

// ─── Handler type ─────────────────────────────────────────────────────────────

type Handler = (params: RpcValue[], ip: string) => Promise<RpcValue>;

// ─── system.* ─────────────────────────────────────────────────────────────────

const handleListMethods: Handler = async () => METHODS;

const handleMethodHelp: Handler = async ([method]) => {
  const m = asStr(method, 'method');
  return HELP[m] ?? `No help available for ${m}`;
};

const handleMethodSig: Handler = async ([method]) => {
  const m = asStr(method, 'method');
  return [[m in handlerMap ? 'variant' : 'undefined']];
};

// ─── Authentication ───────────────────────────────────────────────────────────

/**
 * Authenticate(login, password) → struct
 * password is expected as MD5 hex (what TMU clients send).
 */
const handleAuthenticate: Handler = async ([login, password], ip) => {
  const l = asStr(login,    'login');
  const p = asStr(password, 'password');
  const result = await auth.authenticate(l, p, ip);
  if (!result.ok) deny(401, result.error);
  return {
    SessionId:    result.token,
    AccountId:    result.playerId,
    Login:        result.login,
    Nickname:     result.nickname,
    Nation:       result.nation,
    LadderPoints: result.ladder,
    Coppers:      result.coppers,
    Wins:         result.wins,
    Losses:       result.losses,
    Path:         `World|${result.nation}`,
    AuthLevel:    1,
  };
};

/**
 * CreateAccount(login, password, nickname, nation) → boolean
 */
const handleCreateAccount: Handler = async ([login, password, nickname, nation]) => {
  const l = asStr(login,    'login');
  const p = asStr(password, 'password');
  const n = asStr(nickname, 'nickname');
  const c = asStr(nation,   'nation');
  const result = await auth.register(l, p, n, c);
  if (!result.ok) deny(400, result.error!);
  return true;
};

/**
 * Logout(sessionId) → boolean
 */
const handleLogout: Handler = async ([token]) => {
  const t = asStr(token, 'sessionId');
  await auth.logout(t);
  return true;
};

/**
 * ValidateSession(sessionId) → struct | false
 */
const handleValidateSession: Handler = async ([token]) => {
  const t = asStr(token, 'sessionId');
  const s = await auth.validateSession(t);
  if (!s.valid) return false;
  return {
    Valid:        true,
    Login:        s.login!,
    Nickname:     s.nickname!,
    Nation:       s.nation!,
    LadderPoints: s.ladder!,
    Coppers:      s.coppers!,
  };
};

/**
 * GetPlayerInfo(login) → struct
 */
const handleGetPlayerInfo: Handler = async ([login]) => {
  const l = asStr(login, 'login');
  const player = await auth.getPlayerByLogin(l);
  if (!player) deny(404, `Player not found: ${l}`);
  const rank = await ladder.getPlayerRank(player.id);
  return {
    Login:        player.login,
    Nickname:     player.nickname,
    Nation:       player.nation,
    Path:         `World|${player.nation}`,
    LadderPoints: player.ladderPoints,
    LadderRank:   rank ?? 0,
    Coppers:      player.coppers,
    Wins:         player.wins,
    Losses:       player.losses,
    IsOnline:     player.isOnline,
  };
};

// ─── Server Registry ──────────────────────────────────────────────────────────

/**
 * RegisterServer(sessionId, serverLogin, serverName, ip, port, options{}) → struct
 * OR
 * RegisterServer(serverLogin, serverName, ip, port, options{}) → struct
 */
const handleRegisterServer: Handler = async (params, ip) => {
  // Params can start with an optional sessionId
  let offset = 0;
  if (params.length >= 5) {
    const first = asStr(params[0], 'p0');
    // Heuristic: session tokens are 48-char hex; server logins are shorter
    if (first.length === 48) offset = 1;
  }

  const serverLogin = asStr(params[offset],     'serverLogin');
  const serverName  = asStr(params[offset + 1], 'serverName');
  const srvIp       = params.length > offset + 2 ? asStr(params[offset + 2], 'ip')   : ip;
  const port        = params.length > offset + 3 ? asInt(params[offset + 3], 'port') : 2350;
  const opts        = params.length > offset + 4
    ? asStruct(params[offset + 4], 'options') : {};

  const result = await srv.registerServer({
    serverLogin,
    serverName,
    serverComment: opt(opts.Comment as string,  ''),
    serverPassword:opt(opts.Password as string,  undefined),
    ip:            srvIp,
    port,
    maxPlayers:    opt(opts.MaxPlayers as number, 32),
    maxSpectators: opt(opts.MaxSpectators as number, 10),
    environment:   opt(opts.Environment as string, 'Stadium'),
    gameMode:      opt(opts.GameMode as string, 'TimeAttack'),
    ladderMode:    opt(opts.LadderMode as number, 0),
  });

  if (!result.ok) deny(400, result.error);
  return { ServerId: result.id };
};

/**
 * UnregisterServer(sessionId, serverLogin) → boolean
 */
const handleUnregisterServer: Handler = async ([, serverLogin]) => {
  const l = asStr(serverLogin, 'serverLogin');
  await srv.unregisterServer(l);
  return true;
};

/**
 * ServerHeartbeat(serverLogin, playerCount, maxPlayers, spectCount, gameMode, mapUid, mapName)
 * Also aliased as KeepAlive
 */
const handleHeartbeat: Handler = async (params) => {
  // Some versions send sessionId as first param
  let offset = 0;
  const first = asStr(params[0], 'p0');
  if (first.length === 48) offset = 1; // session token

  const serverLogin = asStr(params[offset],     'serverLogin');
  const playerCount = asInt(params[offset + 1], 'playerCount');
  const maxPlayers  = params[offset + 2] !== undefined ? asInt(params[offset + 2], 'maxPlayers') : undefined;
  const spectCount  = params[offset + 3] !== undefined ? asInt(params[offset + 3], 'spectCount') : undefined;
  const gameMode    = params[offset + 4] !== undefined ? asStr(params[offset + 4], 'gameMode')  : undefined;
  const mapUid      = params[offset + 5] !== undefined ? asStr(params[offset + 5], 'mapUid')    : undefined;
  const mapName     = params[offset + 6] !== undefined ? asStr(params[offset + 6], 'mapName')   : undefined;

  const ok = await srv.heartbeat(serverLogin, playerCount, maxPlayers, spectCount, gameMode, mapUid, mapName);
  if (!ok) deny(404, `Unknown server: ${serverLogin}`);
  return { Timestamp: Date.now(), NextCall: 60 };
};

/**
 * GetServerList(filter{}) → array of server structs
 */
const handleGetServerList: Handler = async ([filter]) => {
  const f = filter && typeof filter === 'object' && !Array.isArray(filter)
    ? filter as Record<string, RpcValue> : {};

  const servers = await srv.getServerList({
    environment: f.Environment as string | undefined,
    gameMode:    f.GameMode    as string | undefined,
    hasPlayers:  f.HasPlayers  as boolean | undefined,
    onlyLadder:  f.LadderOnly  as boolean | undefined,
  });

  return servers.map(s => ({
    Login:          s.serverLogin,
    Name:           s.serverName,
    Ip:             s.ip,
    Port:           s.port,
    PlayerCount:    s.currentPlayers,
    MaxPlayers:     s.maxPlayers,
    SpectatorCount: s.currentSpecs,
    MaxSpectators:  s.maxSpectators,
    Environment:    s.environment,
    GameMode:       s.gameMode,
    LadderMode:     s.ladderMode,
    IsPassworded:   s.isPassworded,
    IsLadder:       s.isLadder,
    IsOfficial:     s.isOfficial,
    CurrentMap:     s.currentMapName,
    CurrentMapUid:  s.currentMapUid,
  }));
};

// ─── Buddy System ─────────────────────────────────────────────────────────────

const handleGetBuddies: Handler = async ([token]) => {
  const t = asStr(token, 'sessionId');
  const s = await sessionPlayer(t);
  const list = await buddies.getBuddyList(s.playerId!);
  return list.map(b => ({
    Login:    b.login,
    Nickname: b.nickname,
    Nation:   b.nation,
    IsOnline: b.isOnline,
    Blocked:  b.isBlocked,
  }));
};

const handleAddBuddy: Handler = async ([token, targetLogin]) => {
  const t  = asStr(token,       'sessionId');
  const tl = asStr(targetLogin, 'targetLogin');
  const s  = await sessionPlayer(t);
  const result = await buddies.addBuddy(s.playerId!, tl);
  if (!result.ok) deny(400, result.error!);
  return true;
};

const handleRemoveBuddy: Handler = async ([token, targetLogin]) => {
  const t  = asStr(token,       'sessionId');
  const tl = asStr(targetLogin, 'targetLogin');
  const s  = await sessionPlayer(t);
  await buddies.removeBuddy(s.playerId!, tl);
  return true;
};

const handleBlockBuddy: Handler = async ([token, targetLogin]) => {
  const t  = asStr(token,       'sessionId');
  const tl = asStr(targetLogin, 'targetLogin');
  const s  = await sessionPlayer(t);
  await buddies.blockBuddy(s.playerId!, tl);
  return true;
};

// ─── Ladder ───────────────────────────────────────────────────────────────────

const handleGetLadderRankings: Handler = async ([limitV, offsetV, nationV]) => {
  const lim    = limitV  ? asInt(limitV,  'limit')  : 100;
  const off    = offsetV ? asInt(offsetV, 'offset') : 0;
  const nation = nationV ? asStr(nationV, 'nation') : undefined;
  const rows   = await ladder.getRankings(Math.min(lim, 500), off, nation);
  return rows.map(r => ({
    Rank:         r.rank,
    Login:        r.login,
    Nickname:     r.nickname,
    Nation:       r.nation,
    LadderPoints: r.points,
  }));
};

const handleUpdateLadderPoints: Handler = async ([token, delta]) => {
  const t = asStr(token, 'sessionId');
  const d = asInt(delta, 'delta');
  const s = await sessionPlayer(t);
  await ladder.addPoints(s.playerId!, d);
  return true;
};

const handleSetLadderResult: Handler = async ([token, positionsV]) => {
  const t = asStr(token, 'sessionId');
  await sessionPlayer(t);
  const posArr = Array.isArray(positionsV) ? positionsV : [];
  const positions = posArr.map((p, i) => {
    const item = asStruct(p, `position[${i}]`);
    return {
      login: asStr(item.Login ?? item.login, 'Login'),
      rank:  asInt(item.Rank  ?? item.rank,  'Rank'),
    };
  });
  await ladder.postMatchResult(positions);
  return true;
};

// ─── Track Records ────────────────────────────────────────────────────────────

const handleGetTrackRecords: Handler = async ([trackUid, limitV]) => {
  const uid   = asStr(trackUid, 'trackUid');
  const lim   = limitV ? asInt(limitV, 'limit') : 50;
  const recs  = await ladder.getTrackRecords(uid, Math.min(lim, 200));
  return recs.map(r => ({
    Rank:     r.rank,
    Login:    r.login,
    Nickname: r.nickname,
    Nation:   r.nation,
    Time:     r.time,
    SetAt:    r.setAt,
  }));
};

const handleSubmitRecord: Handler = async ([token, trackUid, timeMs, checkpointsV, respawnsV, trackNameV]) => {
  const t       = asStr(token,    'sessionId');
  const uid     = asStr(trackUid, 'trackUid');
  const time    = asInt(timeMs,   'time');
  const s       = await sessionPlayer(t);
  const cps     = Array.isArray(checkpointsV) ? checkpointsV.map(c => asInt(c, 'cp')) : [];
  const respawns = respawnsV ? asInt(respawnsV, 'respawns') : 0;
  const name    = trackNameV ? asStr(trackNameV, 'trackName') : undefined;

  const result = await ladder.submitRecord(
    s.playerId!, uid, time, cps, respawns, name,
  );
  return { Improved: result.improved, Previous: result.previous ?? -1 };
};

// ─── Miscellaneous ────────────────────────────────────────────────────────────

const handleGetSystemStats: Handler = async () => {
  const [totalPlayers, onlinePlayers, totalServers, onlineServers] = await Promise.all([
    prisma.player.count(),
    prisma.player.count({ where: { isOnline: true } }),
    prisma.gameServer.count(),
    prisma.gameServer.count({ where: { isOnline: true } }),
  ]);
  return {
    TotalPlayers:  totalPlayers,
    OnlinePlayers: onlinePlayers,
    TotalServers:  totalServers,
    OnlineServers: onlineServers,
    Uptime:        process.uptime(),
  };
};

const handleGetAnnouncements: Handler = async () => {
  const now = new Date();
  const rows = await prisma.announcement.findMany({
    where: {
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
  return rows.map(r => ({ Message: r.message, Lang: r.lang }));
};

// ─── Method map ───────────────────────────────────────────────────────────────

const handlerMap: Record<string, Handler> = {
  // System
  'system.listMethods':    handleListMethods,
  'system.methodHelp':     handleMethodHelp,
  'system.methodSignature':handleMethodSig,

  // Authentication – all known aliases Nadeo used
  'Authenticate':           handleAuthenticate,
  'Login':                  handleAuthenticate,
  'TMLogin':                handleAuthenticate,
  'CreateAccount':          handleCreateAccount,
  'RegisterAccount':        handleCreateAccount,
  'Logout':                 handleLogout,
  'Disconnect':             handleLogout,
  'ValidateSession':        handleValidateSession,
  'IsSessionValid':         handleValidateSession,
  'CheckSession':           handleValidateSession,
  'GetPlayerInfo':          handleGetPlayerInfo,
  'GetAccountData':         handleGetPlayerInfo,

  // Servers
  'RegisterServer':         handleRegisterServer,
  'AddServer':              handleRegisterServer,
  'UnregisterServer':       handleUnregisterServer,
  'RemoveServer':           handleUnregisterServer,
  'ServerHeartbeat':        handleHeartbeat,
  'KeepAlive':              handleHeartbeat,
  'SendAlive':              handleHeartbeat,
  'GetServerList':          handleGetServerList,
  'GetServers':             handleGetServerList,
  'GetServerInfoList':      handleGetServerList,

  // Buddies
  'GetBuddyList':           handleGetBuddies,
  'GetBuddies':             handleGetBuddies,
  'GetFriendList':          handleGetBuddies,
  'AddBuddy':               handleAddBuddy,
  'AddFriend':              handleAddBuddy,
  'RemoveBuddy':            handleRemoveBuddy,
  'RemoveFriend':           handleRemoveBuddy,
  'BlockBuddy':             handleBlockBuddy,

  // Ladder
  'GetLadderRankings':      handleGetLadderRankings,
  'GetTopLadder':           handleGetLadderRankings,
  'GetLadderTop':           handleGetLadderRankings,
  'UpdateLadderPoints':     handleUpdateLadderPoints,
  'AddLadderPoints':        handleUpdateLadderPoints,
  'SetLadderResult':        handleSetLadderResult,
  'PostLadderResult':       handleSetLadderResult,

  // Records
  'GetTrackRecords':        handleGetTrackRecords,
  'GetChallengeRecords':    handleGetTrackRecords,
  'SubmitRecord':           handleSubmitRecord,
  'SetChallengeRecord':     handleSubmitRecord,

  // Misc
  'GetSystemStats':         handleGetSystemStats,
  'GetMasterServerStats':   handleGetSystemStats,
  'GetAnnouncements':       handleGetAnnouncements,
  'GetMessages':            handleGetAnnouncements,
};

export const METHODS: string[] = Object.keys(handlerMap);

const HELP: Record<string, string> = {
  'Authenticate':        'Authenticate(login, md5password) → session struct',
  'CreateAccount':       'CreateAccount(login, md5password, nickname, nation) → bool',
  'Logout':              'Logout(sessionId) → bool',
  'ValidateSession':     'ValidateSession(sessionId) → player struct | false',
  'GetPlayerInfo':       'GetPlayerInfo(login) → player struct',
  'RegisterServer':      'RegisterServer([sessionId], login, name, ip, port, opts{}) → {ServerId}',
  'UnregisterServer':    'UnregisterServer([sessionId], serverLogin) → bool',
  'ServerHeartbeat':     'ServerHeartbeat([sessionId], serverLogin, players, maxPlayers, specs, mode, mapUid, mapName) → {Timestamp,NextCall}',
  'GetServerList':       'GetServerList(filter{}) → [{Login,Name,Ip,Port,...}]',
  'GetBuddyList':        'GetBuddyList(sessionId) → [{Login,Nickname,...}]',
  'AddBuddy':            'AddBuddy(sessionId, targetLogin) → bool',
  'RemoveBuddy':         'RemoveBuddy(sessionId, targetLogin) → bool',
  'GetLadderRankings':   'GetLadderRankings(limit, offset, nation) → [{Rank,Login,...}]',
  'UpdateLadderPoints':  'UpdateLadderPoints(sessionId, delta) → bool',
  'SetLadderResult':     'SetLadderResult(sessionId, [{Login,Rank}]) → bool',
  'GetTrackRecords':     'GetTrackRecords(trackUid, limit) → [{Rank,Login,Time,...}]',
  'SubmitRecord':        'SubmitRecord(sessionId, trackUid, timeMs, checkpoints[], respawns, name) → {Improved,Previous}',
  'GetSystemStats':      'GetSystemStats() → {TotalPlayers,OnlinePlayers,...}',
};

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function dispatch(
  method: string,
  params: RpcValue[],
  ip:     string,
): Promise<RpcValue> {
  log.debug(`[rpc] ${method}(${params.length} params) from ${ip}`);

  const handler = handlerMap[method];
  if (!handler) {
    log.warn(`[rpc] unknown method: ${method}`);
    throw new RpcError(404, `Unknown method: ${method}`);
  }

  return handler(params, ip);
}
