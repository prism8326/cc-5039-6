#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { hasEncryptionBoxes } = require('./isobmff');
const { encryptSegment } = require('./cenc-postprocess');

const FFMPEG = require('ffmpeg-static');

const CLEARKEY_SYSTEM_ID = '1077efecc0b24d02ace33c1e52e2fb4b';

const COURSE_SPECS = {
  'demo-cipher-101': {
    duration: 12,
    size: '640x360',
    fps: 24,
    gop: 48,
    videoCodec: 'libx264',
    profile: 'baseline',
    level: '3.0',
    codecRfc6381: 'avc1.42E01E',
    audioCodec: 'aac',
    audioRfc6381: 'mp4a.40.2',
    label: 'CRYPTO-101',
    baseHue: 'hue=h=200:s=0.5',
  },
  'demo-media-201': {
    duration: 12,
    size: '640x360',
    fps: 24,
    gop: 48,
    videoCodec: 'libx264',
    profile: 'baseline',
    level: '3.0',
    codecRfc6381: 'avc1.42E01E',
    audioCodec: 'aac',
    audioRfc6381: 'mp4a.40.2',
    label: 'MEDIA-201',
    baseHue: 'hue=h=120:s=0.45',
  },
};

function runFfmpeg(args) {
  try {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    process.stderr.write(`[ffmpeg 失败参数]\n${args.join(' ')}\n`);
    if (err.stderr) process.stderr.write(err.stderr.toString() + '\n');
    throw err;
  }
}

function buildVideoFilter(spec) {
  const [w, h] = spec.size.split('x').map(Number);
  const chain = [
    spec.baseHue,
    `drawbox=x=0:y=0:w=${w}:h=10:color=red@0.8:t=fill`,
    `drawbox=x=0:y=${h - 10}:w=${w}:h=10:color=blue@0.8:t=fill`,
    `drawbox=x=18:y=18:w=180:h=36:color=black@0.45:t=fill`,
    `drawbox=x=${w - 140}:y=18:w=122:h=36:color=black@0.45:t=fill`,
    `drawbox=x=18:y=${h - 64}:w=520:h=34:color=black@0.5:t=fill`,
    `drawgrid=width=64:height=64:thickness=1:color=white@0.25`,
  ].join(',');
  return chain;
}

function ensureFreetype() {
  return true;
}

