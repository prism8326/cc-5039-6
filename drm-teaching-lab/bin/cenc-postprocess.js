'use strict';

const crypto = require('crypto');
const { buildPsshBox } = require('./isobmff');

const CLEARKEY_SYSTEM_ID = '1077efecc0b24d02ace33c1e52e2fb4b';
const IV_SIZE = 8;

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0, 0);
  return b;
}

function i32(value) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return b;
}

function box(type, body) {
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

function parseChildren(buf, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    const size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size < 8 || o + size > end) {
      break;
    }
    out.push({ type, off: o, size, bodyStart: o + 8, end: o + size });
    o += size;
  }
  return out;
}

function findBox(boxes, type) {
  return boxes.find((b) => b.type === type) || null;
}

function deriveIv(kidHex, fragmentIndex, sampleIndex) {
  return crypto.createHash('sha256')
    .update(`cenc-iv/${kidHex}/${fragmentIndex}/${sampleIndex}`)
    .digest()
    .subarray(0, IV_SIZE);
}

function ctrStream(key, iv, length) {
  const fullIv = Buffer.concat([iv, Buffer.alloc(8)]);
  const cipher = crypto.createCipheriv('aes-128-ctr', Buffer.from(key, 'hex'), fullIv);
  cipher.setAutoPadding(false);
  const keystream = Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
  return keystream;
}

function xorInto(target, source, keystream, ksOffset, length) {
  for (let i = 0; i < length; i += 1) {
    target[i] = source[i] ^ keystream[ksOffset + i];
  }
}

function encryptVideoSample(sample, key, iv) {
  const keystream = ctrStream(key, iv, sample.length);
  const out = Buffer.alloc(sample.length);
  const subsamples = [];
  let pos = 0;
  let ks = 0;
  while (pos + 4 <= sample.length) {
    const nalLength = sample.readUInt32BE(pos);
    if (nalLength <= 0 || pos + 4 + nalLength > sample.length) {
      throw new Error(`非法 NAL 长度 ${nalLength} @${pos}（样本总长 ${sample.length}）`);
    }
    out.writeUInt32BE(nalLength, pos);
    const nalStart = pos + 4;
    const clearHeader = 1 + (sample[nalStart] & 0x80 ? 1 : 0);
    out[nalStart] = sample[nalStart];
    if (clearHeader === 2) {
      out[nalStart + 1] = sample[nalStart + 1];
    }
    const cipherStart = nalStart + clearHeader;
    const cipherLen = nalLength - clearHeader;
    xorInto(out.subarray(cipherStart), sample.subarray(cipherStart), keystream, ks, cipherLen);
    ks += cipherLen;
    subsamples.push({ clearBytes: 4 + clearHeader, cipherBytes: cipherLen });
    pos = nalStart + nalLength;
  }
  if (pos !== sample.length) {
    throw new Error(`视频样本存在 ${sample.length - pos} 字节尾部残余`);
  }
  return { data: out, subsamples };
}

function encryptAudioSample(sample, key, iv) {
  const keystream = ctrStream(key, iv, sample.length);
  const out = Buffer.alloc(sample.length);
  for (let i = 0; i < sample.length; i += 1) {
    out[i] = sample[i] ^ keystream[i];
  }
  return { data: out, subsamples: [{ clearBytes: 0, cipherBytes: sample.length }] };
}

function buildTenc(kidHex) {
  const body = Buffer.alloc(4 + 1 + 2 + 1 + 16);
  let p = 0;
  body.writeUInt32BE(0, p); p += 4;
  body[p] = 0; p += 1;
  body.writeUInt16BE(1, p); p += 2;
  body[p] = IV_SIZE; p += 1;
  Buffer.from(kidHex, 'hex').copy(body, p);
  return box('tenc', body);
}

