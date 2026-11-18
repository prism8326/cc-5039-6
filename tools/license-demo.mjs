#!/usr/bin/env node
/**
 * 许可演练 CLI（辅助加密教学，不能替代图形入口）。
 * 直接调用与服务同样的许可内核，打印响应分类与安全日志，不输出密钥材料。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lesson = JSON.parse(readFileSync(resolve(ROOT, "config/lesson.json"), "utf8"));
const keys = JSON.parse(readFileSync(resolve(ROOT, "config/test-keys.json"), "utf8"));

const { createLicenseService, hexToBase64Url } = await import(
  pathToFileURL(resolve(ROOT, "server/license-service.mjs"))
);

const service = createLicenseService({ lesson, keys });

const primaryKid = hexToBase64Url(lesson.credentials.find((c) => c.role === "primary").kidHex);
const standbyKid = hexToBase64Url(lesson.credentials.find((c) => c.role === "standby").kidHex);
const unknownKid = hexToBase64Url("99999999999999999999999999999999");

const cases = [
  {
    label: "正常许可",
    request: { assetId: lesson.mediaAsset.assetId, kids: [primaryKid], sessionType: "temporary" }
  },
  {
    label: "改动初始化数据（未知标识）",
    request: { assetId: lesson.mediaAsset.assetId, kids: [unknownKid], sessionType: "temporary" }
  },
  {
    label: "错误密钥（已知但不匹配）",
    request: { assetId: lesson.mediaAsset.assetId, kids: [standbyKid], sessionType: "temporary" }
  },
  {
    label: "未知课程资产",
    request: { assetId: "lesson-does-not-exist", kids: [primaryKid], sessionType: "temporary" }
  },
  {
    label: "不支持的会话类型",
    request: { assetId: lesson.mediaAsset.assetId, kids: [primaryKid], sessionType: "persistent-license" }
  }
];

function quietly(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    return { value: fn(), logs: captured };
  } finally {
    process.stdout.write = original;
  }
}

function safeLicenseView(response) {
  if (response.status !== 200) return { status: response.status, body: response.body };
  return {
    status: response.status,
    type: response.body.type,
    assetId: response.body.assetId,
    keyCount: response.body.keys.length,
    keys: response.body.keys.map((key) => ({
      kty: key.kty,
      kid: `${key.kid.slice(0, 6)}…`,
      k: `len=${key.k.replace(/=+$/, "").length}（值不输出）`
    }))
  };
}

process.stdout.write("许可端演练 —— 本地虚构课程，只服务 ClearKey 测试密钥\n");
process.stdout.write("说明：命令行仅辅助教学；图形入口见 http://127.0.0.1:4173/\n\n");

let failures = 0;
for (const testCase of cases) {
  const { value, logs } = quietly(() => service.handle(testCase.request));
  const leakedKey = logs.join("").includes(keys.keys[0].keyHex);
  const leakedMaterial = logs.join("").includes(JSON.stringify(keys.keys[0].keyHex));
  if (leakedKey || leakedMaterial) failures += 1;

  process.stdout.write(`· ${testCase.label}\n`);
  process.stdout.write(`  响应：${JSON.stringify(safeLicenseView(value))}\n`);
  process.stdout.write(`  服务日志：${logs.join("").trim().replace(/\n/g, "\n            ")}\n`);
  process.stdout.write(`  密钥材料泄露：${leakedKey || leakedMaterial ? "是（不符合要求）" : "否"}\n\n`);
}

process.stdout.write(
  failures === 0
    ? "全部演练结束：拒绝均按原因分类，日志未输出密钥材料。\n"
    : "演练发现日志泄露密钥材料，请修复后再运行。\n"
);
if (failures > 0) process.exitCode = 1;
