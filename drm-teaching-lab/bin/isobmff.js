'use strict';

function readUint32(buf, off) {
  return buf.readUInt32BE(off);
}

function readType(buf, off) {
  return buf.toString('latin1', off, off + 4);
}

function parseBoxes(buf, start, end, depth = 0) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = readUint32(buf, off);
    const type = readType(buf, off + 4);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) {
      break;
    }
    boxes.push({ type, offset: off, size, header, depth, bodyStart: off + header, bodyEnd: off + size });
    off += size;
  }
  return boxes;
}

const CONTAINER_TYPES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf',
  'sinf', 'schi', 'mfra', 'skip', 'meco',
]);

const SAMPLE_ENTRY_TYPES = new Set([
  'encv', 'enca', 'avc1', 'avc3', 'mp4a', 'hev1', 'hvc1', 'vp09', 'av01',
]);

function parseBoxes(buf, start, end, depth = 0, skipSampleEntryHeader = false) {
  const boxes = [];
  let off = start;
  if (skipSampleEntryHeader) {
    off += 8;
  }
  while (off + 8 <= end) {
    let size = readUint32(buf, off);
    const type = readType(buf, off + 4);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) {
      break;
    }
    boxes.push({ type, offset: off, size, header, depth, bodyStart: off + header, bodyEnd: off + size });
    off += size;
  }
  return boxes;
}

function walk(buf, start, end, depth, visit) {
  let off = start;
  while (off + 8 <= end) {
    let size = readUint32(buf, off);
    const type = readType(buf, off + 4);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) {
      break;
    }
    const box = { type, offset: off, size, header, depth, bodyStart: off + header, bodyEnd: off + size };
    visit(box);
    if (CONTAINER_TYPES.has(type)) {
      walk(buf, box.bodyStart, box.bodyEnd, depth + 1, visit);
    } else if (type === 'stsd') {
      walk(buf, box.bodyStart + 8, box.bodyEnd, depth + 1, visit);
    } else if (SAMPLE_ENTRY_TYPES.has(type)) {
      walkSampleEntry(buf, box, depth + 1, visit);
    }
    off += size;
  }
}

function walkSampleEntry(buf, box, depth, visit) {
  const sampleEntryFixed = 8;
  const visualHeader = box.type === 'enca' || box.type === 'mp4a' ? 20 : 70;
  const childStart = box.bodyStart + sampleEntryFixed + visualHeader;
  if (childStart < box.bodyEnd) {
    walk(buf, childStart, box.bodyEnd, depth, visit);
  }
}

function summarize(buf) {
  const found = new Set();
  const details = [];
  walk(buf, 0, buf.length, 0, (box) => {
    found.add(box.type);
    if (box.type === 'frma') {
      details.push({ box: 'frma', originalFormat: buf.toString('latin1', box.bodyStart, box.bodyStart + 4) });
    }
    if (box.type === 'schm') {
      details.push({
        box: 'schm',
        scheme: buf.toString('latin1', box.bodyStart + 4, box.bodyStart + 8),
        schemeVersion: readUint32(buf, box.bodyStart),
      });
    }
    if (box.type === 'tenc') {
      const p = box.bodyStart;
      const version = buf[p];
      const flags = buf.readUIntBE(p + 1, 3);
      let q = p + 4;
      let isProtected = null;
      let perSampleIvSize = null;
      let kid = null;
      if (version === 0) {
        q += 1;
        isProtected = buf.readUInt16BE(q); q += 2;
        perSampleIvSize = buf[q]; q += 1;
        kid = buf.toString('hex', q, q + 16); q += 16;
      }
      details.push({ box: 'tenc', version, flags, isProtected, perSampleIvSize, kid });
    }
  });
  return { boxes: [...found], details };
}

function hasEncryptionBoxes(buf) {
  const { boxes, details } = summarize(buf);
  const tenc = details.find((d) => d.box === 'tenc');
  return {
    isEncrypted: boxes.includes('sinf') && boxes.includes('tenc') && boxes.includes('frma'),
    hasEncryptedSampleEntry: boxes.includes('encv') || boxes.includes('enca'),
    hasSaiz: boxes.includes('saiz'),
    hasSaio: boxes.includes('saio'),
    hasPssh: boxes.includes('pssh'),
    tenc,
    allBoxes: boxes,
  };
}

function findTopLevelBox(buf, type) {
  return parseBoxes(buf, 0, buf.length).find((b) => b.type === type) || null;
}

function buildPsshBox(kidHex, systemIdHex = '1077efecc0b24d02ace33c1e52e2fb4b') {
  const systemId = Buffer.from(systemIdHex, 'hex');
  const kid = Buffer.from(kidHex, 'hex');
  if (systemId.length !== 16 || kid.length !== 16) {
    throw new Error('SystemID 与 KID 必须各为 16 字节');
  }
  const body = Buffer.alloc(4 + 16 + 4 + 16 + 4);
  let p = 0;
  body.writeUInt8(1, p); p += 1;
  body.writeUIntBE(0, p, 3); p += 3;
  systemId.copy(body, p); p += 16;
  body.writeUInt32BE(1, p); p += 4;
  kid.copy(body, p); p += 16;
  body.writeUInt32BE(0, p); p += 4;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write('pssh', 4, 'latin1');
  return Buffer.concat([header, body]);
}

function injectPsshIntoMoov(buf, kidHex) {
  const moov = findTopLevelBox(buf, 'moov');
  if (!moov) {
    throw new Error('文件缺少 moov 盒子，无法注入 PSSH');
  }
  const pssh = buildPsshBox(kidHex);
  const moovHeader = buf.subarray(moov.offset, moov.bodyStart);
  const updatedHeader = Buffer.from(moovHeader);
  updatedHeader.writeUInt32BE(moov.size + pssh.length, 0);
  return Buffer.concat([
    buf.subarray(0, moov.offset),
    updatedHeader,
    pssh,
    buf.subarray(moov.bodyStart),
  ]);
}

module.exports = { parseBoxes, walk, summarize, hasEncryptionBoxes, buildPsshBox, injectPsshIntoMoov, findTopLevelBox };