function buildSinf(originalFormat) {
  const frma = box('frma', Buffer.from(originalFormat, 'latin1'));
  const schmBody = Buffer.alloc(4 + 4 + 4);
  schmBody.writeUInt32BE(0, 0);
  schmBody.write('cenc', 4, 'latin1');
  schmBody.writeUInt32BE(0x00010000, 8);
  const schm = box('schm', schmBody);
  const schi = box('schi', buildTenc(currentKid));
  return box('sinf', Buffer.concat([frma, schm, schi]));
}

let currentKid = null;

function transformSampleEntry(buf, entry) {
  const isVideo = entry.type === 'avc1' || entry.type === 'avc3';
  const originalFormat = entry.type;
  const headerAndFixed = buf.subarray(entry.off, entry.bodyStart + 8 + (isVideo ? 70 : 20));
  const rewrittenHeader = Buffer.from(headerAndFixed);
  rewrittenHeader.write(isVideo ? 'encv' : 'enca', 4, 'latin1');
  const childBoxes = buf.subarray(entry.bodyStart + 8 + (isVideo ? 70 : 20), entry.end);
  const sinf = buildSinf(originalFormat);
  const newBody = Buffer.concat([rewrittenHeader.subarray(8), childBoxes, sinf]);
  return box(isVideo ? 'encv' : 'enca', newBody);
}

function transformStsd(buf, stsdBox) {
  const innerHeader = buf.subarray(stsdBox.bodyStart, stsdBox.bodyStart + 8);
  const entries = parseChildren(buf, stsdBox.bodyStart + 8, stsdBox.end);
  const rebuilt = entries.map((e) => transformSampleEntry(buf, e));
  return box('stsd', Buffer.concat([innerHeader, ...rebuilt]));
}

function transformMoov(buf, moovBox, kidHex) {
  currentKid = kidHex;
  const parts = [];
  for (const child of parseChildren(buf, moovBox.bodyStart, moovBox.end)) {
    if (child.type === 'trak') {
      parts.push(transformTrak(buf, child));
    } else if (child.type === 'mvex') {
      parts.push(transformMvex(buf, child));
    } else {
      parts.push(buf.subarray(child.off, child.end));
    }
  }
  parts.push(buildPsshBox(kidHex, CLEARKEY_SYSTEM_ID));
  return box('moov', Buffer.concat(parts));
}

function transformTrak(buf, trakBox) {
  const parts = [];
  for (const child of parseChildren(buf, trakBox.bodyStart, trakBox.end)) {
    if (child.type === 'mdia') {
      parts.push(transformMdia(buf, child));
    } else {
      parts.push(buf.subarray(child.off, child.end));
    }
  }
  return box('trak', Buffer.concat(parts));
}

function transformMdia(buf, mdiaBox) {
  const parts = [];
  for (const child of parseChildren(buf, mdiaBox.bodyStart, mdiaBox.end)) {
    if (child.type === 'minf') {
      parts.push(transformMinf(buf, child));
    } else {
      parts.push(buf.subarray(child.off, child.end));
    }
  }
  return box('mdia', Buffer.concat(parts));
}

function transformMinf(buf, minfBox) {
  const parts = [];
  for (const child of parseChildren(buf, minfBox.bodyStart, minfBox.end)) {
    if (child.type === 'stbl') {
      parts.push(transformStbl(buf, child));
    } else {
      parts.push(buf.subarray(child.off, child.end));
    }
  }
  return box('minf', Buffer.concat(parts));
}

function transformStbl(buf, stblBox) {
  // Per-fragment traf boxes carry all CENC auxiliary info (WPT/CENC v1 layout);
  // the moov track-level stbl therefore keeps no senc/saiz/saio at all.
  const children = parseChildren(buf, stblBox.bodyStart, stblBox.end)
    .filter((c) => c.type !== 'senc' && c.type !== 'saio' && c.type !== 'saiz');
  const parts = [];
  for (const child of children) {
    if (child.type === 'stsd') {
      parts.push(transformStsd(buf, child));
    } else {
      parts.push(buf.subarray(child.off, child.end));
    }
  }
  return box('stbl', Buffer.concat(parts));
}

