#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_CONFIG = JSON.parse(await readFile(join(ROOT, "config/package.json"), "utf8"));
const KEY_CONFIG = JSON.parse(await readFile(join(ROOT, "config/test-keys.json"), "utf8"));
const LESSON = JSON.parse(await readFile(join(ROOT, "config/lesson.json"), "utf8"));

const FFMPEG = process.env.FFMPEG_BIN ?? resolve(ROOT, "node_modules/ffmpeg-static/ffmpeg");
const PACKAGER =
  process.env.SHAKA_PACKAGER_BIN ??
  resolve(ROOT, `node_modules/shaka-packager/bin/packager-${process.platform === "darwin" ? "osx" : process.platform === "win32" ? "win" : "linux"}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);

const OUT_DIR = resolve(ROOT, PACKAGE_CONFIG.output.directory);
const SOURCE_DIR = resolve(ROOT, PACKAGE_CONFIG.input.assPath, "..");
const ASS_PATH = resolve(ROOT, PACKAGE_CONFIG.input.assPath);
const FONT_DIR = resolve(ROOT, PACKAGE_CONFIG.input.fontDirectory);

function log(message) {
  process.stdout.write(`[package] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[package] 错误：${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8"
  });
  if (result.error) fail(`${command} 无法执行：${result.error.message}`);
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr ?? "");
    fail(`${command} 退出码 ${result.status}`);
  }
  return result;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function fileSize(path) {
  const { stat } = await import("node:fs/promises");
  return (await stat(path)).size;
}

function requireTool(path, label) {
  if (!existsSync(path)) {
    fail(`找不到${label}：${path}。请先运行 npm install。`);
  }
}

const video = PACKAGE_CONFIG.video;
const audio = PACKAGE_CONFIG.audio;

function encodeArgs(plainPath) {
  const videoFilter = [
    ...PACKAGE_CONFIG.input.overlays,
    `ass=${ASS_PATH}:fontsdir=${FONT_DIR}`
  ].join(",");

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    PACKAGE_CONFIG.input.videoSource,
    "-f",
    "lavfi",
    "-i",
    PACKAGE_CONFIG.input.audioSource,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    videoFilter,
    "-c:v",
    "libx264",
    "-profile:v",
    video.profile,
    "-level:v",
    String(video.level),
    "-g",
    String(video.gop),
    "-keyint_min",
    String(video.gop),
    "-sc_threshold",
    "0",
    "-b:v",
    video.bitrate,
    "-maxrate",
    video.bitrate,
    "-bufsize",
    video.bufferSize,
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    "-x264-params",
    "deterministic=1:threads=1:scenecut=0",
    "-c:a",
    "aac",
    "-b:a",
    audio.bitrate,
    "-ac",
    String(audio.channels),
    "-ar",
    String(audio.sampleRate),
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags",
    "+bitexact",
    "-movflags",
    "+faststart",
    plainPath,
    "-y"
  ];
}

function packagerArgs(plainPath, outputName, kidHex, keyHex) {
  const stream = (kind) => [
    `in=${plainPath},stream=${kind},segment_template=${join(
      OUT_DIR,
      `${kind}-seg-$Number$.m4s`
    )},output=${join(OUT_DIR, `${kind}-init.mp4`)}`
  ];

  return [
    ...stream("video"),
    ...stream("audio"),
    "--enable_raw_key_encryption",
    `--keys=label=:key_id=${kidHex}:key=${keyHex}`,
    `--iv=${PACKAGE_CONFIG.packaging.defaultIvHex}`,
    `--protection_scheme=${PACKAGE_CONFIG.packaging.protectionScheme}`,
    "--clear_lead=0",
    `--segment_duration=${PACKAGE_CONFIG.packaging.segmentSeconds}`
  ];
}

async function topLevelFiles(dir) {
  return (await readdir(dir)).filter((name) => !name.startsWith(".")).sort();
}

function segmentNumber(name) {
  return Number(name.match(/-seg-(\d+)\.m4s$/)?.[1] ?? 0);
}

