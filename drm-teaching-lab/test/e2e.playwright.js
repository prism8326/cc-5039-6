'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { LicenseServer } = require('../server/license-server');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 0;
let BASE = `http://127.0.0.1`;

function findChrome() {
  const candidates = [
    '/home/node/.cache/ms-playwright/chromium-1255/chrome-linux-arm64/chrome',
    '/home/node/.cache/ms-playwright/chromium-1255/chrome-linux/chrome',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function browserEnv() {
  const libDirs = ['/tmp/chromelibs/usr/lib/aarch64-linux-gnu', '/tmp/chromelibs/lib/aarch64-linux-gnu']
    .filter((p) => fs.existsSync(p));
  const env = { ...process.env };
  if (libDirs.length) {
    env.LD_LIBRARY_PATH = [...libDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  if (fs.existsSync('/tmp/.X11-unix/X99')) {
    env.DISPLAY = ':99';
    env.XKB_CONFIG_ROOT = '/tmp/chromelibs/usr/share/X11/xkb';
  }
  return env;
}

async function launchBrowser() {
  const executablePath = findChrome();
  const useHeadlessShell = !executablePath;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath, headless: false } : { headless: true }),
    ignoreDefaultArgs: ['--disable-field-trial-config'],
    env: browserEnv(),
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  return { browser, useHeadlessShell };
}

async function setScenario(page, scenario) {
  await page.evaluate(async (s) => {
    await fetch('/api/scenario', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: s }),
    });
  }, scenario);
}

async function runScenario(page, { scenario, tamper = false, plain = false }) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled, { timeout: 15000 });
  await setScenario(page, scenario);
  await page.check(`input[name="scenario"][value="${scenario}"]`);
  if (tamper) await page.check('#tamperInit');
  if (plain) await page.check('#plainMode');
  await page.click('#playBtn');
}

async function pillText(page) {
  return page.textContent('#statePill');
}

async function milestoneClass(page, id) {
  return page.getAttribute(id, 'class');
}

