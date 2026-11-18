export const STAGE_IDS = ["support", "session", "license", "key", "decode"];

export const STAGES = [
  {
    id: "support",
    label: "测试密钥系统",
    detail: "ClearKey 与媒体能力检测"
  },
  {
    id: "session",
    label: "密钥会话",
    detail: "向浏览器 CDM 建立媒体密钥会话"
  },
  {
    id: "license",
    label: "许可取得",
    detail: "许可端返回与初始化数据匹配的响应"
  },
  {
    id: "key",
    label: "密钥可用",
    detail: "CDM 报告密钥状态 usable"
  },
  {
    id: "decode",
    label: "媒体实际可解码",
    detail: "解密后持续出帧并推进播放时钟"
  }
];

export const REASONS = {
  "unsupported-key-system": "浏览器不支持 ClearKey 测试密钥系统",
  "unsupported-media-capability": "浏览器不支持所选媒体能力",
  "session-failed": "密钥会话创建失败（浏览器拒绝该会话类型）",
  "session-unsupported": "该会话类型不受当前测试密钥系统支持",
  "session-error": "密钥会话在建立过程中出错",
  "legacy-session-interface": "旧版会话接口配置已失效（eme-session/v1 不再接受，当前接入版本为 eme-session/v2）",
  "key-update-failed": "密钥更新被 CDM 拒绝",
  "key-status-unmapped": "CDM 报告了适配层未映射的密钥状态",
  "session-close-failed": "会话关闭或资源释放未完成",
  "key-expired": "密钥已过期",
  "key-released": "密钥已被释放",
  "key-output-restricted": "密钥输出受限",
  "key-status-pending": "密钥状态待定",
  "key-internal-error": "CDM 报告密钥内部错误",
  "generate-request-failed": "无法根据初始化数据生成许可请求",
  "network-error": "无法连接本地许可端",
  "http-error": "许可端返回错误状态",
  "denied-unknown-kid": "许可端不认识请求中的密钥标识",
  "denied-key-mismatch": "凭据与课程密钥标识不匹配",
  "denied-credential": "许可端不认识所选测试凭据",
  "denied-asset": "许可端没有该课程资产",
  "malformed-request": "许可请求格式无效",
  "malformed-response": "许可端响应不是有效的测试密钥许可",
  "license-not-matching-init-data": "许可响应与初始化数据不匹配",
  "key-not-usable": "CDM 未报告可用密钥",
  "key-status-missing": "未观察到任何密钥状态",
  "media-fetch-failed": "无法取得加密封装分片",
  "media-append-failed": "媒体分片无法加入缓冲",
  "media-decode-failed": "解密后媒体解码失败",
  "media-no-frames": "播放时钟或解码帧未推进",
  "play-blocked": "浏览器阻止自动播放，需手动点击播放",
  "aborted": "实验已停止",
  "upstream-failed": "上游阶段未通过",
  "internal-error": "实验内核内部错误"
};

export const SERVER_OUTCOME_REASONS = {
  "unknown-kid": "denied-unknown-kid",
  "credential-key-mismatch": "denied-key-mismatch",
  "credential-not-found": "denied-credential",
  "asset-not-found": "denied-asset",
  "malformed-request": "malformed-request",
  "unsupported-session-type": "malformed-request",
  "key-material-missing": "internal-error"
};

export function stageLabel(id) {
  return STAGES.find((s) => s.id === id)?.label ?? id;
}

export function reasonText(code) {
  return REASONS[code] ?? code ?? "未知原因";
}

export function createStageState() {
  return Object.fromEntries(
    STAGE_IDS.map((id) => [id, { state: "pending", reason: null, detail: null }])
  );
}

export function overallVerdict(stages) {
  const failed = STAGE_IDS.find((id) => stages[id].state === "failed");
  if (failed) {
    return {
      ok: false,
      stage: failed,
      title: `未通过：${stageLabel(failed)}`,
      reason: stages[failed].reason
    };
  }
  const blocked = STAGE_IDS.find((id) => stages[id].state === "blocked");
  if (blocked) {
    return {
      ok: false,
      stage: blocked,
      title: `未完成：${stageLabel(blocked)}`,
      reason: stages[blocked].reason
    };
  }
  if (STAGE_IDS.every((id) => stages[id].state === "passed")) {
    return {
      ok: true,
      stage: null,
      title: "授权链路已验证",
      reason: null
    };
  }
  return { ok: false, stage: null, title: "尚未验证", reason: null };
}