async function main() {
  requireTool(FFMPEG, " ffmpeg");
  requireTool(PACKAGER, " Shaka Packager");
  if (!existsSync(ASS_PATH)) fail(`找不到字幕源：${ASS_PATH}`);
  if (!existsSync(FONT_DIR)) fail(`找不到字幕字体目录：${FONT_DIR}`);

  const lessonAsset = LESSON.mediaAsset;
  if (lessonAsset.assetId !== PACKAGE_CONFIG.asset.assetId) {
    fail(`config/lesson.json 与 config/package.json 的资产标识不一致`);
  }

  const primary = KEY_CONFIG.keys.find((key) => key.id === PACKAGE_CONFIG.asset.primaryKeyId);
  if (!primary) fail(`测试密钥文件缺少 ${PACKAGE_CONFIG.asset.primaryKeyId}`);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const plainPath = join(OUT_DIR, PACKAGE_CONFIG.output.plainFileName);

  log(`编码自制裁剪内容 → ${relative(ROOT, plainPath)}`);
  run(FFMPEG, encodeArgs(plainPath));

  log(`实际加密封装（CENC ${PACKAGE_CONFIG.packaging.protectionScheme}，固定测试 IV）`);
  run(PACKAGER, packagerArgs(plainPath, PACKAGE_CONFIG, primary.kidHex, primary.keyHex), { capture: true });

  const manifest = {
    schema: "edu-drm-lab/media-asset@1",
    assetId: PACKAGE_CONFIG.asset.assetId,
    protectionLabel: PACKAGE_CONFIG.asset.protectionLabel,
    protectionScheme: PACKAGE_CONFIG.packaging.protectionScheme,
    keySystem: LESSON.license.keySystem,
    durationSeconds: PACKAGE_CONFIG.asset.durationSeconds,
    segmentSeconds: PACKAGE_CONFIG.packaging.segmentSeconds,
    mimeType: PACKAGE_CONFIG.asset.mimeType,
    keyIdHex: primary.kidHex,
    tracks: {
      video: {
        codec: video.codec,
        mimeType: video.mimeType,
        initSegment: "video-init.mp4",
        segments: [],
        width: video.width,
        height: video.height
      },
      audio: {
        codec: audio.codec,
        mimeType: audio.mimeType,
        initSegment: "audio-init.mp4",
        segments: [],
        sampleRate: audio.sampleRate,
        channels: audio.channels
      }
    },
    generatedBy: "tools/package-media.mjs",
    reproducibility: {
      label: "可重复封装演练",
      note: "固定源 seed、单线程编码与固定测试 IV，使同一机器上的重复封装逐字节一致。"
    }
  };

  for (const kind of ["video", "audio"]) {
    const initName = `${kind}-init.mp4`;
    const initPath = join(OUT_DIR, initName);
    if (!existsSync(initPath)) fail(`封装输出缺少 ${initName}`);
    const initBytes = normalizeMp4Timestamps(await readFile(initPath));
    await writeFile(initPath, initBytes);
    const segmentNames = (await topLevelFiles(OUT_DIR))
      .filter((name) => name.startsWith(`${kind}-seg-`) && name.endsWith(".m4s"))
      .sort((a, b) => segmentNumber(a) - segmentNumber(b));
    const initData = extractPssh(initBytes);
    if (kind === "video") {
      manifest.initData = initData;
    }
    manifest.tracks[kind].initSegmentSha256 = createHash("sha256").update(initBytes).digest("hex");
    manifest.tracks[kind].initSegmentBytes = initBytes.length;
    for (const name of segmentNames) {
      const path = join(OUT_DIR, name);
      manifest.tracks[kind].segments.push({
        file: name,
        bytes: await fileSize(path),
        sha256: await sha256File(path)
      });
    }
    if (manifest.tracks[kind].segments.length === 0) {
      fail(`${kind} 轨道没有生成任何分片`);
    }
  }

  manifest.bundleSha256 = createHash("sha256")
    .update(JSON.stringify(manifest.tracks))
    .digest("hex");

  await writeFile(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(OUT_DIR, "README.txt"), manifestReadme(manifest));
  log(`完成：${relative(ROOT, OUT_DIR)}/manifest.json`);
  log(
    `校验：视频 ${manifest.tracks.video.segments.length} 片 / 音频 ${manifest.tracks.audio.segments.length} 片，KID ${manifest.keyIdHex.slice(0, 8)}…`
  );
}

function extractPssh(buffer) {
  const marker = buffer.indexOf(Buffer.from("pssh"));
  if (marker < 0) return null;
  const start = marker - 4;
  const size = buffer.readUInt32BE(start);
  const box = buffer.subarray(start, start + size);
  const version = box.readUInt8(8);
  const systemIdHex = box.subarray(12, 28).toString("hex");
  let kidHex = null;
  if (version > 0) {
    const kidCount = box.readUInt32BE(28);
    if (kidCount > 0) {
      kidHex = box.subarray(32, 48).toString("hex");
    }
  }
  return {
    boxBase64: box.toString("base64"),
    systemIdHex,
    kidHex
  };
}

const NORMALIZED_EPOCH = 3_786_912_000; // 2024-01-01T00:00:00Z，自 1904 起的秒数

function normalizeMp4Timestamps(buffer) {
  const copy = Buffer.from(buffer);
  const container = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

  const walk = (offset, end) => {
    while (offset + 8 <= end) {
      const size = copy.readUInt32BE(offset);
      const type = copy.toString("latin1", offset + 4, offset + 8);
      if (size < 8 || offset + size > end) return;
      if (type === "mvhd" || type === "mdhd" || type === "tkhd") {
        const version = copy.readUInt8(offset + 8);
        const fieldOffset = version === 1 ? offset + 12 : offset + 12;
        if (version === 1) {
          copy.writeUInt32BE(0, fieldOffset);
          copy.writeUInt32BE(NORMALIZED_EPOCH, fieldOffset + 4);
          copy.writeUInt32BE(0, fieldOffset + 8);
          copy.writeUInt32BE(NORMALIZED_EPOCH, fieldOffset + 12);
        } else {
          copy.writeUInt32BE(NORMALIZED_EPOCH, fieldOffset);
          copy.writeUInt32BE(NORMALIZED_EPOCH, fieldOffset + 4);
        }
      } else if (container.has(type)) {
        walk(offset + 8, offset + size);
      }
      offset += size;
    }
  };

  walk(0, copy.length);
  return copy;
}

function manifestReadme(manifest) {
  return [
    `资产：${manifest.assetId}`,
    `保护：CENC（${manifest.protectionScheme}）+ ClearKey 测试密钥`,
    `密钥标识：${manifest.keyIdHex}`,
    `分片：视频 ${manifest.tracks.video.segments.length}，音频 ${manifest.tracks.audio.segments.length}`,
    "",
    "本目录由 tools/package-media.mjs 生成。所有画面与声音均为自制测试内容。",
    "密钥材料不在本目录中；许可端只返回与密钥标识匹配的课程密钥。"
  ].join("\n") + "\n";
}

main().catch((error) => fail(error.stack ?? error.message));