(async () => {
  const server = new LicenseServer({
    keyStorePath: path.join(ROOT, 'keys', 'courses.json'),
    contentRoot: ROOT,
    port: PORT,
  });
  const quiet = () => {};
  server.log = quiet;
  await server.start();
  const actualPort = server.server.address().port;
  BASE = `http://127.0.0.1:${actualPort}`;

  const { browser, useHeadlessShell } = await launchBrowser();
  console.log(`浏览器: ${useHeadlessShell ? 'headless-shell（EME 可能不可用）' : '完整 Chrome for Testing + Xvfb'}`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  let failures = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${name}: ${e.message}`);
    }
  };

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const emeSupported = await page.evaluate(() => 'requestMediaKeySystemAccess' in Navigator.prototype);
  console.log(`EME 支持: ${emeSupported}（安全上下文: ${await page.evaluate(() => isSecureContext)}）`);
  if (!emeSupported) {
    console.error('当前浏览器在安全上下文中仍不支持 EME，端到端测试无法继续。');
    await browser.close();
    await server.stop();
    process.exit(2);
  }

  console.log('端到端 EME 测试');

  await check('正常场景：三阶段全部达成并真实呈现画面', async () => {
    await runScenario(page, { scenario: 'normal' });
    await page.waitForFunction(() => {
      const v = document.getElementById('video');
      return v.readyState >= 2 && v.videoWidth > 0;
    }, { timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.ok((await milestoneClass(page, '#ms-license')).includes('done'), '阶段① 许可未取得');
    assert.ok((await milestoneClass(page, '#ms-key')).includes('done'), '阶段② 密钥未 usable');
    assert.ok((await milestoneClass(page, '#ms-decode')).includes('done'), '阶段③ 未真实解码');
    const dims = await page.evaluate(() => ({ w: video.videoWidth, h: video.videoHeight, t: video.currentTime }));
    assert.ok(dims.w === 640 && dims.h === 360, `画面尺寸异常: ${JSON.stringify(dims)}`);
    assert.ok(dims.t > 0, '播放时间未推进');
    const shot = await page.evaluate(() => {
      const c = document.getElementById('snapshot');
      const ctx = c.getContext('2d');
      ctx.drawImage(document.getElementById('video'), 0, 0, c.width, c.height);
      const d = ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data;
      return Array.from(d);
    });
    assert.ok(shot.some((v) => v !== 0), '截图中心像素全黑，未呈现真实画面');
    await page.click('#stopBtn');
  });

  await check('篡改初始化数据：许可/密钥阶段被拒，无真实呈现', async () => {
    await runScenario(page, { scenario: 'normal', tamper: true });
    await page.waitForFunction(() => {
      const p = document.getElementById('statePill').textContent;
      return /失败|异常|拒绝/.test(p);
    }, { timeout: 20000 });
    const decodeClass = await milestoneClass(page, '#ms-decode');
    assert.ok(!decodeClass.includes('done'), '篡改 initData 后竟然解码成功');
    const v = await page.evaluate(() => ({ readyState: video.readyState, w: video.videoWidth }));
    assert.ok(v.readyState < 2 || v.w === 0, '不应出现可解码画面');
    await page.click('#stopBtn');
  });

  await check('错误密钥：收到许可但密钥不可用，解码被拒绝', async () => {
    await runScenario(page, { scenario: 'wrong-key' });
    await page.waitForFunction(() => {
      const p = document.getElementById('statePill').textContent;
      return /密钥|失败|拒绝/.test(p);
    }, { timeout: 20000 });
    const licenseClass = await milestoneClass(page, '#ms-license');
    assert.ok(licenseClass.includes('done'), '错误密钥场景下许可响应应已收到（阶段①达成）');
    const keyClass = await milestoneClass(page, '#ms-key');
    assert.ok(keyClass.includes('failed'), '阶段② 应判定密钥失败');
    const decodeClass = await milestoneClass(page, '#ms-decode');
    assert.ok(!decodeClass.includes('done'), '错误密钥不应解码成功');
    await page.click('#stopBtn');
  });

  await check('未知 KID：许可端 404，阶段①即失败', async () => {
    await runScenario(page, { scenario: 'unknown-kid' });
    await page.waitForFunction(() => {
      const p = document.getElementById('statePill').textContent;
      return /许可取得失败/.test(p);
    }, { timeout: 20000 });
    const licenseClass = await milestoneClass(page, '#ms-license');
    assert.ok(licenseClass.includes('failed'), '未知 KID 应在许可阶段失败');
    const detail = await page.textContent('#stateDetail');
    assert.ok(/404|unknown_kid/.test(detail), `详情未体现 404: ${detail}`);
    await page.click('#stopBtn');
  });

  await check('会话创建失败：许可端 500，阶段①失败', async () => {
    await runScenario(page, { scenario: 'session-fail' });
    await page.waitForFunction(() => {
      const p = document.getElementById('statePill').textContent;
      return /许可取得失败/.test(p);
    }, { timeout: 20000 });
    const detail = await page.textContent('#stateDetail');
    assert.ok(/500|session_creation_failed/.test(detail), `详情未体现 500: ${detail}`);
    await page.click('#stopBtn');
  });

  await check('许可端断开：fetch 失败，阶段①失败且无解码', async () => {
    await runScenario(page, { scenario: 'offline' });
    await page.waitForFunction(() => {
      const p = document.getElementById('statePill').textContent;
      return /许可取得失败/.test(p);
    }, { timeout: 20000 });
    const decodeClass = await milestoneClass(page, '#ms-decode');
    assert.ok(!decodeClass.includes('done'));
    await page.click('#stopBtn');
  });

  await check('明文对照组：能播放但不标记任何 EME 里程碑', async () => {
    await runScenario(page, { scenario: 'normal', plain: true });
    await page.waitForFunction(() => {
      const v = document.getElementById('video');
      return v.readyState >= 2 && v.videoWidth > 0;
    }, { timeout: 20000 });
    const licenseClass = await milestoneClass(page, '#ms-license');
    assert.ok(!licenseClass.includes('done'), '明文播放不应点亮许可里程碑');
    const pill = await pillText(page);
    assert.ok(/不是加密链验证/.test(pill), `应提示非加密链验证: ${pill}`);
    await page.click('#stopBtn');
  });

  await check('事件日志不含 KEY 明文', async () => {
    const keyStore = server.keyStore;
    const logText = await page.textContent('#eventLog');
    for (const c of keyStore.courses) {
      assert.ok(!logText.includes(c.key), `日志泄露课程 ${c.courseId} 的 KEY`);
    }
  });

  if (consoleErrors.length > 0) {
    console.warn('页面级 JS 错误:', consoleErrors);
  }

  await browser.close();
  await server.stop();

  if (failures > 0) {
    console.error(`\n端到端测试失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n端到端 EME 测试全部通过');
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
