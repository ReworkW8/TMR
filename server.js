/**
 * ============================================================
 *  Mania Zones Admin Panel — TMR Bridge Server
 *  Run this on the SAME machine as your TMR Server
 *
 *  Usage:
 *    node server.js
 *
 *  Then open mania-zones-admin.html in your browser.
 * ============================================================
 */

const http    = require('http');
const net     = require('net');
const url     = require('url');
const path    = require('path');
const fs      = require('fs');

// ============================================================
//  CONFIG — edit these to match your server
// ============================================================
const TM_HOST     = '127.0.0.1';   // TMR host (usually localhost)
const TM_PORT     = 5000;          // TMR XMLRPC port (default 5000)
const TM_LOGIN    = 'SuperAdmin';  // XMLRPC login
const TM_PASS     = 'SuperAdmin';  // XMLRPC password (from dedicated_cfg.txt)
const BRIDGE_PORT = 8765;          // Port this bridge listens on
// ============================================================

let xmlrpcSocket  = null;
let socketReady   = false;
let callIdCounter = 0x80000000;
let pendingCalls  = {};   // id => { resolve, reject }
let receiveBuffer = Buffer.alloc(0);
let serverName    = 'TM-Polska-01';

// ============================
//  GBX XMLRPC Protocol
// ============================

// Build a GBXRemote2 XMLRPC request packet
function buildPacket(methodName, params) {
  const xmlBody = buildXml(methodName, params);
  const xmlBuf  = Buffer.from(xmlBody, 'utf8');
  const header  = Buffer.alloc(8);
  header.writeUInt32LE(xmlBuf.length, 0);
  header.writeUInt32LE(callIdCounter, 4);
  return Buffer.concat([header, xmlBuf]);
}

