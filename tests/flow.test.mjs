#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lesson = JSON.parse(readFileSync(resolve(ROOT, "config/lesson.json"), "utf8"));
const keys = JSON.parse(readFileSync(resolve(ROOT, "config/test-keys.json"), "utf8"));

const {
  createLicenseService,
  base64UrlToHex,
  hexToBase64Url,
  safeEqualHex
} = await import(pathToFileURL(resolve(ROOT, "server/license-service.mjs")));

const kid = hexToBase64Url("11111111111111111111111111111111");
const otherKid = hexToBase64Url("33333333333333333333333333333333");
const unknownKid = hexToBase64Url("99999999999999999999999999999999");

const results = [];
let logs = [];
const originalWrite = process.stdout.write.bind(process.stdout);

function quiet(fn) {
  process.stdout.write = (chunk, ...rest) => {
    logs.push(String(chunk));
    return true;
  };
  try {
    return fn();
  } finally {
    process.stdout.write = originalWrite;
  }
}

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

function licenseRequest(body) {
  return {
    assetId: "lesson-authorization-01",
    kids: [kid],
    sessionType: "temporary",
    keySystem: "org.w3.clearkey",
    player: "flow-test",
    ...body
  };
}

const service = createLicenseService({ lesson, keys });

check("正常请求返回与课程标识匹配的许可", () => {
  const response = quiet(() => service.handle(licenseRequest({})));
  assert.equal(response.status, 200);
  assert.equal(response.body.keys.length, 1);
  const key = response.body.keys[0];
  assert.equal(base64UrlToHex(key.kid), "11111111111111111111111111111111");
  assert.equal(base64UrlToHex(key.k), "22222222222222222222222222222222");
  assert.match(response.headers["cache-control"], /no-store/);
});

check("未知密钥标识被单独拒绝", () => {
  const response = quiet(() => service.handle(licenseRequest({ kids: [unknownKid] })));
  assert.equal(response.status, 403);
  assert.equal(response.body.error, "unknown-kid");
});

check("已知但不匹配的标识返回凭据不匹配", () => {
  const response = quiet(() => service.handle(licenseRequest({ kids: [otherKid] })));
  assert.equal(response.status, 403);
  assert.equal(response.body.error, "credential-key-mismatch");
});

check("未知资产返回 asset-not-found", () => {
  const response = quiet(() => service.handle(licenseRequest({ assetId: "not-a-lesson" })));
  assert.equal(response.status, 404);
  assert.equal(response.body.error, "asset-not-found");
});

check("格式无效的许可请求被拒绝", () => {
  const response = quiet(() => service.handle({ assetId: "lesson-authorization-01", kids: [] }));
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "malformed-request");
});

check("不支持 persistent-license 会话类型", () => {
  const response = quiet(() =>
    service.handle(licenseRequest({ sessionType: "persistent-license" }))
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "unsupported-session-type");
});

check("许可日志不包含密钥材料", () => {
  const keyHexField = keys.keys[0].keyHex;
  const joined = logs.join("");
  assert.ok(joined.includes("license.request"));
  assert.ok(!joined.includes(keyHexField), "日志泄露了密钥十六进制");
  assert.ok(!joined.includes("22222222222222222222222222222222"), "日志泄露了密钥材料");
  assert.ok(/kidFingerprint/.test(joined), "日志应只记录标识指纹");
});

check("标识比较为定长且拒绝空输入", () => {
  assert.equal(safeEqualHex("11", "11"), false);
  assert.equal(safeEqualHex("", ""), false);
  assert.equal(safeEqualHex("11".repeat(16), "11".repeat(16)), true);
});

check("场景与诊断都由内核状态机描述", () => {
  const ids = lesson.scenarios.map((s) => s.id);
  assert.deepEqual(ids, ["normal", "init-data-mismatch", "wrong-key", "license-offline"]);
  const diagnostics = lesson.diagnostics.map((d) => d.id);
  assert.deepEqual(diagnostics, ["session-failure", "mismatched-key-material"]);
  assert.ok(lesson.protection.limits.length >= 3);
  assert.equal(lesson.protection.strength, "software-test-key");
});

const failed = results.filter((r) => !r.ok);
for (const result of results) {
  originalWrite(`${result.ok ? "通过" : "失败"} · ${result.name}${result.ok ? "" : `：${result.error}`}\n`);
}
if (failed.length) {
  originalWrite(`\n${failed.length} 项许可流程断言失败\n`);
  process.exitCode = 1;
} else {
  originalWrite(`\n全部 ${results.length} 项许可流程断言通过\n`);
}