function transformMvex(buf, mvexBox) {
  const parts = [];
  for (const child of parseChildren(buf, mvexBox.bodyStart, mvexBox.end)) {
    if (child.type === 'trex') {
      const trex = Buffer.from(buf.subarray(child.off, child.end));
      trex.writeUInt32BE(1, 16);
      parts.push(trex);
    } else if (child.type === 'saiz' || child.type === 'saio' || child.type === 'senc') {
      continue;
    } else {
      parts.push(buf.subarray(child.off, child.end));
    }
  }
  return box('mvex', Buffer.concat(parts));
}

function parseTrun(buf, trunBox) {
  const version = buf[trunBox.bodyStart];
  const flags = buf.readUIntBE(trunBox.bodyStart + 1, 3);
  const count = buf.readUInt32BE(trunBox.bodyStart + 4);
  let p = trunBox.bodyStart + 8;
  let dataOffset = null;
  let firstSampleFlags = null;
  if (flags & 0x000001) {
    dataOffset = buf.readInt32BE(p);
    p += 4;
  }
  if (flags & 0x000004) {
    firstSampleFlags = buf.readUInt32BE(p);
    p += 4;
  }
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const s = {};
    if (flags & 0x000100) { s.duration = buf.readUInt32BE(p); p += 4; }
    if (flags & 0x000200) { s.size = buf.readUInt32BE(p); p += 4; }
    if (flags & 0x000400) { s.flags = buf.readUInt32BE(p); p += 4; }
    samples.push(s);
  }
  return { version, flags, count, dataOffset, firstSampleFlags, samples };
}

function buildTrun(parsed, newDataOffset, grownSamples) {
  const { version, flags, firstSampleFlags, samples } = parsed;
  const parts = [Buffer.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), u32(samples.length)];
  if (flags & 0x000001) parts.push(i32(newDataOffset));
  if (flags & 0x000004) parts.push(u32(firstSampleFlags));
  for (let i = 0; i < samples.length; i += 1) {
    const oldS = samples[i];
    const newS = grownSamples[i];
    if (flags & 0x000100) parts.push(u32(oldS.duration));
    if (flags & 0x000200) parts.push(u32(newS.size));
    if (flags & 0x000400) parts.push(u32(oldS.flags));
  }
  return box('trun', Buffer.concat(parts));
}

function buildSenc(entries) {
  // version=0, flags=0x2 (sample-encryption-info-present), sample_count then entries.
  const parts = [Buffer.from([0, 0, 0, 2]), u32(entries.length)];
  for (const { iv, subsamples } of entries) {
    parts.push(iv);
    parts.push(u16(subsamples.length));
    for (const { clearBytes, cipherBytes } of subsamples) {
      parts.push(u16(clearBytes));
      parts.push(u32(cipherBytes));
    }
  }
  return box('senc', Buffer.concat(parts));
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

// CENC v1 saiz: flags=0x1 carries aux_info_type='cenc'. Variable per-sample sizes
// (default_sample_info_size=0), so each entry's byte size is listed explicitly.
function buildSaiz(sampleInfoSizes) {
  const body = [
    Buffer.from([0, 0, 0, 1]),
    Buffer.from('cenc', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0]),
    u32(sampleInfoSizes.length),
  ];
  for (const size of sampleInfoSizes) {
    body.push(Buffer.from([size]));
  }
  return box('saiz', Buffer.concat(body));
}

// CENC v1 saio: version=1, flags=0x1, aux_info_type='cenc', one 64-bit offset.
// The offset is a placeholder (0) patched after the moof is assembled.
function buildSaioPlaceholder() {
  return box('saio', Buffer.concat([
    Buffer.from([1, 0, 0, 1]),
    Buffer.from('cenc', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    u32(1),
    Buffer.alloc(8),
  ]));
}

// Sample-to-group box binding every sample in the fragment to the seig group.
function buildSbgp(sampleCount) {
  return box('sbgp', Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('seig', 'latin1'),
    u32(1),
    Buffer.from([0, 0, 0, sampleCount & 0xff]),
    Buffer.from([0, 1, 0, 1]),
  ]));
}

