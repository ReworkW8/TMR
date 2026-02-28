
'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const PORT           = 8080;
const DATA_DIR       = path.join(__dirname, 'data');
const ACCOUNTS_FILE  = path.join(DATA_DIR, 'accounts.json');
const SERVERS_FILE   = path.join(DATA_DIR, 'servers.json');

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/** Read whole request body as Buffer */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Super-minimal XML tag extractor  (no deps needed) */
function xmlGet(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}
function xmlGetAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
  const m  = xml.match(re);
  return m ? m[1] : null;
}

/** Wrap a payload in a standard XML response */
function xmlResp(inner) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<response>\n${inner}\n</response>`;
}

/** XML error response */
function xmlError(code, msg) {
  return xmlResp(`  <error code="${code}">${escXml(msg)}</error>`);
}

/** Escape XML special chars */
function escXml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

/** Send an HTTP response */
function send(res, status, body, ct = 'text/xml; charset=utf-8') {
  const buf = Buffer.from(body, 'utf-8');
  res.writeHead(status, {
    'Content-Type'   : ct,
    'Content-Length' : buf.length,
    'Cache-Control'  : 'no-cache',
    'Connection'     : 'close'
  });
  res.end(buf);
}

// ─────────────────────────────────────────────
//  PERSISTENCE  (flat JSON files)
// ─────────────────────────────────────────────

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (_) { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// accounts : { [login]: { password, nickname, nation, coppers, maniacode, buddies, avatar_name, avatar_url, avatar_checksum } }
let accounts = loadJSON(ACCOUNTS_FILE, {});

// servers registered by dedicated servers
let servers  = loadJSON(SERVERS_FILE,  []);

function saveAccounts() { saveJSON(ACCOUNTS_FILE, accounts); }
function saveServers()  { saveJSON(SERVERS_FILE,  servers);  }

// ─────────────────────────────────────────────
//  ZONES  (loaded from data/zones.xml)
// ─────────────────────────────────────────────

let zonesXmlCache = null;
function getZonesXml() {
  if (!zonesXmlCache) {
    const f = path.join(DATA_DIR, 'zones.xml');
    let raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : buildDefaultZonesXml();
    // Strip XML declaration and comments before embedding in parent response
    raw = raw.replace(/<\?xml[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
    zonesXmlCache = raw;
  }
  return zonesXmlCache;
}

// ─────────────────────────────────────────────
//  AUTO-REGISTER  (create account on first login)
// ─────────────────────────────────────────────

function getOrCreateAccount(login) {
  if (!accounts[login]) {
    accounts[login] = {
      password       : '',          // will be set on first authentication
      nickname       : login,
      nation         : 'World|Europe',
      coppers        : 10000,
      maniacode      : generateManiaCode(),
      buddies        : [],
      avatar_name    : '',
      avatar_url     : '',
      avatar_checksum: ''
    };
    saveAccounts();
  }
  return accounts[login];
}

function generateManiaCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─────────────────────────────────────────────
//  ACTION HANDLERS
// ─────────────────────────────────────────────

const handlers = {};

/** Authenticate a player */
handlers['authenticate'] = handlers['login'] = handlers['validate'] = function(xml, params) {
  const login    = params.login    || xmlGet(xml, 'login')    || '';
  const password = params.password || xmlGet(xml, 'password') || '';
  const nickname = params.nickname || xmlGet(xml, 'nickname') || login;

  if (!login) return xmlError(1, 'Missing login');

  const acc = getOrCreateAccount(login);

  // First login or password matches (we store plain; game may hash - accept anything for private server)
  if (!acc.password) {
    acc.password = password;
    acc.nickname = nickname || acc.nickname;
    saveAccounts();
  }

  // Accept if password matches OR if server is in open mode (empty stored password)
  if (acc.password && acc.password !== password) {
    return xmlResp(`  <faultylogin>1</faultylogin>\n  <error code="2">Invalid password</error>`);
  }

  return xmlResp(`
  <valid>1</valid>
  <login>${escXml(login)}</login>
  <nickname>${escXml(acc.nickname)}</nickname>
  <nation>${escXml(acc.nation)}</nation>
  <coppers>${acc.coppers}</coppers>
  <maniacode>${escXml(acc.maniacode)}</maniacode>
  <ladderrank>0</ladderrank>
  <avatar_name>${escXml(acc.avatar_name)}</avatar_name>
  <avatar_url>${escXml(acc.avatar_url)}</avatar_url>
  <avatar_checksum>${escXml(acc.avatar_checksum)}</avatar_checksum>
