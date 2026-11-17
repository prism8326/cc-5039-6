'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { hasEncryptionBoxes } = require('../bin/isobmff');

const root = path.resolve(__dirname, '..');
const keyStore = JSON.parse(fs.readFileSync(path.join(root, 'keys', 'courses.json'), 'utf8'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

console.log('封装结构测试 (CENC-AES-CTR)');
for (const course of keyStore.courses) {
  const dir = path.join(root, 'content', course.courseId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  console.log(`课程 ${course.courseId}:`);

  check('清单 KID 与密钥库一致', () => {
    assert.strictEqual(manifest.kid, course.kid);
  });

  check('至少包含 3 个分段', () => {
    assert.ok(manifest.segments.length >= 3, `分段数=${manifest.segments.length}`);
  });

  manifest.segments.forEach((seg) => {
    check(`分段 ${seg.index} 加密盒完整 (encv/enca/sinf/tenc/saiz/saio)`, () => {
      const buf = fs.readFileSync(path.join(dir, seg.url));
      const r = hasEncryptionBoxes(buf);
      assert.ok(r.isEncrypted, '缺少 sinf/tenc/frma');
      assert.ok(r.hasEncryptedSampleEntry, '缺少 encv/enca 样本条目');
      assert.ok(r.hasSaiz && r.hasSaio, '缺少 saiz/saio');
      assert.strictEqual(r.tenc.kid, course.kid, 'tenc KID 不匹配');
      assert.strictEqual(r.tenc.isProtected, 1);
      assert.strictEqual(r.tenc.perSampleIvSize, 8);
    });

    check(`分段 ${seg.index} 密文与明文字节不同`, () => {
      const enc = fs.readFileSync(path.join(dir, seg.url));
      const plain = fs.readFileSync(path.join(dir, seg.plainUrl));
      assert.ok(!enc.equals(plain), '加密分段与明文分段完全相同');
      const plainCenc = hasEncryptionBoxes(plain);
      assert.ok(!plainCenc.isEncrypted, '明文分段竟包含加密盒');
    });
  });
}

if (failures > 0) {
  console.error(`\n封装测试失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n封装结构测试全部通过');
