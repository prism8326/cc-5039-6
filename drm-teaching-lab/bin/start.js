#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { LicenseServer } = require('../server/license-server');
const { execFileSync } = require('child_process');

async function main() {
  const args = process.argv.slice(2);
  const port = Number(args.find((a) => a.startsWith('--port='))?.split('=')[1] || 8088);
  const host = args.find((a) => a.startsWith('--host='))?.split('=')[1] || '127.0.0.1';
  const root = path.resolve(__dirname, '..');
  const server = new LicenseServer({
    keyStorePath: path.join(root, 'keys', 'courses.json'),
    contentRoot: root,
    port,
    host,
  });
  await server.start();
  const url = `http://${host}:${port}/`;
  console.log(`[launch] 图形播放器入口: ${url}`);
  console.log('[launch] 在浏览器打开上述地址即可选择测试凭据并演练许可场景。');

  if (!args.includes('--no-open')) {
    const candidates = [
      ['xdg-open', [url]],
      ['google-chrome', [url]],
      ['chromium', [url]],
      ['chromium-browser', [url]],
      ['open', [url]],
    ];
    for (const [cmd, cmdArgs] of candidates) {
      try {
        execFileSync('which', [cmd], { stdio: 'ignore' });
        spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, env: process.env }).unref();
        console.log(`[launch] 已尝试用 ${cmd} 打开图形播放器。`);
        break;
      } catch { /* try next */ }
    }
  }

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[launch] 启动失败:', e);
  process.exit(1);
});
