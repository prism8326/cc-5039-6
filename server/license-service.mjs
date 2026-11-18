import { createHash, timingSafeEqual } from "node:crypto";

const HEX_KID = /^[0-9a-f]{32}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export class LicenseError extends Error {
  constructor(status, reason, message) {
    super(message ?? reason);
    this.status = status;
    this.reason = reason;
  }
}

export function normalizeHex(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function base64UrlToHex(value) {
  if (typeof value !== "string" || !B64URL.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
  if (buffer.length !== 16) return null;
  return buffer.toString("hex");
}

export function hexToBase64Url(hex) {
  const buffer = Buffer.from(hex, "hex");
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!HEX_KID.test(a) || !HEX_KID.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length !== 16) return false;
  return timingSafeEqual(left, right);
}

function fingerprint(kidHex) {
  return createHash("sha256").update(`edu-drm-lab:${kidHex}`).digest("hex").slice(0, 12);
}

export function createLicenseService({ lesson, keys }) {
  const asset = lesson.mediaAsset;
  const primary = keys.keys.find((k) => k.id === asset.primaryKeyId);

  if (!primary) {
    throw new Error("测试密钥配置缺少课程主密钥");
  }
  if (!HEX_KID.test(normalizeHex(primary.kidHex))) {
    throw new Error("课程主密钥的密钥标识格式无效");
  }

  const courseAssets = new Map([
    [
      asset.assetId,
      {
        assetId: asset.assetId,
        keyId: normalizeHex(primary.kidHex),
        keyHex: normalizeHex(primary.keyHex),
        keyMaterial: {
          kty: "oct",
          kid: hexToBase64Url(normalizeHex(primary.kidHex)),
          k: hexToBase64Url(normalizeHex(primary.keyHex))
        }
      }
    ]
  ]);

  const knownKids = new Set([
    ...keys.keys.map((k) => normalizeHex(k.kidHex)),
    ...(keys.knownKids ?? []).map((k) => normalizeHex(k.kidHex))
  ]);

  const log = (event, fields) => {
    const safe = {
      event,
      ...fields
    };
    process.stdout.write(JSON.stringify(safe) + "\n");
  };

  function parseRequest(body) {
    if (!body || typeof body !== "object") {
      throw new LicenseError(400, "malformed-request");
    }
    const { assetId, kids, sessionType, player, keySystem } = body;
    if (typeof assetId !== "string" || assetId.length === 0 || assetId.length > 120) {
      throw new LicenseError(400, "malformed-request");
    }
    if (!Array.isArray(kids) || kids.length !== 1) {
      throw new LicenseError(400, "malformed-request");
    }
    const kidHex = base64UrlToHex(kids[0]);
    if (!kidHex) {
      throw new LicenseError(400, "malformed-request");
    }
    if (sessionType !== undefined && sessionType !== "temporary" && sessionType !== "persistent-license") {
      throw new LicenseError(400, "malformed-request");
    }
    if (sessionType === "persistent-license") {
      throw new LicenseError(400, "unsupported-session-type");
    }
    return {
      assetId,
      kidHex,
      sessionType: sessionType ?? "temporary",
      player: typeof player === "string" ? player.slice(0, 60) : "unknown",
      keySystem: typeof keySystem === "string" ? keySystem.slice(0, 80) : "unknown"
    };
  }

  function issueLicense(request) {
    const assetEntry = courseAssets.get(request.assetId);
    if (!assetEntry) {
      throw new LicenseError(404, "asset-not-found");
    }
    if (!knownKids.has(request.kidHex)) {
      throw new LicenseError(403, "unknown-kid");
    }
    if (!safeEqualHex(assetEntry.keyId, request.kidHex)) {
      throw new LicenseError(403, "credential-key-mismatch");
    }
    return {
      keys: [assetEntry.keyMaterial],
      type: "temporary",
      assetId: assetEntry.assetId
    };
  }

  return {
    handle(body) {
      const requestId = createHash("sha256")
        .update(JSON.stringify(body ?? null) + Math.random())
        .digest("hex")
        .slice(0, 10);

      let parsed;
      try {
        parsed = parseRequest(body);
      } catch (error) {
        if (error instanceof LicenseError) {
          log("license.denied", {
            requestId,
            reason: error.reason,
            status: error.status,
            assetId: typeof body?.assetId === "string" ? body.assetId.slice(0, 120) : null,
            kidFingerprint: null
          });
          return { status: error.status, body: { error: error.reason, requestId } };
        }
        throw error;
      }

      log("license.request", {
        requestId,
        assetId: parsed.assetId,
        kidFingerprint: fingerprint(parsed.kidHex),
        sessionType: parsed.sessionType,
        player: parsed.player,
        keySystem: parsed.keySystem
      });

      try {
        const license = issueLicense(parsed);
        log("license.granted", {
          requestId,
          assetId: parsed.assetId,
          kidFingerprint: fingerprint(parsed.kidHex)
        });
        return {
          status: 200,
          body: license,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8"
          }
        };
      } catch (error) {
        if (error instanceof LicenseError) {
          log("license.denied", {
            requestId,
            reason: error.reason,
            status: error.status,
            assetId: parsed.assetId,
            kidFingerprint: fingerprint(parsed.kidHex)
          });
          return { status: error.status, body: { error: error.reason, requestId } };
        }
        throw error;
      }
    },
    describe() {
      return {
        assetId: asset.assetId,
        assetTitle: lesson.course.title,
        keySystem: lesson.license.keySystem,
        keySystemLabel: lesson.license.keySystemLabel,
        protectionStrengthLabel: lesson.protection.label,
        scenarios: lesson.scenarios.map(({ id, label, summary }) => ({ id, label, summary }))
      };
    }
  };
}