// Sample-group description carrying the CENC encryption entry (KID + IV size).
// CencSampleEncryptionInformationGroupEntry (20 bytes):
//   reserved(2)=0, isProtected=1, perSampleIvSize=8, KID(16).
function buildSgpd(kidHex) {
  const entry = Buffer.concat([
    Buffer.from([0, 0, 1, IV_SIZE]),
    Buffer.from(kidHex, 'hex'),
  ]);
  return box('sgpd', Buffer.concat([
    Buffer.from([1, 0, 0, 0]),
    Buffer.from('seig', 'latin1'),
    u32(entry.length),
    u32(1),
    entry,
  ]));
}

function sencEntrySize(entry) {
  return IV_SIZE + 2 + entry.subsamples.length * 6;
}

function rewriteFragment(buf, moofBox, mdatBox, trackId, isVideo, key, kidHex, fragmentIndex) {
  const moofChildren = parseChildren(buf, moofBox.bodyStart, moofBox.end);
  const mfhd = findBox(moofChildren, 'mfhd');
  if (!mfhd) {
    throw new Error('moof 缺少必需的 mfhd 盒子');
  }
  const mfhdBox = buf.subarray(mfhd.off, mfhd.end);
  const trafBox = findBox(moofChildren, 'traf');
  const inner = parseChildren(buf, trafBox.bodyStart, trafBox.end);
  const tfhd = findBox(inner, 'tfhd');
  const tfdt = findBox(inner, 'tfdt');
  const trun = findBox(inner, 'trun');
  const parsed = parseTrun(buf, trun);

  const ivs = parsed.samples.map((_, i) => deriveIv(kidHex, fragmentIndex, i));
  const sencEntries = [];
  const encryptedSamples = [];
  let src = mdatBox.bodyStart;
  for (let i = 0; i < parsed.samples.length; i += 1) {
    const size = parsed.samples[i].size;
    const original = buf.subarray(src, src + size);
    const result = isVideo
      ? encryptVideoSample(original, key, ivs[i])
      : encryptAudioSample(original, key, ivs[i]);
    encryptedSamples.push(result.data);
    sencEntries.push({ iv: ivs[i], subsamples: result.subsamples });
    src += size;
  }
  if (src !== mdatBox.end) {
    throw new Error(`track ${trackId} mdat 样本大小与盒长度不一致`);
  }

  const sameSizeSamples = parsed.samples.map((s) => ({ ...s }));
  const newMdat = box('mdat', Buffer.concat(encryptedSamples));

  // CENC v1 traf layout (matches the canonical WPT ClearKey vector):
  //   tfhd, tfdt, sgpd(seig), sbgp(seig), saiz(cenc), saio(cenc,v1), trun, senc
  const sgpd = buildSgpd(kidHex);
  const sbgp = buildSbgp(parsed.samples.length);
  const newSaiz = buildSaiz(sencEntries.map(sencEntrySize));
  const newSaio = buildSaioPlaceholder();
  const newSenc = buildSenc(sencEntries);
  const newTrun = buildTrun(parsed, 0, sameSizeSamples); // data_offset patched below

  const finalMoof = box('moof', Buffer.concat([
    mfhdBox,
    box('traf', Buffer.concat([
      buf.subarray(tfhd.off, tfhd.end),
      tfdt ? buf.subarray(tfdt.off, tfdt.end) : Buffer.alloc(0),
      sgpd,
      sbgp,
      newSaiz,
      newSaio,
      newTrun,
      newSenc,
    ])),
  ]));

  // trun data_offset is relative to the moof start and points at the mdat
  // *payload* (after the 8-byte mdat header). tfhd carries default-base-is-moof.
  if (parsed.flags & 0x000001) {
    const trunBoxOffset = finalMoof.indexOf(Buffer.from('trun', 'latin1')) - 4;
    finalMoof.writeInt32BE(finalMoof.length + 8, trunBoxOffset + 8 + 8);
  }

  // saio points at the first senc ENTRY (moof-relative): box header(8) +
  // version/flags(4) + sample_count(4) = 16 bytes past the senc box start.
  const sencBoxOffset = finalMoof.indexOf(Buffer.from('senc', 'latin1')) - 4;
  const saioBoxOffset = finalMoof.indexOf(Buffer.from('saio', 'latin1')) - 4;
  const saioBoxSize = finalMoof.readUInt32BE(saioBoxOffset);
  finalMoof.writeBigUInt64BE(
    BigInt(sencBoxOffset + 16),
    saioBoxOffset + saioBoxSize - 8,
  );

  return { moof: finalMoof, mdat: newMdat, sampleCount: parsed.samples.length };
}