function buildXml(method, params) {
  const paramXml = (params || []).map(p => `<param>${valueToXml(p)}</param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramXml}</params></methodCall>`;
}

function valueToXml(v) {
  if (v === null || v === undefined) return '<value><nil/></value>';
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number' && Number.isInteger(v)) return `<value><int>${v}</int></value>`;
  if (typeof v === 'number') return `<value><double>${v}</double></value>`;
  if (typeof v === 'string') return `<value><string>${escXml(v)}</string></value>`;
  if (Array.isArray(v)) {
    const items = v.map(i => `<value>${valueToXml(i)}</value>`).join('');
    return `<value><array><data>${items}</data></array></value>`;
  }
  if (typeof v === 'object') {
    const members = Object.entries(v).map(([k,val]) =>
      `<member><name>${escXml(k)}</name>${valueToXml(val)}</member>`).join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escXml(String(v))}</string></value>`;
}

function escXml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');
}

// Parse GBXRemote response XML into a JS value
function parseXmlResponse(xml) {
  // Check for fault
  if (xml.includes('<fault>')) {
    const code = xmlTextOf(xml, 'int') || xmlTextOf(xml, 'i4') || '0';
    const msg  = xmlStringOf(xml) || 'Unknown fault';
    throw new Error(`XMLRPC Fault ${code}: ${msg}`);
  }
  return parseValue(xml);
}

function xmlTextOf(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

function xmlStringOf(xml) {
  const m = xml.match(/<string>([^<]*)<\/string>/);
  return m ? m[1] : null;
}

function parseValue(xml) {
  // Strip outer tags to get first <value> content
  const valMatch = xml.match(/<value>([\s\S]*?)<\/value>/);
  if (!valMatch) return null;
  const inner = valMatch[1].trim();
  return parseTypedValue(inner);
}

function parseTypedValue(inner) {
  if (inner.startsWith('<string>'))  return inner.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
  if (inner.startsWith('<int>') || inner.startsWith('<i4>')) return parseInt(inner.replace(/<[^>]+>/g,''),10);
  if (inner.startsWith('<double>'))  return parseFloat(inner.replace(/<[^>]+>/g,''));
  if (inner.startsWith('<boolean>')) return inner.includes('>1<');
  if (inner.startsWith('<nil'))      return null;
  if (inner.startsWith('<base64>'))  return Buffer.from(inner.replace(/<[^>]+>/g,''),'base64').toString();

  if (inner.startsWith('<array>')) {
    const dataMatch = inner.match(/<data>([\s\S]*)<\/data>/);
    if (!dataMatch) return [];
    return parseValueList(dataMatch[1]);
  }

  if (inner.startsWith('<struct>')) {
    const result = {};
    const memberRe = /<member>\s*<name>([^<]*)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
    let m;
    while ((m = memberRe.exec(inner)) !== null) {
      result[m[1]] = parseTypedValue(m[2].trim());
    }
    return result;
  }

  // Plain text (untyped string)
  return inner.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}

function parseValueList(dataXml) {
  const results = [];
  const re = /<value>([\s\S]*?)<\/value>/g;
  let m;
  while ((m = re.exec(dataXml)) !== null) {
    results.push(parseTypedValue(m[1].trim()));
  }
  return results;
}

// ============================
//  Socket management
// ============================

function connectToTM() {
  console.log(`[XMLRPC] Connecting to TMR Dedicated at ${TM_HOST}:${TM_PORT}...`);
  xmlrpcSocket = new net.Socket();
  receiveBuffer = Buffer.alloc(0);

  xmlrpcSocket.connect(TM_PORT, TM_HOST, () => {
    console.log('[XMLRPC] TCP connected — waiting for GBX handshake...');
  });

  xmlrpcSocket.on('data', chunk => {
    receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
    processReceiveBuffer();
  });

  xmlrpcSocket.on('error', err => {
    console.error('[XMLRPC] Socket error:', err.message);
    socketReady = false;
    rejectAllPending('Socket error: ' + err.message);
    scheduleReconnect();
  });

  xmlrpcSocket.on('close', () => {
    console.warn('[XMLRPC] Connection closed. Reconnecting in 5s...');
    socketReady = false;
    rejectAllPending('Connection closed');
    scheduleReconnect();
  });
}

function rejectAllPending(reason) {
  Object.values(pendingCalls).forEach(c => c.reject(new Error(reason)));
  pendingCalls = {};
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToTM();
  }, 5000);
}

// GBXRemote2 packet framing: 4-byte length (LE) + 4-byte handle (LE) + XML body
function processReceiveBuffer() {
  while (receiveBuffer.length >= 8) {
    const bodyLen = receiveBuffer.readUInt32LE(0);
    const handle  = receiveBuffer.readUInt32LE(4);
    if (receiveBuffer.length < 8 + bodyLen) break; // not enough data yet

    const xmlBody = receiveBuffer.slice(8, 8 + bodyLen).toString('utf8');
    receiveBuffer = receiveBuffer.slice(8 + bodyLen);

    // The first packet is the GBX handshake greeting
    if (!socketReady && xmlBody.includes('GBXRemote')) {
      console.log('[XMLRPC] Handshake received:', xmlBody.trim());
      socketReady = true;
      authenticate();
      return;
    }

    // Callback (handle >= 0x80000000) vs response
    if (handle >= 0x80000000) {
      const pending = pendingCalls[handle];
      if (pending) {
        delete pendingCalls[handle];
        try {
          pending.resolve(parseXmlResponse(xmlBody));
        } catch(e) {
          pending.reject(e);
        }
      }
    } else {
      // Server-side callback (map change, player join, etc.) — ignore for now
      // console.log('[CB]', xmlBody.slice(0,120));
    }
  }
}

function call(method, ...params) {
  return new Promise((resolve, reject) => {
    if (!socketReady) {
      return reject(new Error('Not connected to TMR Server'));
    }
    const id = callIdCounter++;
    pendingCalls[id] = { resolve, reject };
    const pkt = buildPacket(method, params);
    // Patch handle into packet (already written in buildPacket but we need the real id)
    pkt.writeUInt32LE(id, 4);
    xmlrpcSocket.write(pkt);
    // Timeout after 8s
    setTimeout(() => {
      if (pendingCalls[id]) {
        delete pendingCalls[id];
        reject(new Error('XMLRPC call timed out: ' + method));
      }
    }, 8000);
  });
}

async function authenticate() {
  try {
    console.log('[AUTH] Authenticating...');
    await call('Authenticate', TM_LOGIN, TM_PASS);
    console.log('[AUTH] OK — bridge ready!');
    await call('EnableCallbacks', true);
    // Get server name
    try {
      const info = await call('GetServerOptions', 0);
      serverName = info.Name || serverName;
      console.log('[INFO] Server name:', serverName);
    } catch(e) { /* optional */ }
  } catch(e) {
    console.error('[AUTH] Failed:', e.message);
  }
}

// ============================
//  REST API Handlers
// ============================

async function apiGetStatus(res) {
  if (!socketReady) return apiError(res, 'Not connected to TMR Server');
  try {
    const [info, players] = await Promise.all([
      call('GetCurrentMapInfo'),
      call('GetPlayerList', 100, 0),
    ]);
    const serverOptions = await call('GetServerOptions', 0).catch(()=>({}));
    sendJson(res, {
      ok: true,
      connected: true,
      serverName: serverOptions.Name || serverName,
      map: {
        name:   info.Name        || info.UId || 'Unknown',
        author: info.Author      || 'Unknown',
        env:    info.Environnement || 'Stadium',
        uid:    info.UId         || '',
      },
      playerCount: players.length,
      maxPlayers: serverOptions.CurrentMaxPlayers || 32,
    });
  } catch(e) {
    apiError(res, e.message);
  }
}

async function apiGetPlayers(res) {
  if (!socketReady) return apiError(res, 'Not connected');
  try {
    const players = await call('GetPlayerList', 100, 0);
    const detailed = await Promise.all(
      players.map(p => call('GetDetailedPlayerInfo', p.Login).catch(() => p))
    );
    sendJson(res, {
      ok: true,
      players: detailed.map(p => ({
        login:     p.Login        || '',
        nickname:  stripStyles(p.NickName || p.Login || ''),
        teamId:    p.TeamId       || 0,
        spectator: p.IsSpectator  || false,
        ping:      p.Ping         || 0,
        zone:      p.Path         || 'World',
        ladderRank: p.LadderRanking || 0,
        ipAddress: p.IPAddress    || '',
        playerId:  p.PlayerId     || 0,
      }))
    });
  } catch(e) {
    apiError(res, e.message);
  }
}

async function apiGetMaps(res) {
  if (!socketReady) return apiError(res, 'Not connected');
  try {
    const maps = await call('GetMapList', 100, 0);
    const current = await call('GetCurrentMapInfo');
    sendJson(res, {
      ok: true,
      currentUid: current.UId || '',
      maps: maps.map(m => ({
        name:   m.Name        || 'Unknown',
        uid:    m.UId         || '',
        author: m.Author      || 'Unknown',
        env:    m.Environnement|| 'Stadium',
        mood:   m.Mood        || '',
        goldTime:   m.GoldTime   || 0,
        authorTime: m.AuthorTime || 0,
        nbCheckpoints: m.NbCheckpoints || 0,
        nbLaps:        m.NbLaps        || 0,
        fileName: m.FileName || '',
      }))
    });
  } catch(e) {
    apiError(res, e.message);
  }
}

async function apiNextMap(res) {
  if (!socketReady) return apiError(res, 'Not connected');
  try {
    await call('NextMap');
    sendJson(res, { ok: true, msg: 'Switched to next map' });
  } catch(e) { apiError(res, e.message); }
}

async function apiRestartMap(res) {
  if (!socketReady) return apiError(res, 'Not connected');
  try {
    await call('RestartMap');
    sendJson(res, { ok: true, msg: 'Map restarted' });
  } catch(e) { apiError(res, e.message); }
}

async function apiKickPlayer(res, body) {
  if (!socketReady) return apiError(res, 'Not connected');
  const { login, reason } = body;
  if (!login) return apiError(res, 'Missing login');
  try {
    await call('Kick', login, reason || 'Kicked by admin');
    sendJson(res, { ok: true, msg: `${login} kicked` });
  } catch(e) { apiError(res, e.message); }
}

async function apiBanPlayer(res, body) {
  if (!socketReady) return apiError(res, 'Not connected');
  const { login, reason } = body;
  if (!login) return apiError(res, 'Missing login');
  try {
    await call('Ban', login, reason || 'Banned by admin');
    sendJson(res, { ok: true, msg: `${login} banned` });
  } catch(e) { apiError(res, e.message); }
}

async function apiUnbanPlayer(res, body) {
  if (!socketReady) return apiError(res, 'Not connected');
  const { login } = body;
  if (!login) return apiError(res, 'Missing login');
  try {
    await call('UnBan', login);
    sendJson(res, { ok: true, msg: `${login} unbanned` });
  } catch(e) { apiError(res, e.message); }
}

async function apiChat(res, body) {
  if (!socketReady) return apiError(res, 'Not connected');
  const { message } = body;
  if (!message) return apiError(res, 'Missing message');
  try {
    await call('ChatSendServerMessage', message);
    sendJson(res, { ok: true, msg: 'Message sent' });
  } catch(e) { apiError(res, e.message); }
}

async function apiJumpToMap(res, body) {
  if (!socketReady) return apiError(res, 'Not connected');
  const { fileName } = body;
  if (!fileName) return apiError(res, 'Missing fileName');
  try {
    await call('JumpToMapIdent', fileName);
    sendJson(res, { ok: true, msg: `Jumped to ${fileName}` });
  } catch(e) {
    // Try by filename if ident fails
    try {
      await call('ChooseNextMap', fileName);
      await call('NextMap');
      sendJson(res, { ok: true, msg: `Jumped to ${fileName}` });
    } catch(e2) { apiError(res, e2.message); }
  }
}

async function apiGetServerOptions(res) {
  if (!socketReady) return apiError(res, 'Not connected');
  try {
    const opts = await call('GetServerOptions', 0);
    sendJson(res, { ok: true, options: opts });
  } catch(e) { apiError(res, e.message); }
}

async function apiSetServerOptions(res, body) {
  if (!socketReady) return apiError(res, 'Not connected');
  try {
    await call('SetServerOptions', body);
    sendJson(res, { ok: true, msg: 'Options updated' });
  } catch(e) { apiError(res, e.message); }
}

async function apiRcon(res, body) {
  if (!socketReady) return apiError(res, 'Not connected');
  const { method, params } = body;
  if (!method) return apiError(res, 'Missing method');
  try {
    const result = await call(method, ...(params || []));
    sendJson(res, { ok: true, result });
  } catch(e) { apiError(res, e.message); }
}

// ============================
//  Helpers
// ============================

function stripStyles(nick) {
  // Remove TM style codes like $fff, $i, $s, $l, etc.
  return nick.replace(/\$[0-9a-fA-F]{3}/g,'')
             .replace(/\$[iIsSzZnNtToOlLgGaAwW!]/g,'')
             .replace(/\$\$/g,'$')
             .trim();
}

function sendJson(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function apiError(res, msg) {
  const body = JSON.stringify({ ok: false, error: msg });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ============================
//  Serve static files
// ============================
const MIME = {
  '.html':'text/html','.js':'application/javascript',
  '.css':'text/css','.json':'application/json',
  '.png':'image/png','.ico':'image/x-icon',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
    } else {
      res.writeHead(200, {'Content-Type': mime});
      res.end(data);
    }
  });
}

// ============================
//  HTTP Server
// ============================
const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (pathname === '/api/status'          && req.method === 'GET')  return apiGetStatus(res);
    if (pathname === '/api/players'         && req.method === 'GET')  return apiGetPlayers(res);
    if (pathname === '/api/maps'            && req.method === 'GET')  return apiGetMaps(res);
    if (pathname === '/api/next-map'        && req.method === 'POST') return apiNextMap(res);
    if (pathname === '/api/restart-map'     && req.method === 'POST') return apiRestartMap(res);
    if (pathname === '/api/kick'            && req.method === 'POST') return apiKickPlayer(res, body);
    if (pathname === '/api/ban'             && req.method === 'POST') return apiBanPlayer(res, body);
    if (pathname === '/api/unban'           && req.method === 'POST') return apiUnbanPlayer(res, body);
    if (pathname === '/api/chat'            && req.method === 'POST') return apiChat(res, body);
    if (pathname === '/api/jump-map'        && req.method === 'POST') return apiJumpToMap(res, body);
    if (pathname === '/api/server-options'  && req.method === 'GET')  return apiGetServerOptions(res);
    if (pathname === '/api/server-options'  && req.method === 'POST') return apiSetServerOptions(res, body);
    if (pathname === '/api/rcon'            && req.method === 'POST') return apiRcon(res, body);

    if (pathname === '/api/ping') {
      return sendJson(res, { ok: true, connected: socketReady, serverName });
    }

    res.writeHead(404); return res.end('Unknown API route');
  }

  // Serve HTML panel files from same directory
  let filePath = path.join(__dirname, pathname === '/' ? 'mania-zones-admin.html' : pathname);
  // Security: only allow files in same dir
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  serveFile(res, filePath);
});

server.listen(BRIDGE_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║     Mania Zones Admin Bridge — Running!               ║');
  console.log('╠═══════════════════════════════════════════════════════╣');
  console.log(`║  Open browser:  http://localhost:${BRIDGE_PORT}/                ║`);
  console.log(`║  TM Server:     ${TM_HOST}:${TM_PORT}                          ║`);
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  connectToTM();
});

process.on('uncaughtException', err => {
  console.error('[FATAL]', err.message);
});
