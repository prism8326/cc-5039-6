/**
 * 加密会话适配层（接入版本 eme-session/v2）。
 *
 * 相对 eme-session/v1 的迁移：
 * - 配置：能力检测与会话类型声明由适配层统一生成并显式化；
 * - 事件：许可请求与密钥状态改由 message / keystatuseschange 事件驱动（v1 为轮询）；
 * - 密钥状态映射：usable/expired/released/output-restricted/status-pending/internal-error
 *   全量映射，未知状态直接报错，不得以默认值遮错；
 * - 生命周期：会话必须显式 close() 并校验 keyStatuses 释放。
 */

export const SESSION_INTERFACE_VERSION = "eme-session/v2";
export const LEGACY_SESSION_INTERFACE_VERSION = "eme-session/v1";

export const SESSION_INTERFACE_NOTE = "事件驱动 · 显式关闭回收";

export const KEY_STATUS_SEMANTICS = Object.freeze({
  usable: Object.freeze({ playable: true, reason: null, label: "可用" }),
  expired: Object.freeze({ playable: false, reason: "key-expired", label: "已过期" }),
  released: Object.freeze({ playable: false, reason: "key-released", label: "已释放" }),
  "output-restricted": Object.freeze({
    playable: false,
    reason: "key-output-restricted",
    label: "输出受限"
  }),
  "status-pending": Object.freeze({
    playable: false,
    reason: "key-status-pending",
    label: "状态待定"
  }),
  "internal-error": Object.freeze({
    playable: false,
    reason: "key-internal-error",
    label: "CDM 内部错误"
  })
});

export class SessionContractError extends Error {
  constructor(reason, message, evidence) {
    super(message ?? reason);
    this.reason = reason;
    this.evidence = evidence ?? null;
  }
}

export function explainLegacyInterface(version) {
  const requested = typeof version === "string" && version.length > 0 ? version : "未指定";
  return (
    `配置请求的会话接口 ${requested} 已失效：v1 直接调用 CDM、轮询密钥状态且不做关闭回收；` +
    `当前接入版本为 ${SESSION_INTERFACE_VERSION}（${SESSION_INTERFACE_NOTE}）`
  );
}

