/**
 * Trackmania United 2006 – Community Master Server
 *
 * Pure Node.js HTTP server that speaks the original TMU XML-RPC protocol.
 * No framework. Minimal dependencies.
 *
 * Start:  bun run dev   (development, auto-reload)
 *         bun run start (production)
 */

import * as http from 'node:http';
import { config, log }              from './config';
import { parseCall, successResponse, faultResponse } from './xmlrpc';
import { dispatch, RpcError, METHODS }               from './handlers';
import { startTasks }                                from './tasks';
import { prisma }                                    from './db';

// ─── Request helpers ──────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function send(
  res:     http.ServerResponse,
  status:  number,
  body:    string,
  ct = 'text/xml; charset=utf-8',
): void {
  res.writeHead(status, {
    'Content-Type':   ct,
    'Content-Length': Buffer.byteLength(body),
    'Server':         'TMU-MasterServer/2.0',
    'Connection':     'close',
  });
  res.end(body);
}

// ─── XML-RPC handler ──────────────────────────────────────────────────────────

async function handleXmlRpc(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const ip   = clientIp(req);
  const body = await readBody(req);

  if (!body.trim()) {
    send(res, 200, faultResponse(400, 'Empty request body'));
    return;
  }

  const call = parseCall(body);
  if (!call) {
    log.warn(`[http] unparseable XML-RPC from ${ip}: ${body.slice(0, 120)}`);
    send(res, 200, faultResponse(400, 'Could not parse XML-RPC methodCall'));
    return;
  }

  try {
    const result = await dispatch(call.method, call.params, ip);
    send(res, 200, successResponse(result));
  } catch (err) {
    if (err instanceof RpcError) {
      log.debug(`[rpc] fault ${err.code} for ${call.method}: ${err.message}`);
      send(res, 200, faultResponse(err.code, err.message));
    } else {
      log.error(`[rpc] unhandled error in ${call.method}`, err);
      send(res, 200, faultResponse(500, 'Internal server error'));
    }
  }
}

// ─── HTTP request router ──────────────────────────────────────────────────────

const XMLRPC_PATHS = new Set(['/', '/xmlrpc', '/xmlrpc/', '/masterserver', '/api/xmlrpc']);

async function onRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url    = req.url ?? '/';
  const path   = url.split('?')[0].toLowerCase();
  const method = req.method?.toUpperCase() ?? 'GET';

  // ── XML-RPC endpoint ──────────────────────────────────────────────────────
  if (method === 'POST' && XMLRPC_PATHS.has(path)) {
    await handleXmlRpc(req, res);
    return;
  }

  // ── Capabilities probe (GET /) ─────────────────────────────────────────────
  if (method === 'GET' && path === '/') {
    const xml = successResponse({
      Server:   'TMU Master Server',
      Version:  '2.0.0',
      Protocol: 'XML-RPC',
      Methods:  METHODS,
    });
    send(res, 200, xml);
    return;
  }

  // ── Health check ──────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/health') {
    send(res, 200, '{"status":"ok"}', 'application/json');
    return;
  }

  // ── Anything else ─────────────────────────────────────────────────────────
  send(res, 404, faultResponse(404, 'Not found'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Ensure DB is reachable
  await prisma.$connect();
  log.info('[db] connected');

  // Start background tasks
  startTasks();

  // Create HTTP server
  const server = http.createServer(async (req, res) => {
    try {
      await onRequest(req, res);
    } catch (err) {
      log.error('[http] unhandled error', err);
      if (!res.headersSent) {
        send(res, 500, faultResponse(500, 'Internal server error'));
      }
    }
  });

  server.listen(config.port, () => {
    log.info(`[server] listening on port ${config.port}`);
    log.info(`[server] XML-RPC endpoint: POST http://0.0.0.0:${config.port}/`);
    log.info(`[server] health check:     GET  http://0.0.0.0:${config.port}/health`);
    log.info(`[server] redirect ${config.host} → this server to replace Nadeo`);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    log.info(`[server] ${signal} received, shutting down…`);
    server.close(async () => {
      await prisma.$disconnect();
      log.info('[server] shutdown complete');
      process.exit(0);
    });
    // Force exit after 10 s if connections linger
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException',  (e) => log.error('[server] uncaughtException', e));
  process.on('unhandledRejection', (r) => log.error('[server] unhandledRejection', r));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