`);
};

/** Validate / check login (used by dedicated server) */
handlers['checklogin'] = handlers['validate_login'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  if (!login) return xmlError(1, 'Missing login');
  const acc = accounts[login];
  if (!acc) return xmlResp(`  <valid>0</valid>\n  <faultylogin>1</faultylogin>`);
  return xmlResp(`  <valid>1</valid>\n  <login>${escXml(login)}</login>\n  <nickname>${escXml(acc.nickname)}</nickname>`);
};

/** Get zone list */
handlers['get_zones'] = handlers['getzones'] = handlers['zones'] = function() {
  return xmlResp(`\n${getZonesXml()}\n`);
};

/** Get nation / zone for a login */
handlers['get_nation'] = handlers['getnation'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  const acc   = accounts[login] || { nation: 'World' };
  return xmlResp(`  <nation>${escXml(acc.nation)}</nation>`);
};

/** Set/update nation for a login */
handlers['set_nation'] = function(xml, params) {
  const login  = params.login  || xmlGet(xml, 'login')  || '';
  const nation = params.nation || xmlGet(xml, 'nation') || 'World';
  if (!login || !accounts[login]) return xmlError(1, 'Unknown login');
  accounts[login].nation = nation;
  saveAccounts();
  return xmlResp(`  <valid>1</valid>`);
};

/** Get server list */
handlers['get_servers'] = handlers['servers'] = handlers['requestservers'] = function(xml, params) {
  const count = parseInt(params.count || xmlGet(xml, 'count') || '50', 10);
  const active = servers.filter(s => {
    // Remove stale entries (last heartbeat > 5 min ago)
    return (Date.now() - (s.lastBeat || 0)) < 5 * 60 * 1000;
  }).slice(0, count);

  const items = active.map(s => `
    <server>
      <login>${escXml(s.login)}</login>
      <name>${escXml(s.name)}</name>
      <ip>${escXml(s.ip)}</ip>
      <port>${s.port || 2350}</port>
      <nb_players>${s.nb_players || 0}</nb_players>
      <max_players>${s.max_players || 32}</max_players>
      <nb_spectators>${s.nb_spectators || 0}</nb_spectators>
      <max_spectators>${s.max_spectators || 32}</max_spectators>
      <game_mode>${escXml(s.game_mode || 'TimeAttack')}</game_mode>
      <nation>${escXml(s.nation || 'World')}</nation>
      <ladder_mode>${s.ladder_mode || 0}</ladder_mode>
      <password>${s.password ? 1 : 0}</password>
      <comment>${escXml(s.comment || '')}</comment>
    </server>`).join('\n');

  return xmlResp(`  <servers count="${active.length}">${items}\n  </servers>`);
};

/** Suggest servers (top hosts) */
handlers['tophosts'] = handlers['requestsuggested'] = handlers['requestsuggestedservers'] = function() {
  return handlers['get_servers']('', {count:'10'});
};

/** Register / heartbeat a dedicated server */
handlers['register_server'] = handlers['server_heartbeat'] = handlers['heartbeat'] = function(xml, params) {
  const login       = params.login       || xmlGet(xml, 'login')       || '';
  const name        = params.name        || xmlGet(xml, 'name')        || login;
  const ip          = params.ip          || xmlGet(xml, 'ip')          || '';
  const port        = parseInt(params.port || xmlGet(xml, 'port') || '2350', 10);
  const nb_players  = parseInt(params.nb_players  || xmlGet(xml, 'nb_players')  || '0',  10);
  const max_players = parseInt(params.max_players || xmlGet(xml, 'max_players') || '32', 10);
  const game_mode   = params.game_mode  || xmlGet(xml, 'game_mode')  || 'TimeAttack';
  const nation      = params.nation     || xmlGet(xml, 'nation')     || 'World';
  const password    = params.password   || xmlGet(xml, 'password')   || '';
  const comment     = params.comment    || xmlGet(xml, 'comment')    || '';

  if (!login) return xmlError(1, 'Missing login');

  const idx = servers.findIndex(s => s.login === login);
  const entry = { login, name, ip, port, nb_players, max_players, game_mode, nation, password, comment, lastBeat: Date.now() };

  if (idx >= 0) servers[idx] = entry;
  else          servers.push(entry);

  // Clean stale servers
  servers = servers.filter(s => (Date.now() - (s.lastBeat || 0)) < 5 * 60 * 1000);
  saveServers();

  return xmlResp(`  <valid>1</valid>`);
};

/** Unregister a dedicated server */
handlers['unregister_server'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  servers = servers.filter(s => s.login !== login);
  saveServers();
  return xmlResp(`  <valid>1</valid>`);
};

/** Get / set Coppers (virtual currency) */
handlers['get_coppers'] = handlers['getcoppers'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  const acc   = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  return xmlResp(`  <coppers>${acc.coppers}</coppers>`);
};

handlers['add_coppers'] = function(xml, params) {
  const login  = params.login  || xmlGet(xml, 'login')  || '';
  const amount = parseInt(params.amount || xmlGet(xml, 'amount') || '0', 10);
  const acc    = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  acc.coppers = Math.max(0, acc.coppers + amount);
  saveAccounts();
  return xmlResp(`  <valid>1</valid>\n  <coppers>${acc.coppers}</coppers>`);
};

handlers['pay_coppers'] = handlers['buy'] = function(xml, params) {
  const login  = params.login  || xmlGet(xml, 'login')  || '';
  const amount = parseInt(params.amount || xmlGet(xml, 'amount') || '0', 10);
  const acc    = accounts[login];
  if (!acc)              return xmlError(3, 'Unknown login');
  if (acc.coppers < amount) return xmlError(4, 'Not enough coppers');
  acc.coppers -= amount;
  saveAccounts();
  return xmlResp(`  <valid>1</valid>\n  <coppers>${acc.coppers}</coppers>`);
};

/** Buddy system */
handlers['add_buddy'] = function(xml, params) {
  const login       = params.login       || xmlGet(xml, 'login')       || '';
  const buddy_login = params.buddy_login || xmlGet(xml, 'buddy_login') || params.buddy || xmlGet(xml, 'buddy') || '';
  const acc = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  if (!acc.buddies.includes(buddy_login)) {
    acc.buddies.push(buddy_login);
    saveAccounts();
  }
  return xmlResp(`  <valid>1</valid>`);
};

handlers['remove_buddy'] = function(xml, params) {
  const login       = params.login       || xmlGet(xml, 'login')       || '';
  const buddy_login = params.buddy_login || xmlGet(xml, 'buddy_login') || params.buddy || xmlGet(xml, 'buddy') || '';
  const acc = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  acc.buddies = acc.buddies.filter(b => b !== buddy_login);
  saveAccounts();
  return xmlResp(`  <valid>1</valid>`);
};

handlers['get_buddies'] = handlers['buddies'] = handlers['requestbuddies'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  const acc   = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');

  const items = acc.buddies.map(b => {
    const ba = accounts[b] || { nickname: b, nation: 'World' };
    return `    <buddy>
      <login>${escXml(b)}</login>
      <nickname>${escXml(ba.nickname)}</nickname>
      <nation>${escXml(ba.nation)}</nation>
    </buddy>`;
  }).join('\n');

  return xmlResp(`  <buddies count="${acc.buddies.length}">\n${items}\n  </buddies>`);
};

/** ManiaCode (friend invite code) */
handlers['get_maniacode'] = handlers['maniacode'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  const acc   = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  return xmlResp(`  <maniacode>${escXml(acc.maniacode)}</maniacode>`);
};

handlers['use_maniacode'] = function(xml, params) {
  const code  = params.maniacode || xmlGet(xml, 'maniacode') || '';
  const login = params.login     || xmlGet(xml, 'login')     || '';
  // Find owner of this maniacode
  const owner = Object.keys(accounts).find(k => accounts[k].maniacode === code);
  if (!owner) return xmlError(5, 'Invalid ManiaCode');
  // Auto-add as buddy
  const acc = getOrCreateAccount(login);
  if (!acc.buddies.includes(owner)) { acc.buddies.push(owner); saveAccounts(); }
  return xmlResp(`  <valid>1</valid>\n  <owner_login>${escXml(owner)}</owner_login>`);
};

/** ManiaLink & ManiaZone */
handlers['get_manialinks'] = handlers['manialinks'] = handlers['requestmanialinks'] = function() {
  const linksFile = path.join(DATA_DIR, 'manialinks.xml');
  if (fs.existsSync(linksFile)) {
    return xmlResp(fs.readFileSync(linksFile, 'utf-8'));
  }
  return xmlResp(`
  <manialinks>
    <manialink id="home">
      <url>maniaplanet://home</url>
      <name>Home</name>
    </manialink>
  </manialinks>`);
};

handlers['get_maniazone'] = handlers['maniazone'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  const acc   = accounts[login] || { nation: 'World' };
  return xmlResp(`  <maniazone>${escXml(acc.nation)}</maniazone>`);
};

/** Profile */
handlers['get_profile'] = handlers['profile'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  const acc   = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  return xmlResp(`
  <profile>
    <login>${escXml(login)}</login>
    <nickname>${escXml(acc.nickname)}</nickname>
    <nation>${escXml(acc.nation)}</nation>
    <coppers>${acc.coppers}</coppers>
    <maniacode>${escXml(acc.maniacode)}</maniacode>
    <avatar_name>${escXml(acc.avatar_name)}</avatar_name>
    <avatar_url>${escXml(acc.avatar_url)}</avatar_url>
    <avatar_checksum>${escXml(acc.avatar_checksum)}</avatar_checksum>
  </profile>`);
};

handlers['update_profile'] = function(xml, params) {
  const login    = params.login    || xmlGet(xml, 'login')    || '';
  const nickname = params.nickname || xmlGet(xml, 'nickname') || '';
  const nation   = params.nation   || xmlGet(xml, 'nation')   || '';
  const acc = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  if (nickname) acc.nickname = nickname;
  if (nation)   acc.nation   = nation;
  saveAccounts();
  return xmlResp(`  <valid>1</valid>`);
};

/** Avatar */
handlers['set_avatar'] = function(xml, params) {
  const login    = params.login             || xmlGet(xml, 'login')          || '';
  const av_name  = params.avatar_name       || xmlGet(xml, 'avatar_name')    || '';
  const av_url   = params.avatar_url        || xmlGet(xml, 'avatar_url')     || '';
  const av_check = params.avatar_checksum   || xmlGet(xml, 'avatar_checksum')|| '';
  const acc = accounts[login];
  if (!acc) return xmlError(3, 'Unknown login');
  acc.avatar_name     = av_name;
  acc.avatar_url      = av_url;
  acc.avatar_checksum = av_check;
  saveAccounts();
  return xmlResp(`  <valid>1</valid>`);
};

/** Ladder / ranking (simple) */
handlers['get_ladder'] = handlers['ladder'] = handlers['getladder'] = function(xml, params) {
  const login = params.login || xmlGet(xml, 'login') || '';
  // Build simple sorted ranking by (future) ladder score field
  const all = Object.keys(accounts).map((l,i) => ({login: l, rank: i+1, score: 0}));
  const mine = all.find(x => x.login === login) || {login, rank: 0, score: 0};
  return xmlResp(`
  <ladder>
    <login>${escXml(login)}</login>
    <rank>${mine.rank}</rank>
    <score>${mine.score}</score>
    <total_players>${all.length}</total_players>
  </ladder>`);
};

/** Championships & Leagues */
handlers['get_championships'] = handlers['championships'] = handlers['requestchampionships'] = function() {
  const f = path.join(DATA_DIR, 'championships.xml');
  if (fs.existsSync(f)) return xmlResp(fs.readFileSync(f, 'utf-8'));
  return xmlResp(`  <championships count="0"></championships>`);
};

handlers['get_leagues'] = handlers['leagues'] = handlers['requestleagues'] = function() {
  const f = path.join(DATA_DIR, 'leagues.xml');
  if (fs.existsSync(f)) return xmlResp(fs.readFileSync(f, 'utf-8'));
  return xmlResp(`  <leagues count="0"></leagues>`);
};

/** GetMasterServers - returns this server as the only master */
handlers['getmasterservers'] = handlers['get_masterservers'] = handlers['masterservers'] = function() {
  return `<?xml version="1.0" encoding="utf-8"?>