function classifyTracks(buf, moovBox) {
  const videoTracks = new Set();
  for (const trak of parseChildren(buf, moovBox.bodyStart, moovBox.end).filter((b) => b.type === 'trak')) {
    let trackId = null;
    let isVideo = false;
    const walk = (parent) => {
      for (const child of parseChildren(buf, parent.bodyStart, parent.end)) {
        if (child.type === 'tkhd') {
          trackId = buf.readUInt32BE(child.bodyStart + (buf[child.bodyStart] === 1 ? 16 : 12));
        }
        if (child.type === 'stsd') {
          const entries = parseChildren(buf, child.bodyStart + 8, child.end);
          isVideo = entries.some((e) => e.type === 'avc1' || e.type === 'avc3' || e.type === 'hev1' || e.type === 'hvc1');
        }
        if (['trak', 'mdia', 'minf', 'stbl'].includes(child.type)) {
          walk(child);
        }
      }
    };
    walk(trak);
    if (isVideo && trackId !== null) {
      videoTracks.add(trackId);
    }
  }
  return videoTracks;
}

function encryptSegment(inputBuf, kidHex, keyHex) {
  currentKid = kidHex;
  const top = parseChildren(inputBuf, 0, inputBuf.length);
  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  if (!ftyp || !moov) {
    throw new Error('分段缺少 ftyp/moov');
  }

  const videoTracks = classifyTracks(inputBuf, moov);

  const output = [
    inputBuf.subarray(ftyp.off, ftyp.end),
    transformMoov(inputBuf, moov, kidHex),
  ];

  const fragments = [];
  for (let i = 0; i < top.length; i += 1) {
    const b = top[i];
    if (b.type !== 'moof') {
      if (b.type === 'mfra') break;
      continue;
    }
    const mdat = top[i + 1];
    if (!mdat || mdat.type !== 'mdat') {
      throw new Error('moof 后未紧跟 mdat');
    }
    const traf = findBox(parseChildren(inputBuf, b.bodyStart, b.end), 'traf');
    const tfhd = findBox(parseChildren(inputBuf, traf.bodyStart, traf.end), 'tfhd');
    const trackId = inputBuf.readUInt32BE(tfhd.bodyStart + 4);
    fragments.push({ moofBox: b, mdatBox: mdat, trackId });
    i += 1;
  }

  fragments.forEach((f, fragmentIndex) => {
    const { moof, mdat: newMdat } = rewriteFragment(
      inputBuf, f.moofBox, f.mdatBox, f.trackId, videoTracks.has(f.trackId),
      keyHex, kidHex, fragmentIndex,
    );
    output.push(moof, newMdat);
  });
  return Buffer.concat(output);
}

module.exports = { encryptSegment, deriveIv, encryptVideoSample, encryptAudioSample };