function packCourse(course, outRoot) {
  const spec = COURSE_SPECS[course.courseId];
  if (!spec) {
    throw new Error(`未知课程: ${course.courseId}`);
  }
  const dir = path.join(outRoot, course.courseId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'plain'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'enc'), { recursive: true });

  const vf = buildVideoFilter(spec);
  const commonVideo = [
    '-f', 'lavfi', '-i', `testsrc2=size=${spec.size}:rate=${spec.fps}:duration=${spec.duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${spec.duration}`,
    '-filter_complex', `[0:v]${vf}[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', spec.videoCodec, '-profile:v', spec.profile, '-level:v', spec.level,
    '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-g', String(spec.gop), '-keyint_min', String(spec.gop), '-sc_threshold', '0',
    '-c:a', spec.audioCodec, '-b:a', '96k', '-ar', '48000', '-ac', '2',
  ];

  const segMovflags = '+frag_keyframe+empty_moov+default_base_moof+separate_moof';

  runFfmpeg([
    ...commonVideo,
    '-f', 'segment', '-segment_time', '2', '-segment_format', 'mp4',
    '-segment_format_options', `movflags=${segMovflags}`,
    path.join(dir, 'plain', 'plain-%03d.mp4'),
  ]);

  const plainFiles = fs.readdirSync(path.join(dir, 'plain')).filter((f) => f.endsWith('.mp4')).sort();
  if (plainFiles.length === 0) {
    throw new Error('明文分段数量为 0');
  }
  for (const f of plainFiles) {
    const plainBuf = fs.readFileSync(path.join(dir, 'plain', f));
    const encBuf = encryptSegment(plainBuf, course.kid, course.key);
    fs.writeFileSync(path.join(dir, 'enc', f.replace('plain-', 'enc-')), encBuf);
  }

  const encFiles = fs.readdirSync(path.join(dir, 'enc')).filter((f) => f.endsWith('.mp4')).sort();
  if (plainFiles.length !== encFiles.length) {
    throw new Error(`分段数量异常: plain=${plainFiles.length} enc=${encFiles.length}`);
  }

  const verifications = verifySegments(dir, plainFiles, encFiles, course.kid);
  const manifest = {
    manifestVersion: 1,
    courseId: course.courseId,
    title: course.title,
    createdAt: new Date().toISOString(),
    scheme: 'cenc-aes-ctr',
    kid: course.kid,
    psshSystemId: CLEARKEY_SYSTEM_ID,
    durationSec: spec.duration,
    segmentDurationSec: 2,
    video: { contentType: `video/mp4; codecs="${spec.codecRfc6381}"`, rfc6381: spec.codecRfc6381, size: spec.size, fps: spec.fps },
    audio: { contentType: `audio/mp4; codecs="${spec.audioRfc6381}"`, rfc6381: spec.audioRfc6381, sampleRate: 48000, channels: 2 },
    segments: encFiles.map((f, i) => ({ index: i, url: `enc/${f}`, plainUrl: `plain/${plainFiles[i]}`, bytes: fs.statSync(path.join(dir, 'enc', f)).size })),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'verify-report.json'), JSON.stringify(verifications, null, 2) + '\n');
  return { manifest, verifications };
}

function hasFragmentAuxBoxes(buf) {
  const { walk } = require('./isobmff');
  const found = new Set();
  walk(buf, 0, buf.length, 0, (b) => found.add(b.type));
  return found.has('senc') && found.has('saiz') && found.has('saio');
}

function verifySegments(dir, plainFiles, encFiles, expectedKid) {
  const report = { segments: [], allCiphertextDifferFromPlain: true, allContainCencBoxes: true, allContainPssh: true, allContainFragmentAux: true, kidMatches: true };
  for (let i = 0; i < encFiles.length; i += 1) {
    const encPath = path.join(dir, 'enc', encFiles[i]);
    const plainPath = path.join(dir, 'plain', plainFiles[i]);
    const encBuf = fs.readFileSync(encPath);
    const plainBuf = fs.readFileSync(plainPath);
    const cenc = hasEncryptionBoxes(encBuf);
    const plainCenc = hasEncryptionBoxes(plainBuf);
    const sameBytes = encBuf.equals(plainBuf);
    const kidOk = cenc.tenc && cenc.tenc.kid === expectedKid;
    const auxOk = hasFragmentAuxBoxes(encBuf);
    if (!cenc.isEncrypted || plainCenc.isEncrypted || sameBytes || !kidOk) {
      report.allCiphertextDifferFromPlain = report.allCiphertextDifferFromPlain && !sameBytes;
      report.allContainCencBoxes = report.allContainCencBoxes && cenc.isEncrypted;
      report.kidMatches = report.kidMatches && kidOk;
    }
    report.segments.push({
      index: i,
      encFile: encFiles[i],
      plainFile: plainFiles[i],
      cencBoxes: cenc.isEncrypted,
      encryptedSampleEntry: cenc.hasEncryptedSampleEntry,
      saizSaio: auxOk,
      pssh: cenc.hasPssh,
      tencKid: cenc.tenc ? cenc.tenc.kid : null,
      kidMatchesManifest: kidOk,
      ciphertextDiffersFromPlain: !sameBytes,
    });
    report.allContainPssh = report.allContainPssh && cenc.hasPssh;
    report.allContainFragmentAux = report.allContainFragmentAux && auxOk;
  }
  report.verified = report.allCiphertextDifferFromPlain && report.allContainCencBoxes && report.kidMatches && report.allContainPssh && report.allContainFragmentAux;
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const keyStoreArg = args.find((a) => a.startsWith('--keys='));
  const outArg = args.find((a) => a.startsWith('--out='));
  const courseArg = args.find((a) => a.startsWith('--course='));
  const keyStorePath = keyStoreArg ? keyStoreArg.split('=')[1] : path.join('keys', 'courses.json');
  const outRoot = outArg ? outArg.split('=')[1] : path.join('content');
  const keyStore = JSON.parse(fs.readFileSync(keyStorePath, 'utf8'));
  ensureFreetype();
  const courses = courseArg ? keyStore.courses.filter((c) => c.courseId === courseArg.split('=')[1]) : keyStore.courses;
  if (courses.length === 0) {
    throw new Error('密钥库中没有匹配的课程。');
  }
  for (const course of courses) {
    const { manifest, verifications } = packCourse(course, outRoot);
    console.log(`[pack] ${course.courseId}: ${manifest.segments.length} 个分段, CENC 盒校验=${verifications.verified ? '通过' : '失败'}`);
    if (!verifications.verified) {
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { packCourse, COURSE_SPECS };