<masterservers>
  <masterserver>
    <url>http://localhost:8080/</url>
  </masterserver>
</masterservers>`;
};

/** Join server (returns connection info) */
handlers['join_server'] = function(xml, params) {
  const server_login = params.server_login || xmlGet(xml, 'server_login') || '';
  const s = servers.find(x => x.login === server_login);
  if (!s) return xmlError(6, 'Server not found');
  return xmlResp(`
  <valid>1</valid>
  <ip>${escXml(s.ip)}</ip>
  <port>${s.port}</port>
  <password>${escXml(s.password || '')}</password>`);
};

/** Generic ping / ok */
handlers['ping'] = handlers['test'] = handlers['ok'] = function() {
  return xmlResp(`  <valid>1</valid>\n  <pong>1</pong>`);
};

// ─────────────────────────────────────────────
//  REQUEST ROUTER
// ─────────────────────────────────────────────

async function handleRequest(req, res) {
  const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname  = urlParsed.pathname.toLowerCase();

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // ── ad_init.php / ad_report.php  (suppress ads) ──
  if (pathname === '/ad_init.php' || pathname === '/ad_report.php') {
    return send(res, 200, '<?xml version="1.0" encoding="utf-8"?><response><valid>1</valid></response>');
  }

  // ── favicon.ico ──
  if (pathname === '/favicon.ico') {
    return send(res, 204, '', 'text/plain');
  }

  // ── Health check ──
  if (pathname === '/' || pathname === '/status') {
    return send(res, 200, JSON.stringify({
      status  : 'ok',
      server  : 'TrackMania United Master Server',
      accounts: Object.keys(accounts).length,
      servers : servers.filter(s => (Date.now()-(s.lastBeat||0)) < 300000).length
    }), 'application/json');
  }

  // ── request.php – main API endpoint ──
  if (pathname !== '/request.php') {
    return send(res, 404, xmlError(404, 'Not found'));
  }

  // Read body
  const body = await readBody(req);
  const bodyStr = body.toString('utf-8');

  // Parse: try XML first, then URL-encoded form, then URL query string
  let action = urlParsed.searchParams.get('action') || '';
  let params  = {};

  // URL-encoded body params
  if (!bodyStr.startsWith('<')) {
    bodyStr.split('&').forEach(pair => {
      const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g,' ')));
      if (k) params[k] = v || '';
    });
    action = action || params['action'] || '';
  } else {
    // XML body — extract action from element or attribute
    action = action || xmlGet(bodyStr, 'action') || xmlGetAttr(bodyStr, 'request', 'action') || '';
  }

  // Also try URL query params
  urlParsed.searchParams.forEach((v,k) => { params[k] = v; });
  if (!action && params['action']) action = params['action'];

  action = action.toLowerCase().replace(/[\s-]/g,'_');

  const handler = handlers[action];
  if (handler) {
    const result = handler(bodyStr, params);
    return send(res, 200, result);
  }

  // Unknown action — log and return generic ok so game doesn't break
  console.warn(`  [WARN] Unknown action: "${action}"`);
  return send(res, 200, xmlResp(`  <valid>1</valid>`));
}

// ─────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Unhandled error:', err);
    try { send(res, 500, xmlError(500, 'Internal server error')); } catch (_) {}
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  TrackMania United 2006 - Custom Master Server');
  console.log(`  Listening on http://0.0.0.0:${PORT}`);
  console.log('  Use TmRework.exe to connect (port 8080)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Accounts loaded : ${Object.keys(accounts).length}`);
  console.log(`  Data directory  : ${DATA_DIR}`);
  console.log('───────────────────────────────────────────────────');
});

