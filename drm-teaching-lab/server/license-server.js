'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const SCENARIOS = ['normal', 'wrong-key', 'unknown-kid', 'session-fail', 'offline'];

function b64urlFromHex(hex) {
  return Buffer.from(hex, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function maskKid(kid) {
  if (!kid || kid.length < 12) {
    return '<无效KID>';
  }
  return `${kid.slice(0, 8)}…${kid.slice(-4)}`;
}

function redactBody(body) {
  if (!body || !Array.isArray(body.kids)) {
    return '<非ClearKey请求体>';
  }
  return { kids: body.kids.map(maskKid), type: body.type };
}

class LicenseServer {
  constructor({ keyStorePath, contentRoot, port, host = '127.0.0.1' }) {
    this.keyStorePath = keyStorePath;
    this.contentRoot = contentRoot;
    this.port = port;
    this.host = host;
    this.scenario = 'normal';
    this.sessionCounter = 0;
    this.stats = { sessionsCreated: 0, sessionsRejected: 0, licensesIssued: 0, unknownKids: 0, wrongKeyDeliberate: 0 };
    this.server = null;
  }

  loadKeyStore() {
    this.keyStore = JSON.parse(fs.readFileSync(this.keyStorePath, 'utf8'));
    this.byKid = new Map();
    for (const c of this.keyStore.courses) {
      this.byKid.set(c.kid, c);
    }
  }

  log(level, event, detail) {
    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      scenario: this.scenario,
      ...detail,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  setScenario(name) {
    if (!SCENARIOS.includes(name)) {
      throw new Error(`未知场景: ${name}`);
    }
    this.scenario = name;
    this.log('info', 'scenario-change', { to: name });
  }

  handleLicense(req, res) {
    if (this.scenario === 'offline') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'license_unavailable', message: '许可端已断开（演练场景）' }));
      this.log('warn', 'license-offline', {});
      return;
    }
    if (this.scenario === 'session-fail') {
      this.stats.sessionsRejected += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_creation_failed', message: 'CDM 会话创建被许可端拒绝（演练场景）' }));
      this.log('error', 'session-creation-failed', {});
      return;
    }

    let body;
    try {
      body = JSON.parse(req.body);
      if (!body || typeof body !== 'object' || !Array.isArray(body.kids)) {
        throw new Error('missing kids array');
      }
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed_request' }));
      this.log('warn', 'malformed-request', {});
      return;
    }

    const sessionId = `s${(this.sessionCounter += 1).toString().padStart(5, '0')}`;
    this.stats.sessionsCreated += 1;
    this.log('info', 'session-created', { sessionId, request: redactBody(body) });

    if (!Array.isArray(body.kids) || body.kids.length === 0) {
      this.stats.sessionsRejected += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty_kids' }));
      this.log('warn', 'empty-kids', { sessionId });
      return;
    }

    const requestedHexKids = body.kids.map((k) => Buffer.from(k.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex'));
    const keys = [];
    for (const kidHex of requestedHexKids) {
      const course = this.byKid.get(kidHex);
      if (!course) {
        this.stats.unknownKids += 1;
        this.stats.sessionsRejected += 1;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_kid', message: `密钥标识 ${maskKid(kidHex)} 未在本地虚构课程库登记` }));
        this.log('warn', 'unknown-kid', { sessionId, kid: maskKid(kidHex) });
        return;
      }
      let keyHex = course.key;
      if (this.scenario === 'wrong-key') {
        keyHex = crypto.createHash('sha256').update(`wrong/${course.kid}`).digest('subarray', 0, 16).toString('hex');
        this.stats.wrongKeyDeliberate += 1;
      }
      keys.push({ kty: 'oct', kid: b64urlFromHex(kidHex), k: b64urlFromHex(keyHex) });
    }

    const license = { keys, type: body.type || 'temporary' };
    this.stats.licensesIssued += 1;
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-session-id': sessionId,
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(license));
    this.log('info', 'license-issued', {
      sessionId,
      kids: requestedHexKids.map(maskKid),
      keyMaterialReturned: false,
      note: '响应包含密钥但日志不记录其明文',
    });
  }

  serveStatic(req, res, pathname) {
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(this.contentRoot, safe);
    if (!filePath.startsWith(path.resolve(this.contentRoot))) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.mp4': 'video/mp4',
        '.m4s': 'video/iso.segment',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'accept-ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  start() {
    this.loadKeyStore();
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${this.host}:${this.port}`);
      const pathname = url.pathname;
      if (req.method === 'POST' && pathname === '/api/license') {
        req.body = '';
        req.on('data', (c) => { req.body += c; });
        req.on('end', () => this.handleLicense(req, res));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          scenario: this.scenario,
          scenarios: SCENARIOS,
          stats: this.stats,
          courses: this.keyStore.courses.map((c) => ({ courseId: c.courseId, title: c.title, kid: c.kid, scheme: c.scheme })),
        }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/scenario') {
        req.body = '';
        req.on('data', (c) => { req.body += c; });
        req.on('end', () => {
          try {
            const { scenario } = JSON.parse(req.body);
            this.setScenario(scenario);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, scenario: this.scenario }));
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(e.message) }));
          }
        });
        return;
      }
      if (req.method === 'GET') {
        const target = pathname === '/' ? '/player/index.html' : pathname;
        this.serveStatic(req, res, target);
        return;
      }
      res.writeHead(405);
      res.end('method not allowed');
    });
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        this.log('info', 'server-start', { host: this.host, port: this.port, keyStore: this.keyStorePath });
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = { LicenseServer, SCENARIOS, b64urlFromHex, maskKid };
