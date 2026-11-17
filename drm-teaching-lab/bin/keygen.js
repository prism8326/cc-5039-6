#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_STORE_VERSION = 1;

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function deriveDeterministic(seed, role) {
  const h = crypto.createHash('sha256').update(`drm-teaching-lab/${role}/${seed}`).digest();
  return { kid: h.subarray(0, 16), key: crypto.createHash('sha256').update(h).digest().subarray(0, 16) };
}

function randomPair() {
  return { kid: crypto.randomBytes(16), key: crypto.randomBytes(16) };
}

function buildKeyStore(mode) {
  const courses = [
    {
      courseId: 'demo-cipher-101',
      title: '密码学导论（虚构教学课）',
      seed: 'demo-cipher-101',
    },
    {
      courseId: 'demo-media-201',
      title: '媒体保护基础（虚构教学课）',
      seed: 'demo-media-201',
    },
  ];
  const entries = courses.map((c) => {
    const pair = mode === 'random' ? randomPair() : deriveDeterministic(c.seed, 'cenc-aes-ctr');
    return {
      courseId: c.courseId,
      title: c.title,
      kid: hex(pair.kid),
      key: hex(pair.key),
      scheme: 'cenc-aes-ctr',
    };
  });
  return {
    version: KEY_STORE_VERSION,
    mode,
    note: '仅用于本地授权教学实验的测试密钥，禁止用于生产或真实内容保护。',
    createdAt: new Date().toISOString(),
    courses: entries,
  };
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--random') ? 'random' : 'deterministic';
  const outArg = args.find((a) => a.startsWith('--out='));
  const outPath = outArg ? outArg.split('=')[1] : path.join('keys', 'courses.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const store = buildKeyStore(mode);
  fs.writeFileSync(outPath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  for (const c of store.courses) {
    console.log(`[keygen] ${c.courseId}  KID=${c.kid}  KEY=${'*'.repeat(32)} (${mode})`);
  }
  console.log(`[keygen] 密钥库已写入 ${outPath} (权限 0600，普通日志不会输出 KEY 明文)`);
}

if (require.main === module) {
  main();
}

module.exports = { buildKeyStore, deriveDeterministic, hex };
