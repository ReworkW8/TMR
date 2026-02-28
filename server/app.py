"""
TrackMania Rework — Community Master Server
Protocol reverse-engineered from TmRework.exe (MD5: 440f9866db99ac7da86a1aec284f235b)
Deployment: Railway, Render, VPS, local
"""

import json, uuid, hashlib, os, re
from flask import Flask, request, Response, jsonify

app  = Flask(__name__)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cfg(name):
    with open(os.path.join(ROOT, 'config', name), encoding='utf-8') as f:
        return json.load(f)


def save_cfg(name, data):
    with open(os.path.join(ROOT, 'config', name), 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


SESSIONS = {}   # in-memory — reset on restart


# ── XML-RPC helpers ────────────────────────────────────────────────────────────

def xml_resp(body):
    return Response(
        '<?xml version="1.0" encoding="UTF-8"?>\r\n'
        '<methodResponse>\r\n<params>\r\n<param>\r\n'
        + body +
        '\r\n</param>\r\n</params>\r\n</methodResponse>',
        content_type='text/xml; charset=UTF-8')


def xml_err(code, msg):
    return Response(
        '<?xml version="1.0" encoding="UTF-8"?>\r\n'
        '<methodResponse>\r\n<fault>\r\n<value><struct>\r\n'
        f'<member><n>faultCode</n><value><int>{code}</int></value></member>\r\n'
        f'<member><n>faultString</n><value><string>{esc(msg)}</string></value></member>\r\n'
        '</struct></value>\r\n</fault>\r\n</methodResponse>',
        content_type='text/xml; charset=UTF-8')


def esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def xs(s):       return f'<value><string>{esc(s)}</string></value>'
def xi(n):       return f'<value><int>{int(n)}</int></value>'
def xb(b):       return f'<value><boolean>{"1" if b else "0"}</boolean></value>'
def xarr(items): return f'<value><array><data>{"".join(items)}</data></array></value>'


def xstruct(d):
    return (
        '<value><struct>'
        + ''.join(f'<member><n>{k}</n>{v}</member>' for k, v in d.items())
        + '</struct></value>'
    )


def parse_rpc(raw):
    m = re.search(r'<methodName>(.*?)</methodName>', raw, re.S)
    method = m.group(1).strip() if m else ''
    params = [_val(pm.group(1).strip()) for pm in re.finditer(r'<param>(.*?)</param>', raw, re.S)]
    return method, params


def _val(xml):
    xml = xml.strip()
    if not xml.startswith('<value>'):
        return xml
    inner = re.sub(r'^<value>(.*)</value>$', r'\1', xml, flags=re.S).strip()
    if inner.startswith('<string>'):
        return re.sub(r'</?string>', '', inner)
    if inner.startswith('<int>') or inner.startswith('<i4>'):
        return int(re.sub(r'</?(?:int|i4)>', '', inner))
    if inner.startswith('<boolean>'):
        return re.sub(r'</?boolean>', '', inner) == '1'
    if inner.startswith('<struct>'):
        r = {}
        for mm in re.finditer(r'<member><n>(.*?)</n>(.*?)</member>', inner, re.S):
            r[mm.group(1)] = _val(mm.group(2).strip())
        return r
    if inner.startswith('<array>'):
        r = []
        dm = re.search(r'<data>(.*?)</data>', inner, re.S)
        if dm:
            for mm in re.finditer(r'(<value>.*?</value>)', dm.group(1), re.S):
                r.append(_val(mm.group(1)))
        return r
    return inner


def find_user(login, password=None):
    for u in cfg('users.json').get('users', []):
        if u['login'].lower() == login.lower():
            if password is None:
                return u
            pw = u['password']
            if pw == password or pw == hashlib.sha256(password.encode()).hexdigest():
                return u
    return None


# ── XML-RPC endpoint ───────────────────────────────────────────────────────────

@app.route('/request.php', methods=['POST', 'GET'])
def rpc():
    method, params = parse_rpc(request.data.decode('utf-8', 'replace'))
    settings = cfg('settings.json')
    app.logger.info(f'[RPC] {method}')

    if method == 'TestInternet':
        return xml_resp(xs('OK'))

    elif method in ('GetMasterServers', 'Searchservers'):
        items = []
        for s in cfg('servers.json').get('servers', []):
            items.append(xstruct({
                'ServerAddress':        xs(s.get('address', '127.0.0.1')),
                'ServerPort':           xi(s.get('port', 2350)),
                'ServerName':           xs(s.get('name', 'TM Server')),
                'NbPlayers':            xi(s.get('nb_players', 0)),
                'MaxPlayers':           xi(s.get('max_players', 16)),
                'ServerLogin':          xs(s.get('login', '')),
                'Comment':              xs(s.get('comment', '')),
                'IsPasswordProtected':  xb(bool(s.get('password', ''))),
                'LadderServerLimitMin': xi(0),
                'LadderServerLimitMax': xi(50000),
            }))
        return xml_resp(xarr(items))

    elif method == 'Searchleagues':
        items = []
        for z in settings.get('zones', []):
            items.append(xstruct({
                'ZoneId':             xi(z.get('id', 1)),
                'ZoneName':           xs(z.get('name', 'World')),
                'ZoneGenealogy':      xs(z.get('genealogy', 'World')),
                'OnlinePlayersCount': xi(len(SESSIONS)),
                'OnlineHostsCount':   xi(len(cfg('servers.json').get('servers', [])))
            }))
        return xml_resp(xarr(items))

    elif method == 'Searchbuddies':
        return xml_resp(xarr([]))

    elif method == 'ValidatePlayer':
        p = params[0] if params and isinstance(params[0], dict) else {}
        user = find_user(p.get('Login', ''), p.get('Password', ''))
        if user:
            sid = str(uuid.uuid4())
            SESSIONS[sid] = user
            app.logger.info(f'[AUTH] OK: {user["login"]}')
            return xml_resp(xstruct({
                'SessionId': xs(sid),
                'Login':     xs(user['login']),
                'NickName':  xs(user.get('nickname', user['login'])),
                'Zone':      xs(user.get('zone', 'World')),
                'Coppers':   xi(user.get('coppers', 999999)),
                'Validated': xb(True),
            }))
        app.logger.info(f'[AUTH] FAIL: {p.get("Login", "")}')
        return xml_resp(xb(False))

    elif method == 'RegisterAccount':
        p = params[0] if params and isinstance(params[0], dict) else {}
        login    = p.get('Login', '').strip()
        password = p.get('Password', '').strip()
        nickname = p.get('NickName', login).strip()
        if not login or not password:
            return xml_err(1, 'Login and Password required')
        if find_user(login):
            return xml_err(2, 'Login already taken')
        data = cfg('users.json')
        data.setdefault('users', []).append({
            'login': login, 'password': password,
            'nickname': nickname, 'zone': 'World', 'coppers': 999999
        })
        save_cfg('users.json', data)
        return xml_resp(xb(True))

    elif method == 'GetOnlineStats':
        login = params[0] if params and isinstance(params[0], str) else ''
        user  = find_user(login) if login else None
        return xml_resp(xstruct({
            'OnlineHostsCount':   xi(len(cfg('servers.json').get('servers', []))),
            'OnlinePlayersCount': xi(len(SESSIONS)),
            'Coppers':            xi(user.get('coppers', 999999) if user else 999999),
            'LadderPoints':       xi(0),
            'LadderRank':         xi(0),
        }))

    elif method == 'GetOnlineNews':
        items = [
            xstruct({
                'Id':      xi(n.get('id', 1)),
                'Title':   xs(n.get('title', '')),
                'Message': xs(n.get('message', '')),
                'Login':   xs(n.get('login', 'server'))
            })
            for n in settings.get('news', [])
        ]
        return xml_resp(xarr(items))

    elif method in ('GetOnlineEvents', 'GetOnlineNewsReplies'):
        return xml_resp(xarr([]))

    elif method == 'SendOnlineNewsReply':
        return xml_resp(xb(True))

    elif method == 'GetPlayerInfos':
        login = params[0] if params and isinstance(params[0], str) else ''
        user  = find_user(login)
        if user:
            return xml_resp(xstruct({
                'Login':    xs(user['login']),
                'NickName': xs(user.get('nickname', login)),
                'Zone':     xs(user.get('zone', 'World')),
                'Coppers':  xi(user.get('coppers', 999999))
            }))
        return xml_err(404, 'Player not found')

    elif method == 'CreateCoppersTransaction':
        return xml_resp(xs(str(uuid.uuid4())))

    elif method in ('IsCoppersTransactionPaid', 'PayCoppersTransaction',
                    'RemoveCoppersTransaction', 'SpendCoppers'):
        return xml_resp(xb(True))

    elif method == 'ChangeMasterServerAddress':
        return xml_resp(xb(True))

    else:
        app.logger.info(f'[UNHANDLED] {method}')
        return xml_resp(xi(0))


# ── Ad-server stubs ────────────────────────────────────────────────────────────
@app.route('/ad_init.php',    methods=['GET', 'POST'])
@app.route('/ad_report.php',  methods=['GET', 'POST'])
@app.route('/adsrv/<path:p>',  methods=['GET', 'POST'])
@app.route('/impsrv/<path:p>', methods=['GET', 'POST'])
def stub(**kw):
    return Response('OK', status=200)


# ── Status + Admin ─────────────────────────────────────────────────────────────
@app.route('/')
def status():
    return jsonify({
        'status':   'running',
        'players':  len(cfg('users.json').get('users', [])),
        'servers':  len(cfg('servers.json').get('servers', [])),
        'sessions': len(SESSIONS)
    })


@app.route('/admin/users')
def admin_users():
    return jsonify([
        {'login': u['login'], 'nickname': u.get('nickname', ''), 'zone': u.get('zone', '')}
        for u in cfg('users.json').get('users', [])
    ])


@app.route('/admin/sessions')
def admin_sessions():
    return jsonify([
        {'login': s['login'], 'nickname': s.get('nickname', '')}
        for s in SESSIONS.values()
    ])


if __name__ == '__main__':
    # Railway / Render set PORT automatically as an environment variable
    port = int(os.environ.get('PORT', cfg('settings.json').get('port', 80)))
    host = os.environ.get('HOST', '0.0.0.0')
    app.run(host=host, port=port)