// ─────────────────────────────────────────────
//  DEFAULT ZONES XML  (fallback if no file)
// ─────────────────────────────────────────────

function buildDefaultZonesXml() {
  return `<zones>
  <zone id="1" name="World" path="World">
    <zone id="2" name="Europe" path="World|Europe">
      <zone id="10" name="Germany"        path="World|Europe|Germany"/>
      <zone id="11" name="France"         path="World|Europe|France"/>
      <zone id="12" name="United Kingdom" path="World|Europe|United Kingdom"/>
      <zone id="13" name="Spain"          path="World|Europe|Spain"/>
      <zone id="14" name="Italy"          path="World|Europe|Italy"/>
      <zone id="15" name="Netherlands"    path="World|Europe|Netherlands"/>
      <zone id="16" name="Belgium"        path="World|Europe|Belgium"/>
      <zone id="17" name="Sweden"         path="World|Europe|Sweden"/>
      <zone id="18" name="Norway"         path="World|Europe|Norway"/>
      <zone id="19" name="Denmark"        path="World|Europe|Denmark"/>
      <zone id="20" name="Finland"        path="World|Europe|Finland"/>
      <zone id="21" name="Poland"         path="World|Europe|Poland"/>
      <zone id="22" name="Austria"        path="World|Europe|Austria"/>
      <zone id="23" name="Switzerland"    path="World|Europe|Switzerland"/>
      <zone id="24" name="Portugal"       path="World|Europe|Portugal"/>
      <zone id="25" name="Czech Republic" path="World|Europe|Czech Republic"/>
      <zone id="26" name="Hungary"        path="World|Europe|Hungary"/>
      <zone id="27" name="Romania"        path="World|Europe|Romania"/>
      <zone id="28" name="Russia"         path="World|Europe|Russia"/>
      <zone id="29" name="Ukraine"        path="World|Europe|Ukraine"/>
      <zone id="30" name="Slovakia"       path="World|Europe|Slovakia"/>
      <zone id="31" name="Croatia"        path="World|Europe|Croatia"/>
      <zone id="32" name="Serbia"         path="World|Europe|Serbia"/>
      <zone id="33" name="Greece"         path="World|Europe|Greece"/>
      <zone id="34" name="Bulgaria"       path="World|Europe|Bulgaria"/>
      <zone id="35" name="Turkey"         path="World|Europe|Turkey"/>
    </zone>
    <zone id="3" name="America" path="World|America">
      <zone id="50" name="United States"  path="World|America|United States"/>
      <zone id="51" name="Canada"         path="World|America|Canada"/>
      <zone id="52" name="Brazil"         path="World|America|Brazil"/>
      <zone id="53" name="Mexico"         path="World|America|Mexico"/>
      <zone id="54" name="Argentina"      path="World|America|Argentina"/>
      <zone id="55" name="Chile"          path="World|America|Chile"/>
      <zone id="56" name="Colombia"       path="World|America|Colombia"/>
      <zone id="57" name="Peru"           path="World|America|Peru"/>
      <zone id="58" name="Venezuela"      path="World|America|Venezuela"/>
    </zone>
    <zone id="4" name="Asia" path="World|Asia">
      <zone id="70" name="China"          path="World|Asia|China"/>
      <zone id="71" name="Japan"          path="World|Asia|Japan"/>
      <zone id="72" name="South Korea"    path="World|Asia|South Korea"/>
      <zone id="73" name="India"          path="World|Asia|India"/>
      <zone id="74" name="Taiwan"         path="World|Asia|Taiwan"/>
      <zone id="75" name="Singapore"      path="World|Asia|Singapore"/>
      <zone id="76" name="Indonesia"      path="World|Asia|Indonesia"/>
      <zone id="77" name="Malaysia"       path="World|Asia|Malaysia"/>
      <zone id="78" name="Thailand"       path="World|Asia|Thailand"/>
      <zone id="79" name="Vietnam"        path="World|Asia|Vietnam"/>
    </zone>
    <zone id="5" name="Oceania" path="World|Oceania">
      <zone id="90" name="Australia"      path="World|Oceania|Australia"/>
      <zone id="91" name="New Zealand"    path="World|Oceania|New Zealand"/>
    </zone>
    <zone id="6" name="Africa" path="World|Africa">
      <zone id="100" name="South Africa"  path="World|Africa|South Africa"/>
      <zone id="101" name="Egypt"         path="World|Africa|Egypt"/>
      <zone id="102" name="Morocco"       path="World|Africa|Morocco"/>
      <zone id="103" name="Nigeria"       path="World|Africa|Nigeria"/>
    </zone>
    <zone id="7" name="Middle East" path="World|Middle East">
      <zone id="110" name="Israel"        path="World|Middle East|Israel"/>
      <zone id="111" name="Saudi Arabia"  path="World|Middle East|Saudi Arabia"/>
      <zone id="112" name="UAE"           path="World|Middle East|UAE"/>
    </zone>
  </zone>
</zones>`;
}