export function mapKeyStatus(status) {
  const semantics = KEY_STATUS_SEMANTICS[status];
  if (!semantics) {
    throw new SessionContractError(
      "key-status-unmapped",
      `CDM 报告了适配层未映射的密钥状态：${String(status)}`,
      String(status)
    );
  }
  return semantics;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ManagedSession {
  constructor(session) {
    this.session = session;
    this.closed = false;
    this.statusChangeEvents = 0;
    this._statusWaiters = new Set();
    this._listeners = [];
    this._listen("keystatuseschange", () => {
      this.statusChangeEvents += 1;
      for (const resolve of [...this._statusWaiters]) {
        this._statusWaiters.delete(resolve);
        resolve();
      }
    });
  }

  _listen(type, handler) {
    this.session.addEventListener(type, handler);
    this._listeners.push([type, handler]);
  }

  dispose() {
    for (const [type, handler] of this._listeners) {
      this.session.removeEventListener(type, handler);
    }
    this._listeners = [];
    for (const resolve of [...this._statusWaiters]) {
      this._statusWaiters.delete(resolve);
      resolve();
    }
  }

  keyStatusSnapshot() {
    const snapshot = new Map();
    for (const [kidBuffer, status] of this.session.keyStatuses) {
      snapshot.set(bytesToHex(new Uint8Array(kidBuffer)), status);
    }
    return snapshot;
  }

  _waitStatusesChange(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._statusWaiters.delete(onChange);
        resolve();
      }, ms);
      const onChange = () => {
        clearTimeout(timer);
        resolve();
      };
      this._statusWaiters.add(onChange);
    });
  }

  _nextLicenseMessage(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new SessionContractError("generate-request-failed", "等待许可请求消息超时"));
      }, timeoutMs);
      const onMessage = (event) => {
        cleanup();
        resolve(event.message);
      };
      const onMessageError = () => {
        cleanup();
        reject(new SessionContractError("generate-request-failed", "许可请求消息出错（messageerror）"));
      };
      const onError = () => {
        cleanup();
        reject(new SessionContractError("generate-request-failed", "许可请求前会话报告错误"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.session.removeEventListener("message", onMessage);
        this.session.removeEventListener("messageerror", onMessageError);
        this.session.removeEventListener("error", onError);
      };
      this.session.addEventListener("message", onMessage);
      this.session.addEventListener("messageerror", onMessageError);
      this.session.addEventListener("error", onError);
    });
  }

  async generateRequest(initData, { timeoutMs }) {
    const messagePromise = this._nextLicenseMessage(timeoutMs);
    try {
      await this.session.generateRequest("cenc", initData);
    } catch (error) {
      throw new SessionContractError(
        "generate-request-failed",
        null,
        `generateRequest('cenc') → ${error?.name ?? "Error"}: ${error?.message ?? ""}`.trim()
      );
    }
    return messagePromise;
  }

  async update(licenseBytes, { timeoutMs, awaitKidHex }) {
    try {
      await this.session.update(licenseBytes);
    } catch (error) {
      throw new SessionContractError(
        "key-update-failed",
        null,
        `session.update 受到拒绝：${error?.name ?? "Error"}: ${error?.message ?? ""}`.trim()
      );
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = this.keyStatusSnapshot();
      const status = awaitKidHex ? snapshot.get(awaitKidHex) : undefined;
      if (!awaitKidHex || (status !== undefined && status !== "status-pending")) {
        return snapshot;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (status === undefined) {
          throw new SessionContractError(
            "key-status-missing",
            "等待 keystatuseschange 超时，未观察到目标密钥状态"
          );
        }
        return snapshot;
      }
      await this._waitStatusesChange(remaining);
    }
  }

  async close({ timeoutMs }) {
    if (this.closed) {
      return { closed: true, alreadyClosed: true, keyStatusesReleased: true, remainingStatuses: 0 };
    }
    let timer = null;
    try {
      await Promise.race([
        this.session.close(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new SessionContractError("session-close-failed", `close() 超过 ${timeoutMs}ms 未解决`)),
            timeoutMs
          );
        })
      ]);
    } catch (error) {
      if (error instanceof SessionContractError) throw error;
      throw new SessionContractError(
        "session-close-failed",
        null,
        `close() 被拒绝：${error?.name ?? "Error"}: ${error?.message ?? ""}`.trim()
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    this.closed = true;
    this.dispose();
    const remaining = this.session.keyStatuses.size;
    if (remaining !== 0) {
      throw new SessionContractError(
        "session-close-failed",
        `会话关闭后仍残留 ${remaining} 个密钥状态（未释放）`
      );
    }
    return { closed: true, alreadyClosed: false, keyStatusesReleased: true, remainingStatuses: 0 };
  }
}

export class EmeSessionAdapter {
  constructor({ version } = {}) {
    if (version !== SESSION_INTERFACE_VERSION) {
      throw new SessionContractError("legacy-session-interface", explainLegacyInterface(version));
    }
    this.version = SESSION_INTERFACE_VERSION;
  }

  buildAccessConfig(manifest) {
    return [
      {
        initDataTypes: ["cenc"],
        videoCapabilities: [{ contentType: manifest.tracks.video.mimeType }],
        audioCapabilities: [{ contentType: manifest.tracks.audio.mimeType }],
        distinctiveIdentifier: "not-allowed",
        persistentState: "optional",
        sessionTypes: ["temporary"]
      }
    ];
  }

  async createMediaKeys(access) {
    try {
      return await access.createMediaKeys();
    } catch (error) {
      throw new SessionContractError("session-error", null, `createMediaKeys 失败：${error?.name ?? "Error"}`);
    }
  }

  openSession(mediaKeys, sessionType) {
    let session;
    try {
      session = mediaKeys.createSession(sessionType);
    } catch (error) {
      const reason = error?.name === "NotSupportedError" ? "session-unsupported" : "session-failed";
      throw new SessionContractError(
        reason,
        null,
        `createSession('${sessionType}') → ${error?.name ?? "Error"}`
      );
    }
    return new ManagedSession(session);
  }

  mapKeyStatuses(snapshot) {
    return [...snapshot.entries()].map(([kidHex, status]) => [kidHex, status, mapKeyStatus(status)]);
  }
}

export function createEmeSessionAdapter(options) {
  return new EmeSessionAdapter(options);
}
