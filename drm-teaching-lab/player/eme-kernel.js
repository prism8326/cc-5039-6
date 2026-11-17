'use strict';

// Deterministic, well-formed 16-byte KID that is deliberately NOT registered in
// the local fictional course store, used only by the "unknown KID" drill.
const UNKNOWN_TEST_KID = '0000000000000000000000000000face';

const STATES = Object.freeze({
  IDLE: 'idle',
  CONFIGURING_MKS: 'configuring-media-keys',
  MKS_CONFIGURED: 'media-keys-configured',
  WAITING_LICENSE: 'waiting-license',
  LICENSE_RECEIVED: 'license-received',
  KEY_USABLE: 'key-usable',
  LOADING_SEGMENTS: 'loading-segments',
  DECODABLE: 'decodable',
  PLAYING: 'playing',
  LICENSE_FAILED: 'license-failed',
  KEY_ERROR: 'key-error',
  DECODE_ERROR: 'decode-error',
});

const STATE_LABELS = Object.freeze({
  [STATES.IDLE]: '空闲',
  [STATES.CONFIGURING_MKS]: '正在请求 MediaKeys…',
  [STATES.MKS_CONFIGURED]: 'MediaKeys 已配置（尚未取得许可）',
  [STATES.WAITING_LICENSE]: '加密事件触发，等待许可响应…',
  [STATES.LICENSE_RECEIVED]: '许可已取得（密钥可用性未确认）',
  [STATES.KEY_USABLE]: 'CDM 报告密钥 usable（尚未验证解码）',
  [STATES.LOADING_SEGMENTS]: '正在通过 MSE 喂入加密分段…',
  [STATES.DECODABLE]: '媒体实际可解码（已呈现画面）',
  [STATES.PLAYING]: '正在播放（真实呈现中）',
  [STATES.LICENSE_FAILED]: '许可取得失败',
  [STATES.KEY_ERROR]: '密钥不可用（如错误 KID/错误密钥）',
  [STATES.DECODE_ERROR]: '解码失败（加密链未打通）',
});

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parsePsshKIds(initData) {
  const kids = [];
  if (initData.byteLength < 32) {
    return kids;
  }
  const view = new DataView(initData);
  if (view.getUint32(0) !== initData.byteLength - 8) {
    return kids;
  }
  if (String.fromCharCode(...new Uint8Array(initData, 4, 4)) !== 'pssh') {
    return kids;
  }
  const version = view.getUint8(8);
  const dataSize = view.getUint32(12 + (version === 1 ? 16 : 0));
  if (version === 1 && dataSize === 16) {
    kids.push(new Uint8Array(initData, 32, 16));
  }
  return kids;
}

class EmeTeachingKernel {
  constructor({ video, licenseUrl, logger }) {
    this.video = video;
    this.licenseUrl = licenseUrl;
    this.logger = logger || (() => {});
    this.state = STATES.IDLE;
    this.listeners = new Set();
    this.mediaKeys = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.session = null;
    this.queue = [];
    this.streamEnded = false;
    this.firstFrameObserved = false;
    this.closed = false;
    this.encryptedReady = new Promise((resolve) => { this.resolveEncryptedReady = resolve; });
    this.milestones = { licenseReceived: false, keyUsable: false, decodable: false };
    this.pendingOptions = {};
  }

  onState(listener) {
    this.listeners.add(listener);
    listener(this.state, this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setState(next, detail) {
    this.state = next;
    this.logger(next, detail);
    for (const l of this.listeners) {
      l(next, this.snapshot(), detail);
    }
  }

  snapshot() {
    return { state: this.state, label: STATE_LABELS[this.state], milestones: { ...this.milestones } };
  }

  fail(stateName, detail) {
    this.setState(stateName, detail);
  }

  async configureMediaKeys(manifest) {
    this.setState(STATES.CONFIGURING_MKS);
    const config = [{
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: manifest.video.contentType, robustness: '' }],
      audioCapabilities: [{ contentType: manifest.audio.contentType, robustness: '' }],
      distinctiveIdentifier: 'not-allowed',
      persistentState: 'not-allowed',
      sessionTypes: ['temporary'],
    }];
    try {
      const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', config);
      this.mediaKeys = await access.createMediaKeys();
      await this.video.setMediaKeys(this.mediaKeys);
      this.setState(STATES.MKS_CONFIGURED, { keySystem: access.keySystem });
    } catch (e) {
      this.fail(STATES.LICENSE_FAILED, { phase: 'requestMediaKeySystemAccess', message: String(e) });
      throw e;
    }
  }

