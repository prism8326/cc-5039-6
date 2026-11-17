'use strict';

const path = require('path');
const assert = require('assert');
const http = require('http');
const { LicenseServer, b64urlFromHex } = require('../server/license-server');

const root = path.resolve(__dirname, '..');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const server = new LicenseServer({
    keyStorePath: path.join(root, 'keys', 'courses.json'),
    contentRoot: root,
    port: 0,
  });
  const logs = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    logs.push(chunk.toString());
    return true;
  };
  await server.start();
  const port = server.server.address().port;
  process.stdout.write = origWrite;

  let failures = 0;
  const check = (name, fn) => Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((e) => { failures += 1; console.error(`  ✗ ${name}: ${e.message}`); });

  const keyStore = server.keyStore;
  const course = keyStore.courses[0];
  const kidB64 = b64urlFromHex(course.kid);

  console.log('许可服务测试');

  await check('正常场景返回 200 且 KID/KEY 匹配', async () => {
    server.setScenario('normal');
    const r = await request(port, 'POST', '/api/license', { kids: [kidB64], type: 'temporary' });
    assert.strictEqual(r.status, 200);
    const payload = JSON.parse(r.body);
    assert.strictEqual(payload.keys.length, 1);
    assert.strictEqual(payload.keys[0].kid, kidB64);
    assert.strictEqual(payload.keys[0].k, b64urlFromHex(course.key));
  });

  await check('错误密钥场景返回 200 但 KEY 与真实密钥不同', async () => {
    server.setScenario('wrong-key');
    const r = await request(port, 'POST', '/api/license', { kids: [kidB64], type: 'temporary' });
    assert.strictEqual(r.status, 200);
    const payload = JSON.parse(r.body);
    assert.notStrictEqual(payload.keys[0].k, b64urlFromHex(course.key));
  });

  await check('未知 KID 返回 404 unknown_kid', async () => {
    server.setScenario('normal');
    const unknown = b64urlFromHex('ff'.repeat(16));
    const r = await request(port, 'POST', '/api/license', { kids: [unknown], type: 'temporary' });
    assert.strictEqual(r.status, 404);
    assert.ok(JSON.parse(r.body).error === 'unknown_kid');
  });

  await check('会话创建失败场景返回 500 session_creation_failed', async () => {
    server.setScenario('session-fail');
    const r = await request(port, 'POST', '/api/license', { kids: [kidB64], type: 'temporary' });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(JSON.parse(r.body).error, 'session_creation_failed');
  });

  await check('许可端断开场景返回 503', async () => {
    server.setScenario('offline');
    const r = await request(port, 'POST', '/api/license', { kids: [kidB64], type: 'temporary' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(JSON.parse(r.body).error, 'license_unavailable');
  });

  await check('只服务本地虚构课程：状态接口不含 KEY 明文', async () => {
    server.setScenario('normal');
    const r = await request(port, 'GET', '/api/state');
    assert.strictEqual(r.status, 200);
    const payload = JSON.parse(r.body);
    for (const c of payload.courses) {
      assert.ok(!('key' in c), '状态接口泄露了 key 字段');
      assert.ok(c.kid && c.courseId);
    }
  });

  await check('普通日志不输出 KEY 明文（只出现脱敏 KID）', async () => {
    server.setScenario('normal');
    const localLogs = [];
    process.stdout.write = (chunk) => { localLogs.push(chunk.toString()); return true; };
    await request(port, 'POST', '/api/license', { kids: [kidB64], type: 'temporary' });
    process.stdout.write = origWrite;
    const joined = localLogs.join('');
    assert.ok(!joined.includes(course.key), '日志中出现真实 KEY 明文');
    assert.ok(joined.includes(course.kid.slice(0, 8)), '日志应保留脱敏 KID 前缀用于追踪');
    assert.ok(joined.includes('keyMaterialReturned":false'), '应显式标注未记录密钥材料');
  });

  await check('畸形请求返回 400', async () => {
    const r = await request(port, 'POST', '/api/license', 'not-json');
    assert.strictEqual(r.status, 400);
  });

  await server.stop();
  if (failures > 0) {
    console.error(`\n许可测试失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n许可服务测试全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
