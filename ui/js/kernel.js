import {
  STAGE_IDS,
  createStageState,
  overallVerdict,
  reasonText,
  SERVER_OUTCOME_REASONS
} from "../../shared/stages.js";

const DEFAULT_TIMEOUT_MS = 4000;
const DECODE_TIMEOUT_MS = 12000;
const KEY_STATUS_TIMEOUT_MS = 3000;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function shortHex(hex, head = 8) {
  return typeof hex === "string" && hex.length > head ? `${hex.slice(0, head)}…` : hex;
}

function rewritePsshKid(boxBytes, kidHex) {
  const bytes = new Uint8Array(boxBytes);
  const view = new DataView(bytes.buffer);
  const version = view.getUint8(8);
  if (version === 0) {
    bytes.set(hexToBytes(kidHex), bytes.length - 16);
  } else {
    const kidCount = view.getUint32(28);
    if (kidCount < 1) throw new Error("pssh 中没有可改写的密钥标识");
    bytes.set(hexToBytes(kidHex), 32);
  }
  return bytes;
}

function decodePssh(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StageError extends Error {
  constructor(stage, reason, message, evidence) {
    super(message ?? reason);
    this.stage = stage;
    this.reason = reason;
    this.evidence = evidence ?? null;
  }
}

export class EncryptionLab {
  constructor({ video, course, fetchImpl, onEvent = () => {} }) {
    this.video = video;
    this.course = course;
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onEvent = onEvent;
    this.manifest = null;
    this.scenario = null;
    this.rows = {};
    this.activeRun = 0;
    this.media = null;
    this.playback = null;
    this.abortController = null;
    this.lastOutcome = null;
  }

  emit(type, payload = {}) {
    this.onEvent({ type, ...payload });
  }

  setStage(id, state, { reason = null, evidence = null } = {}) {
    if (!this.rows[id]) return;
    this.rows[id] = { state, reason, evidence };
    this.emit("stage", { id, state, reason, evidence, stages: this.snapshotStages() });
  }

  snapshotStages() {
    return Object.fromEntries(
      STAGE_IDS.map((id) => [id, { state: this.rows[id]?.state ?? "pending", reason: this.rows[id]?.reason ?? null, evidence: this.rows[id]?.evidence ?? null }])
    );
  }

  reset(stages = createStageState()) {
    this.rows = Object.fromEntries(
      STAGE_IDS.map((id) => {
        const s = stages[id] ?? { state: "pending" };
        return [id, { state: s.state ?? "pending", reason: s.reason ?? null, evidence: s.evidence ?? null }];
      })
    );
    this.emit("stages", { stages: this.snapshotStages() });
  }

  async loadManifest() {
    if (this.manifest) return this.manifest;
    const response = await this.fetch(this.course.mediaAsset.manifest, { cache: "no-store" });
    if (!response.ok) throw new Error(`无法读取媒体清单：HTTP ${response.status}`);
    this.manifest = await response.json();
    return this.manifest;
  }

  capabilityConfig() {
    const manifest = this.manifest;
    return [
      {
        initDataTypes: ["cenc"],
        videoCapabilities: [{ contentType: manifest.tracks.video.mimeType }],
        audioCapabilities: [{ contentType: manifest.tracks.audio.mimeType }],
        sessionTypes: ["temporary"]
      }
    ];
  }

  abort() {
    this.activeRun += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.teardownPlayback();
    return this.activeRun;
  }

  teardownPlayback() {
    if (this.playback) {
      try {
        this.video.pause();
      } catch {
        /* 播放器可能尚未就绪 */
      }
      this.playback.detach();
      this.playback = null;
    }
    try {
      this.video.removeAttribute("src");
      this.video.load();
    } catch {
      /* 忽略清理错误 */
    }
    if (this.session) {
      try {
        this.session.close().catch(() => {});
      } catch {
        /* 会话可能已关闭 */
      }
      this.session = null;
    }
  }

  async run(scenario, { credentialId } = {}) {
    const runId = ++this.activeRun;
    this.abortController = new AbortController();
    this.scenario = scenario;
    this.teardownPlayback();
    this.reset();
    this.lastOutcome = null;
    this.emit("run-start", { scenario: { id: scenario.id, label: scenario.label } });

    const credential =
      this.course.credentials.find((c) => c.id === (credentialId ?? scenario.credentialId)) ??
      this.course.credentials[0];

    const context = {
      runId,
      scenario,
      credential,
      startedAt: performance.now(),
      evidence: {}
    };

    try {
      await this.loadManifest();
      if (runId !== this.activeRun) return this.stopped(context);

      await this.stageSupport(context);
      await this.stageSession(context);
      await this.stageLicense(context);
      await this.stageKey(context);
      await this.stageDecode(context);

      if (runId !== this.activeRun) return this.stopped(context);
      return this.finish(context, { ok: true });
    } catch (error) {
      if (runId !== this.activeRun) return this.stopped(context);
      if (error instanceof StageError) {
        this.failFrom(context, error);
        return this.finish(context, { ok: false, stage: error.stage, reason: error.reason });
      }
      this.setStage("decode", "failed", { reason: "internal-error", evidence: error?.message ?? null });
      this.blockAfter("decode");
      return this.finish(context, { ok: false, stage: "decode", reason: "internal-error" });
    }
  }

  stopped(context) {
    this.emit("run-stopped", {});
    return { ok: false, stopped: true, scenario: context.scenario.id };
  }

  finish(context, outcome) {
    const keepMedia = outcome.ok === true;
    if (!keepMedia) this.teardownPlayback();
    this.abortController = null;
    this.lastOutcome = {
      ...outcome,
      scenarioId: context.scenario.id,
      elapsedMs: Math.round(performance.now() - context.startedAt)
    };
    this.emit("run-end", { outcome: this.lastOutcome, stages: this.snapshotStages() });
    return this.lastOutcome;
  }

  failFrom(context, error) {
    this.setStage(error.stage, "failed", { reason: error.reason, evidence: error.evidence });
    this.blockAfter(error.stage);
    this.emit("failure", {
      stage: error.stage,
      reason: error.reason,
      text: reasonText(error.reason),
      evidence: error.evidence,
      scenarioId: context.scenario.id
    });
  }

  blockAfter(stageId) {
    const index = STAGE_IDS.indexOf(stageId);
    for (const id of STAGE_IDS.slice(index + 1)) {
      const current = this.rows[id]?.state;
      if (current === "passed") continue;
      this.setStage(id, "blocked", { reason: "upstream-failed" });
    }
  }

  async stageSupport(context) {
    this.setStage("support", "active");
    if (!("requestMediaKeySystemAccess" in navigator)) {
      throw new StageError("support", "unsupported-key-system", null, "navigator.requestMediaKeySystemAccess 不存在");
    }
    if (!window.isSecureContext) {
      throw new StageError("support", "unsupported-key-system", null, "当前上下文不是安全上下文");
    }
    try {
      const access = await navigator.requestMediaKeySystemAccess(
        this.course.license.keySystem,
        this.capabilityConfig()
      );
      context.access = access;
      const config = access.getConfiguration();
      const videoType = config.videoCapabilities?.[0]?.contentType ?? "未知";
      this.setStage("support", "passed", {
        evidence: `${access.keySystem} · ${videoType}`
      });
      this.emit("support", {
        keySystem: access.keySystem,
        label: this.course.license.keySystemLabel,
        videoType
      });
    } catch (error) {
      const reason =
        error?.name === "NotSupportedError" ? "unsupported-media-capability" : "unsupported-key-system";
      throw new StageError("support", reason, null, `${error?.name ?? "Error"}: ${error?.message ?? ""}`.trim());
    }
  }

  async stageSession(context) {
    this.setStage("session", "active");
    const { scenario } = context;
    const sessionType = scenario.sessionType ?? "temporary";
    let mediaKeys;
    try {
      mediaKeys = await context.access.createMediaKeys();
    } catch (error) {
      throw new StageError("session", "session-error", null, `createMediaKeys 失败：${error?.name}`);
    }
    context.mediaKeys = mediaKeys;
    try {
      await this.video.setMediaKeys(mediaKeys);
    } catch (error) {
      throw new StageError("session", "session-error", null, `setMediaKeys 失败：${error?.name}`);
    }
    let session;
    try {
      session = mediaKeys.createSession(sessionType);
    } catch (error) {
      const reason =
        error?.name === "NotSupportedError" ? "session-unsupported" : "session-failed";
      throw new StageError(
        "session",
        reason,
        null,
        `createSession('${sessionType}') → ${error?.name ?? "Error"}`
      );
    }
    context.session = session;
    context.sessionType = sessionType;
    this.session = session;
    this.setStage("session", "passed", { evidence: `会话类型 ${sessionType}` });
  }

  async stageLicense(context) {
    this.setStage("license", "active");
    const { session, scenario, credential } = context;
    const manifest = this.manifest;
    const packagedPssh = decodePssh(manifest.initData.boxBase64);

    let initData = new Uint8Array(packagedPssh);
    let initDataNote = "初始化数据与封装一致";
    let requestedKid = manifest.initData.kidHex;

    if (scenario.initDataMode === "tampered-kid") {
      const tampered = scenario.tamperedKidHex;
      if (!/^[0-9a-f]{32}$/i.test(tampered ?? "")) {
        throw new StageError("license", "internal-error", null, "场景没有提供合法的篡改标识");
      }
      initData = rewritePsshKid(packagedPssh, tampered.toLowerCase());
      requestedKid = tampered.toLowerCase();
      initDataNote = `初始化数据已被改动：pssh KID ${shortHex(requestedKid)}`;
    } else if (credential.kidHex !== manifest.initData.kidHex) {
      initData = rewritePsshKid(packagedPssh, credential.kidHex);
      requestedKid = credential.kidHex;
      initDataNote = `使用所选凭据标识 ${shortHex(requestedKid)} 生成初始化数据（与封装标识不同）`;
    } else {
      initDataNote = `所选凭据标识 ${shortHex(requestedKid)} 与封装清单一致`;
    }
    context.initDataNote = initDataNote;
    context.requestedKid = requestedKid;
    this.emit("license-init", { note: initDataNote, kid: requestedKid });

    const messagePromise = new Promise((resolve, reject) => {
      const onMessage = (event) => {
        cleanup();
        resolve(event.message);
      };
      const onMessageError = () => {
        cleanup();
        reject(new Error("license message error"));
      };
      const onError = () => {
        cleanup();
        reject(new Error("MediaKeySession error before license request"));
      };
      function cleanup() {
        session.removeEventListener("message", onMessage);
        session.removeEventListener("messageerror", onMessageError);
        session.removeEventListener("error", onError);
      }
      session.addEventListener("message", onMessage);
      session.addEventListener("messageerror", onMessageError);
      session.addEventListener("error", onError);
    });

    try {
      await session.generateRequest("cenc", initData);
    } catch (error) {
      throw new StageError(
        "license",
        "generate-request-failed",
        null,
        `generateRequest('cenc') → ${error?.name ?? "Error"}: ${error?.message ?? ""}`.trim()
      );
    }

    let message;
    try {
      message = await Promise.race([
        messagePromise,
        wait(DEFAULT_TIMEOUT_MS).then(() => {
          throw new Error("等待许可请求消息超时");
        })
      ]);
    } catch (error) {
      throw new StageError("license", "generate-request-failed", null, error.message);
    }

    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(message));
    } catch {
      throw new StageError("license", "malformed-response", null, "浏览器给出的许可请求不是 JSON");
    }
    const kids = Array.isArray(parsed.kids) ? parsed.kids : [];
    const messageKids = kids.map((kid) => bytesToHex(base64UrlToBytes(kid)));
    context.messageKids = messageKids;
    if (!messageKids.includes(requestedKid)) {
      throw new StageError(
        "license",
        "license-not-matching-init-data",
        null,
        `许可请求标识与初始化数据不一致：${messageKids.map((k) => shortHex(k)).join(", ") || "无"}`
      );
    }

    const requestBody = {
      assetId: this.manifest.assetId,
      kids,
      sessionType: context.sessionType,
      keySystem: this.course.license.keySystem,
      player: "graphical-player"
    };

    const target = scenario.licenseTarget === "offline" ? this.offlineEndpoint() : this.course.license.endpointPath;
    let response;
    try {
      response = await this.fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      });
    } catch (error) {
      throw new StageError(
        "license",
        "network-error",
        null,
        `许可端不可达（${target}）：${error?.name ?? "Error"}`
      );
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const serverReason = payload?.error;
      const reason = SERVER_OUTCOME_REASONS[serverReason] ?? "http-error";
      throw new StageError(
        "license",
        reason,
        null,
        `HTTP ${response.status}${serverReason ? ` · ${serverReason}` : ""}${
          payload?.requestId ? ` · 请求 ${payload.requestId}` : ""
        }`
      );
    }

    if (!payload || !Array.isArray(payload.keys) || payload.keys.length === 0) {
      throw new StageError("license", "malformed-response", null, "许可响应缺少 keys");
    }

    const matched = payload.keys.every((key) => {
      if (key?.kty !== "oct" || typeof key.kid !== "string" || typeof key.k !== "string") return false;
      return bytesToHex(base64UrlToBytes(key.kid)) === requestedKid;
    });
    if (!matched) {
      throw new StageError(
        "license",
        "license-not-matching-init-data",
        null,
        "许可响应中的密钥标识与初始化数据不一致"
      );
    }

    let licenseBytes = new TextEncoder().encode(JSON.stringify(payload));
    let keyMaterialNote = "许可响应与初始化数据匹配";

    if (scenario.licenseTransform === "corrupt-key-material") {
      const corrupted = {
        ...payload,
        keys: payload.keys.map((key) => ({
          ...key,
          k: bytesToBase64Url(new Uint8Array(16).fill(0x5a))
        }))
      };
      licenseBytes = new TextEncoder().encode(JSON.stringify(corrupted));
      keyMaterialNote = "诊断：许可响应 200，但客户端把密钥材料替换为错误值";
    }

    context.license = payload;
    context.licenseBytes = licenseBytes;
    context.requestId = payload.requestId ?? null;
    this.setStage("license", "passed", {
      evidence: `HTTP ${response.status} · 请求 ${payload.requestId ?? "未提供"} · ${keyMaterialNote}`
    });
    this.emit("license", {
      requestId: payload.requestId ?? null,
      keyCount: payload.keys.length,
      note: keyMaterialNote,
      endpoint: target
    });
  }

  offlineEndpoint() {
    const url = new URL(this.course.license.endpointPath, window.location.href);
    url.port = String(Number(url.port || (url.protocol === "https:" ? 443 : 80)) + 1000);
    url.pathname = "/api/license-offline";
    return url.toString();
  }

  async stageKey(context) {
    this.setStage("key", "active");
    const { session } = context;
    const expected = context.requestedKid;

    const statuses = new Map();
    const collect = () => {
      for (const [kidBuffer, status] of session.keyStatuses) {
        statuses.set(bytesToHex(new Uint8Array(kidBuffer)), status);
      }
      return statuses;
    };

    try {
      await session.update(context.licenseBytes);
    } catch (error) {
      throw new StageError(
        "key",
        "key-not-usable",
        null,
        `session.update 受到拒绝：${error?.name ?? "Error"}: ${error?.message ?? ""}`.trim()
      );
    }

    const deadline = performance.now() + KEY_STATUS_TIMEOUT_MS;
    let status = statuses.get(expected);
    while (performance.now() < deadline) {
      status = collect().get(expected);
      if (status === "usable") break;
      await wait(50);
    }
    collect();

    const observed = [...statuses.entries()];
    const evidenceText =
      observed.length === 0
        ? "未观察到密钥状态"
        : observed.map(([kid, st]) => `${shortHex(kid)}:${st}`).join(" · ");

    if (status === undefined) {
      throw new StageError("key", "key-status-missing", null, evidenceText);
    }
    if (status !== "usable") {
      throw new StageError("key", "key-not-usable", null, `密钥状态为 ${status}`);
    }

    context.keystatuses = observed;
    this.setStage("key", "passed", { evidence: evidenceText });
    this.emit("key", { statuses: observed, kid: expected });
  }

  async stageDecode(context) {
    this.setStage("decode", "active");
    const manifest = this.manifest;
    const base = new URL(this.course.mediaAsset.manifest, window.location.href);
    const baseDir = new URL("./", base);

    const codecs = [manifest.tracks.video, manifest.tracks.audio];

    // 通过实际取回初始化段与分片来确认加密封装可访问
    const initSegments = {};
    const segmentLists = {};
    for (const track of ["video", "audio"]) {
      const descriptor = manifest.tracks[track];
      const initName = descriptor.initSegment;
      try {
        const initResponse = await this.fetch(new URL(initName, baseDir), { cache: "no-store" });
        if (!initResponse.ok) throw new Error(`HTTP ${initResponse.status}`);
        initSegments[track] = await initResponse.arrayBuffer();
      } catch (error) {
        throw new StageError(
          "decode",
          "media-fetch-failed",
          null,
          `${track} 初始化段不可用：${error?.message ?? error}`
        );
      }
      segmentLists[track] = [];
      for (const segment of descriptor.segments) {
        try {
          const response = await this.fetch(new URL(segment.file, baseDir), { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          segmentLists[track].push({ name: segment.file, buffer });
        } catch (error) {
          throw new StageError(
            "decode",
            "media-fetch-failed",
            null,
            `${segment.file} 不可用：${error?.message ?? error}`
          );
        }
      }
    }

    // MSE 追加与播放
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    this.video.src = objectUrl;
    this.video.muted = true;

    let sourceBuffers = [];
    let detachHandlers = [];

    const cleanup = () => {
      for (const off of detachHandlers) off();
      detachHandlers = [];
      try {
        this.video.pause();
      } catch {
        /* 忽略 */
      }
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        /* 忽略 */
      }
      URL.revokeObjectURL(objectUrl);
    };

    this.playback = { detach: cleanup };

    const sourceOpen = new Promise((resolve, reject) => {
      const onOpen = () => {
        mediaSource.removeEventListener("sourceopen", onOpen);
        resolve();
      };
      const onError = () => {
        mediaSource.removeEventListener("sourceopen", onOpen);
        reject(new Error("MediaSource 打开失败"));
      };
      mediaSource.addEventListener("sourceopen", onOpen);
      mediaSource.addEventListener("error", onError, { once: true });
    });

    try {
      await Promise.race([sourceOpen, wait(DECODE_TIMEOUT_MS)]);
    } catch (error) {
      throw new StageError("decode", "media-append-failed", null, error.message);
    }
    if (mediaSource.readyState !== "open") {
      throw new StageError("decode", "media-append-failed", null, "MediaSource 未能进入 open 状态");
    }

    try {
      for (const track of codecs) {
        const kind = track.mimeType.startsWith("audio") ? "audio" : "video";
        const buffer = mediaSource.addSourceBuffer(track.mimeType);
        sourceBuffers.push({ kind, buffer });
      }
    } catch (error) {
      throw new StageError(
        "decode",
        "unsupported-media-capability",
        null,
        `MediaSource 不支持该编解码配置：${error?.name ?? error}`
      );
    }

    const appendBuffer = async ({ kind, buffer }, bytes, label) => {
      await new Promise((resolve, reject) => {
        const onUpdate = () => {
          cleanupListeners();
          resolve();
        };
        const onError = () => {
          cleanupListeners();
          reject(new Error(`${label} 追加失败`));
        };
        const cleanupListeners = () => {
          buffer.removeEventListener("updateend", onUpdate);
          buffer.removeEventListener("error", onError);
        };
        buffer.addEventListener("updateend", onUpdate);
        buffer.addEventListener("error", onError);
        try {
          buffer.appendBuffer(bytes);
        } catch (error) {
          cleanupListeners();
          reject(error);
        }
      });
    };

    try {
      for (const entry of sourceBuffers) {
        await appendBuffer(entry, initSegments[entry.kind], `${entry.kind} 初始化段`);
      }
      const maxSegments = Math.max(
        segmentLists.video.length,
        segmentLists.audio.length
      );
      for (let index = 0; index < maxSegments; index += 1) {
        for (const entry of sourceBuffers) {
          const segment = segmentLists[entry.kind][index];
          if (segment) {
            await appendBuffer(entry, segment.buffer, segment.name);
          }
        }
      }
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
    } catch (error) {
      const mediaError = this.video.error;
      throw new StageError(
        "decode",
        mediaError ? "media-decode-failed" : "media-append-failed",
        null,
        mediaError ? `${mediaError.code}: ${mediaError.message}` : error.message
      );
    }

    const playPromise = this.video.play();
    let playBlocked = false;
    try {
      await Promise.race([playPromise, wait(1500)]);
    } catch (error) {
      if (error?.name === "NotAllowedError") {
        playBlocked = true;
      } else if (error?.name === "AbortError") {
        // 有些环境在加载阶段对 play() 报 AbortError，继续观察实际帧
      } else {
        throw new StageError("decode", "media-append-failed", null, `play() 失败：${error?.name}`);
      }
    }

    const frames = new Promise((resolve, reject) => {
      const deadline = performance.now() + DECODE_TIMEOUT_MS;
      let frameCount = 0;
      let callbackId = null;
      let settled = false;

      const check = () => {
        if (settled) return;
        const mediaError = this.video.error;
        if (mediaError) {
          settled = true;
          if (callbackId !== null) this.video.cancelVideoFrameCallback?.(callbackId);
          reject(new StageError("decode", "media-decode-failed", null, `${mediaError.code}: ${mediaError.message}`));
          return;
        }
        if (frameCount >= 3 && this.video.currentTime > 0.25) {
          settled = true;
          if (callbackId !== null) this.video.cancelVideoFrameCallback?.(callbackId);
          resolve({ frameCount, currentTime: this.video.currentTime });
          return;
        }
        if (performance.now() > deadline) {
          settled = true;
          if (callbackId !== null) this.video.cancelVideoFrameCallback?.(callbackId);
          if (playBlocked) {
            reject(new StageError("decode", "play-blocked", null, "浏览器阻止自动播放"));
          } else {
            reject(
              new StageError(
                "decode",
                "media-no-frames",
                null,
                `frames=${frameCount} currentTime=${this.video.currentTime.toFixed(2)} readyState=${this.video.readyState}`
              )
            );
          }
          return;
        }
        if (typeof this.video.requestVideoFrameCallback === "function" && callbackId === null) {
          callbackId = this.video.requestVideoFrameCallback(() => {
            callbackId = null;
            frameCount += 1;
            check();
          });
        } else {
          setTimeout(check, 120);
        }
      };
      check();
    });

    let evidence;
    try {
      evidence = await frames;
    } catch (error) {
      throw error;
    }

    this.playback = { detach: cleanup };
    this.setStage("decode", "passed", {
      evidence: `已解码 ${evidence.frameCount}+ 帧 · 播放位置 ${evidence.currentTime.toFixed(2)}s`
    });
    this.emit("decode", {
      frames: evidence.frameCount,
      currentTime: evidence.currentTime,
      duration: this.video.duration
    });
    this.emit("media-live", { active: true });
  }

  verdict() {
    return overallVerdict(this.snapshotStages());
  }
}

export function createEncryptionLab(options) {
  return new EncryptionLab(options);
}