  // Build a structurally valid ClearKey PSSH v1 box whose KID is replaced by
  // unknownKidHex (a well-formed but unregistered identifier). This lets the
  // "unknown KID" drill reach the license server and be rejected with 404,
  // unlike raw initData tampering which corrupts the box before it is sent.
  buildPsshWithKid(originalPssh, unknownKidHex) {
    const view = new DataView(originalPssh);
    const size = view.getUint32(0);
    const out = new Uint8Array(originalPssh.slice(0, size));
    new DataView(out.buffer).setUint32(0, size);
    const version = out[8];
    const kidOffset = version === 1 ? 32 : 0;
    if (version !== 1 || kidOffset + 16 > size) {
      throw new Error('无法替换 KID：PSSH 不是预期的 v1 结构');
    }
    const kidBytes = unknownKidHex.match(/../g).map((h) => parseInt(h, 16));
    out.set(kidBytes, kidOffset);
    return out.buffer;
  }

  createSession(initData, { tamperInitData = false, unknownKidHex = null } = {}) {
    let effectiveInit = initData;
    if (unknownKidHex) {
      effectiveInit = this.buildPsshWithKid(initData, unknownKidHex);
      this.logger('unknown-kid-selected', { requestedKid: unknownKidHex });
    } else if (tamperInitData) {
      const copy = new Uint8Array(initData.byteLength);
      copy.set(new Uint8Array(initData));
      copy[copy.length - 1] ^= 0xff;
      effectiveInit = copy.buffer;
      this.logger('init-data-tampered', { originalKids: parsePsshKIds(initData).map((k) => b64url(k)) });
    }

    const session = this.mediaKeys.createSession('temporary');
    this.session = session;
    session.addEventListener('message', async (event) => {
      this.setState(STATES.WAITING_LICENSE, { messageType: event.messageType });
      try {
        const resp = await fetch(this.licenseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: event.message,
        });
        if (!resp.ok) {
          const text = await resp.text();
          this.fail(STATES.LICENSE_FAILED, { httpStatus: resp.status, body: text });
          this.resolveEncryptedReady(Promise.reject(new Error(`license HTTP ${resp.status}: ${text}`)));
          return;
        }
        const license = await resp.arrayBuffer();
        // HTTP 200 means the license response was obtained (milestone ①),
        // regardless of whether the CDM later accepts the contained key.
        this.milestones.licenseReceived = true;
        this.setState(STATES.LICENSE_RECEIVED, { note: '仅代表收到许可响应，不代表密钥可用或可解码' });
        try {
          await session.update(license);
        } catch (updateErr) {
          // A delivered-but-rejected license (e.g. deliberately wrong key) is a
          // key-level failure (milestone ②), not a license-delivery failure (①).
          if (this.closed) {
            return;
          }
          this.fail(STATES.KEY_ERROR, { phase: 'session.update', message: String(updateErr) });
          this.resolveEncryptedReady(Promise.reject(updateErr));
        }
      } catch (e) {
        if (this.closed) {
          return;
        }
        this.fail(STATES.LICENSE_FAILED, { phase: 'fetch/update', message: String(e) });
        this.resolveEncryptedReady(Promise.reject(e));
      }
    });
    session.addEventListener('keystatuseschange', () => {
      if (this.closed || this.session !== session) {
        return;
      }
      const statuses = [];
      session.keyStatuses.forEach((status, keyId) => {
        statuses.push({ kid: b64url(new Uint8Array(keyId)), status });
      });
      const allUsable = statuses.length > 0 && statuses.every((s) => s.status === 'usable');
      if (allUsable) {
        this.milestones.keyUsable = true;
        this.setState(STATES.KEY_USABLE, { statuses });
        this.resolveEncryptedReady(Promise.resolve());
      } else {
        this.fail(STATES.KEY_ERROR, { statuses });
        this.resolveEncryptedReady(Promise.reject(new Error(`key status: ${statuses.map((s) => s.status).join(',')}`)));
      }
    });
    return session.generateRequest('cenc', effectiveInit);
  }

  codecString(manifest) {
    return `video/mp4; codecs="${manifest.video.rfc6381}, ${manifest.audio.rfc6381}"`;
  }

  addSourceBuffer(mediaSource, manifest) {
    const sb = mediaSource.addSourceBuffer(this.codecString(manifest));
    sb.mode = 'segments';
    sb.addEventListener('updateend', () => this.pumpQueue());
    return sb;
  }

  extractPsshFromSegment(chunk) {
    const view = new DataView(chunk);
    let off = 0;
    while (off + 8 <= chunk.byteLength) {
      let size = view.getUint32(off);
      const type = String.fromCharCode(...new Uint8Array(chunk, off + 4, 4));
      if (size === 1) {
        size = Number(view.getBigUint64(off + 8));
      }
      if (size < 8 || off + size > chunk.byteLength) {
        break;
      }
      if (type === 'moov') {
        return this.findPssh(chunk, off + 8, off + size);
      }
      off += size;
    }
    return null;
  }

  findPssh(buf, start, end) {
    const view = new DataView(buf);
    let off = start;
    while (off + 8 <= end) {
      let size = view.getUint32(off);
      const type = String.fromCharCode(...new Uint8Array(buf, off + 4, 4));
      if (size === 1) {
        size = Number(view.getBigUint64(off + 8));
      }
      if (size < 8 || off + size > end) {
        break;
      }
      if (type === 'pssh') {
        return buf.slice(off, off + size);
      }
      off += size;
    }
    return null;
  }

  async establishSessionFromPssh(chunk) {
    const pssh = this.extractPsshFromSegment(chunk);
    if (!pssh) {
      throw new Error('初始化分段中未找到 PSSH，无法生成 EME initData');
    }
    this.logger('pssh-extracted', { bytes: pssh.byteLength });
    await this.createSession(pssh, this.pendingOptions);
    return this.encryptedReady;
  }

  async run(manifest, baseUrl, options = {}) {
    this.pendingOptions = options;
    this.bindDecodeObservation();
    await this.configureMediaKeys(manifest);

    const chunks = [];
    for (const seg of manifest.segments) {
      const resp = await fetch(`${baseUrl}/${seg.url}`);
      if (!resp.ok) {
        this.fail(STATES.DECODE_ERROR, { phase: 'fetch-segment', url: seg.url, httpStatus: resp.status });
        return;
      }
      chunks.push(await resp.arrayBuffer());
    }

    try {
      await this.establishSessionFromPssh(chunks[0]);
    } catch (e) {
      this.fail(STATES.LICENSE_FAILED, { phase: 'establish-session', message: String(e.message || e) });
      return;
    }

    this.setState(STATES.LOADING_SEGMENTS);
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.video.src = URL.createObjectURL(mediaSource);
    await new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true });
      mediaSource.addEventListener('sourceopenerror', reject, { once: true });
    });

    this.sourceBuffer = this.addSourceBuffer(mediaSource, manifest);
    this.queue = [...chunks];
    this.streamEnded = true;
    this.pumpQueue();
  }

  pumpQueue() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) {
      if (this.streamEnded && this.sourceBuffer && !this.sourceBuffer.updating && this.queue.length === 0 && this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
      return;
    }
    const chunk = this.queue.shift();
    try {
      this.sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      this.queue.unshift(chunk);
      this.fail(STATES.DECODE_ERROR, { phase: 'appendBuffer', message: String(e) });
    }
  }

  bindDecodeObservation() {
    this.video.addEventListener('loadeddata', () => {
      if (!this.firstFrameObserved) {
        this.firstFrameObserved = true;
        this.milestones.decodable = true;
        this.setState(STATES.DECODABLE, {
          note: '视频元素已拿到可解码数据，加密链端到端打通',
          videoWidth: this.video.videoWidth,
          videoHeight: this.video.videoHeight,
        });
      }
    });
    this.video.addEventListener('playing', () => this.setState(STATES.PLAYING, { currentTime: this.video.currentTime }));
    this.video.addEventListener('error', () => {
      if (!this.milestones.keyUsable) {
        this.logger('media-error-before-keys', { note: '密钥就绪前的媒体错误将在重建 SourceBuffer 后恢复' });
        return;
      }
      this.fail(STATES.DECODE_ERROR, {
        phase: 'media-element',
        code: this.video.error && this.video.error.code,
        message: this.video.error && this.video.error.message,
      });
    });
  }

  async reset() {
    this.closed = true;
    try {
      if (this.session && this.session.close) {
        await this.session.close();
      }
    } catch { /* ignore */ }
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch { /* ignore */ }
    }
    this.video.removeAttribute('src');
    this.video.load();
    this.session = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.streamEnded = false;
    this.firstFrameObserved = false;
    this.milestones = { licenseReceived: false, keyUsable: false, decodable: false };
    this.encryptedReady = new Promise((resolve) => { this.resolveEncryptedReady = resolve; });
    this.setState(STATES.IDLE);
  }
}

window.EmeTeachingKernel = EmeTeachingKernel;
window.EME_STATES = STATES;
window.EME_STATE_LABELS = STATE_LABELS;
window.EME_UNKNOWN_TEST_KID = UNKNOWN_TEST_KID;
