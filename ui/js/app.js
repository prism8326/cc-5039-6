import { createEncryptionLab } from "./kernel.js";
import { createEmeSessionAdapter } from "./eme-session-adapter.js";
import { STAGE_IDS, stageLabel, reasonText, overallVerdict } from "../../shared/stages.js";

const video = document.getElementById("lesson-video");
const credentialSelect = document.getElementById("credential-select");
const scenarioSelect = document.getElementById("scenario-select");
const runButton = document.getElementById("run-button");
const stopButton = document.getElementById("stop-button");
const scenarioSummary = document.getElementById("scenario-summary");
const credentialHint = document.getElementById("credential-hint");
const stageRows = new Map(
  [...document.querySelectorAll(".stage-row")].map((row) => [row.dataset.stage, row])
);
const verdictChip = document.getElementById("verdict-chip");
const verdictText = document.getElementById("verdict-text");
const failureBox = document.getElementById("failure-box");
const failureTitle = document.getElementById("failure-title");
const failureBody = document.getElementById("failure-body");
const eventList = document.getElementById("event-list");
const veil = document.getElementById("stage-veil");
const veilTitle = document.getElementById("veil-title");
const veilBody = document.getElementById("veil-body");
const playerChip = document.getElementById("player-chip");
const keySystemLabel = document.getElementById("key-system-label");
const sessionInterfaceLabel = document.getElementById("session-interface-label");
const protectionNote = document.getElementById("protection-note");
const courseSummary = document.getElementById("course-summary");
const courseNote = document.getElementById("course-note");
const limitList = document.getElementById("limit-list");

let course = null;
let lab = null;
let running = false;
let eventCount = 0;

function setChip(element, text, variant = "") {
  element.textContent = text;
  element.classList.toggle("chip-pass", variant === "pass");
  element.classList.toggle("chip-fail", variant === "fail");
  element.classList.toggle("chip-quiet", variant === "quiet" || variant === "");
}

function setVeil({ title, body, clear = false }) {
  if (title !== undefined) veilTitle.textContent = title;
  if (body !== undefined) veilBody.textContent = body;
  veil.hidden = false;
  veil.classList.toggle("is-clear", clear);
}

function showVeil() {
  veil.hidden = false;
  veil.classList.remove("is-clear");
}

function addEvent(text) {
  eventCount += 1;
  const li = document.createElement("li");
  const time = document.createElement("span");
  time.className = "event-time";
  const now = new Date();
  time.textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
  const label = document.createElement("span");
  label.textContent = text;
  li.append(time, label);
  eventList.append(li);
  if (eventList.children.length > 40) eventList.firstElementChild.remove();
}

function renderStageState(id, state, note) {
  const row = stageRows.get(id);
  if (!row) return;
  row.dataset.state = state;
  const noteEl = row.querySelector("[data-note]");
  if (noteEl) noteEl.textContent = note ?? "";
  row.setAttribute("aria-label", `${stageLabel(id)}：${stateLabel(state)}${note ? `，${note}` : ""}`);
}

function stateLabel(state) {
  return (
    { pending: "待开始", active: "进行中", passed: "已通过", failed: "未通过", blocked: "已中止" }[state] ??
    state
  );
}

function applyStages(stages) {
  for (const id of STAGE_IDS) {
    const entry = stages[id] ?? { state: "pending" };
    let note = "";
    if (entry.evidence) note = String(entry.evidence);
    if (entry.reason && entry.state !== "passed") {
      note = `${reasonText(entry.reason)}${entry.evidence ? ` · ${entry.evidence}` : ""}`;
    }
    renderStageState(id, entry.state, note);
  }
}

function renderVerdict(stages) {
  const verdict = overallVerdict(stages);
  const failed = verdict.ok ? null : verdict.stage;
  if (running) {
    setChip(verdictChip, "进行中", "");
    verdictText.textContent = "加密教学内核正在驱动本轮实验…";
    return verdict;
  }
  if (verdict.ok) {
    setChip(verdictChip, "已验证", "pass");
    verdictText.textContent = "许可取得、密钥可用与媒体实际解码均已成立。";
  } else if (failed) {
    setChip(verdictChip, "未通过", "fail");
    verdictText.textContent = `${stageLabel(failed)}未通过：${reasonText(stages[failed].reason)}`;
  } else {
    setChip(verdictChip, "未验证", "quiet");
    verdictText.textContent = "状态区分许可取得、密钥可用与媒体实际可解码。";
  }
  return verdict;
}

function showFailure(detail) {
  failureBox.hidden = false;
  failureTitle.textContent = detail.title;
  failureBody.textContent = detail.body;
}

function clearFailure() {
  failureBox.hidden = true;
  failureTitle.textContent = "";
  failureBody.textContent = "";
}

function setRunningUI(value) {
  running = value;
  runButton.disabled = value;
  stopButton.disabled = !value;
  credentialSelect.disabled = value;
  scenarioSelect.disabled = value;
  setChip(playerChip, value ? "内核运行中" : "待机", value ? "" : "quiet");
}

function scenarioFor(id) {
  return course?.scenarios.find((s) => s.id === id) ?? course?.scenarios[0];
}

function selectedScenario() {
  const combined = [...(course?.scenarios ?? []), ...(course?.diagnostics ?? [])];
  return combined.find((s) => s.id === scenarioSelect.value) ?? course?.scenarios[0];
}

function describeScenario(scenario) {
  if (!scenario) return "";
  const key = scenario.credentialId
    ? course.credentials.find((c) => c.id === scenario.credentialId)?.label
    : null;
  const expected =
    scenario.expect === "granted"
      ? "预期：五阶段全部通过"
      : `预期：许可或解码阶段被拒绝（${reasonText(scenario.expectedReason ?? expectToReason(scenario.expect))}）`;
  return `${scenario.summary}${key ? ` 凭据：${key}。` : ""}${scenario.teachingPoint ? ` 教学点：${scenario.teachingPoint}` : ""} ${expected}`;
}

function expectToReason(expect) {
  return (
    {
      granted: null,
      "denied-unknown-kid": "denied-unknown-kid",
      "denied-key-mismatch": "denied-key-mismatch",
      unreachable: "network-error",
      "session-failed": "session-unsupported",
      "media-decode-failed": "media-decode-failed",
      "legacy-session-interface": "legacy-session-interface"
    }[expect] ?? expect
  );
}

function syncCredentialHint() {
  const credential = course.credentials.find((c) => c.id === credentialSelect.value);
  if (!credential) return;
  credentialHint.textContent =
    credential.role === "primary"
      ? `已选 ${credential.label}：标识 ${credential.kidHex.slice(0, 8)}…，与封装清单一致。`
      : `已选 ${credential.label}：标识 ${credential.kidHex.slice(0, 8)}…，不是本片封装的密钥标识。`;
}

function syncScenario() {
  const scenario = selectedScenario();
  scenarioSummary.textContent = describeScenario(scenario);
  const scenarioCredential = scenario?.credentialId;
  if (scenarioCredential) {
    credentialSelect.value = scenarioCredential;
    syncCredentialHint();
  }
}

async function loadCourse() {
  const response = await fetch("/api/course", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  course = await response.json();

  courseSummary.textContent = course.course.summary;
  courseNote.textContent = `${course.course.title}：${course.course.subtitle}。资产 ${course.mediaAsset.assetId}。`;
  keySystemLabel.textContent = course.license.keySystemLabel;
  protectionNote.textContent = course.protection.label;

  const interfaceInfo = course.sessionInterface;
  sessionInterfaceLabel.textContent = interfaceInfo
    ? `${interfaceInfo.version}（自 ${interfaceInfo.previousVersion} 升级）`
    : "未配置";

  credentialSelect.replaceChildren(
    ...course.credentials.map((credential) => {
      const option = document.createElement("option");
      option.value = credential.id;
      option.textContent = credential.label;
      return option;
    })
  );
  credentialSelect.value = course.credentials[0].id;

  const scenarioOptions = [...course.scenarios, ...course.diagnostics].map((scenario) => {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = scenario.label;
    return option;
  });
  scenarioSelect.replaceChildren(...scenarioOptions);
  scenarioSelect.value = course.scenarios[0].id;

  limitList.replaceChildren(
    ...course.protection.limits.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    })
  );

  syncCredentialHint();
  syncScenario();

  let sessionAdapter;
  try {
    sessionAdapter = createEmeSessionAdapter({ version: course.sessionInterface?.version });
  } catch (error) {
    setVeil({
      title: "会话接口配置失效",
      body: `${error.message}。加密教学界面已阻止本轮实验，不会静默改用其他版本。`,
      clear: false
    });
    showFailure({
      title: "会话接口配置失效",
      body: error.message
    });
    setChip(playerChip, "不可用", "fail");
    runButton.disabled = true;
    return;
  }
  lab = createEncryptionLab({ video, course, sessionAdapter, onEvent: handleEvent });
  setChip(verdictChip, "未验证", "quiet");
}

function handleEvent(event) {
  switch (event.type) {
    case "run-start": {
      const isDiagnostic = course.diagnostics.some((d) => d.id === event.scenario.id);
      addEvent(`${isDiagnostic ? "诊断" : "实验"}开始：${event.scenario.label}`);
      clearFailure();
      showVeil();
      setVeil({
        title: "加密教学内核运行中",
        body: "先建立密钥会话与许可，再判断媒体是否真的可以解码。",
        clear: false
      });
      setRunningUI(true);
      break;
    }
    case "stages":
      applyStages(event.stages);
      break;
    case "stage": {
      const note = event.reason
        ? `${reasonText(event.reason)}${event.evidence ? ` · ${event.evidence}` : ""}`
        : event.evidence;
      renderStageState(event.id, event.state, note);
      if (event.state === "active") addEvent(`进入${stageLabel(event.id)}`);
      if (event.state === "passed") addEvent(`通过${stageLabel(event.id)}${event.evidence ? `：${event.evidence}` : ""}`);
      if (event.state === "failed") addEvent(`${stageLabel(event.id)}未通过：${reasonText(event.reason)}`);
      break;
    }
    case "support":
      addEvent(`使用 ${event.label}（${event.videoType}）`);
      break;
    case "session-interface":
      addEvent(`加密会话接口 ${event.version}（自 ${event.previousVersion} 升级：${event.note}）`);
      break;
    case "key-update":
      addEvent(
        `密钥更新：同一会话第 ${event.count} 次 update 完成（keystatuseschange 事件 ×${event.statusEvents}，续期请求 ${event.renewalRequestId ?? "未提供"}）`
      );
      break;
    case "session-release": {
      if (event.closed && event.keyStatusesReleased) {
        const suffix = event.trigger === "teardown" ? "（回收）" : "";
        addEvent(`会话已关闭：密钥状态已释放${suffix}`);
      } else {
        addEvent(`会话关闭异常：${event.error ?? "密钥状态未释放"}`);
      }
      break;
    }
    case "license-init":
      addEvent(`许可请求：${event.note}`);
      break;
    case "license":
      addEvent(`许可响应 200：${event.note}（请求 ${event.requestId ?? "未提供"}）`);
      break;
    case "key":
      addEvent(`密钥状态：${event.statuses.map(([kid, status]) => `${kid.slice(0, 8)}…:${status}`).join("，")}`);
      break;
    case "decode":
      addEvent(`真实解码：${event.frames}+ 帧，播放位置 ${event.currentTime.toFixed(2)}s`);
      break;
    case "media-live":
      setVeil({ title: "", body: "", clear: true });
      break;
    case "failure": {
      const suffix = event.evidence ? `（${event.evidence}）` : "";
      showFailure({
        title: `${stageLabel(event.stage)}未通过`,
        body: `${reasonText(event.reason)}${suffix}。实验停在该阶段，未继续显示后续成功状态。`
      });
      setVeil({
        title: `${stageLabel(event.stage)}未通过`,
        body: reasonText(event.reason),
        clear: false
      });
      addEvent(`失败反馈：${reasonText(event.reason)}`);
      break;
    }
    case "run-end": {
      setRunningUI(false);
      const verdict = renderVerdict(event.stages);
      if (event.outcome.ok) {
        const released = event.outcome.evidence?.sessionRelease;
        if (released?.keyStatusesReleased) {
          setVeil({
            title: "会话已结束",
            body: "密钥状态已释放，画面停止推进。重新开始以再次验证。",
            clear: false
          });
          setChip(playerChip, "已验证 · 会话已回收", "pass");
        } else {
          setVeil({ title: "", body: "", clear: true });
          setChip(playerChip, "解密画面播放中", "pass");
        }
        addEvent("授权链路已验证：许可、密钥与真实解码均成立");
      } else {
        const stage = event.outcome.stage;
        const reason = event.outcome.reason;
        showFailure({
          title: stage ? `${stageLabel(stage)}未通过` : "未通过",
          body: `${reasonText(reason)}。播放器不会把许可响应或密钥状态当作最终成功。`
        });
        addEvent(`本轮结束：${verdict.title} · ${reasonText(reason)}`);
        setChip(playerChip, "已拒绝", "fail");
      }
      break;
    }
    case "run-stopped":
      addEvent("实验被停止");
      break;
    default:
      break;
  }
}

async function startRun() {
  if (!lab) return;
  const scenario = selectedScenario();
  await lab.run(scenario, { credentialId: credentialSelect.value });
}

runButton.addEventListener("click", () => {
  if (!running) startRun();
});

stopButton.addEventListener("click", () => {
  if (!lab) return;
  lab.abort();
  setRunningUI(false);
  setChip(playerChip, "已停止", "quiet");
  addEvent("已停止本轮实验");
  setVeil({
    title: "实验已停止",
    body: "任何已取得的许可不会让界面自动显示成功。重新开始以再次验证。",
    clear: false
  });
  const stages = lab.snapshotStages();
  applyStages(stages);
  renderVerdict(stages);
});

credentialSelect.addEventListener("change", () => {
  syncCredentialHint();
});

scenarioSelect.addEventListener("change", () => {
  syncScenario();
  clearFailure();
  setVeil({
    title: "尚未开始",
    body: "本轮选择已更新。开始实验后，内核会按场景驱动许可与解码。",
    clear: false
  });
});

video.addEventListener("error", () => {
  if (!running) return;
  const error = video.error;
  addEvent(`媒体元素错误：${error ? `${error.code} ${error.message}` : "未知"}`);
});

loadCourse().catch((error) => {
  keySystemLabel.textContent = "无法载入课程";
  protectionNote.textContent = String(error.message ?? error);
  setVeil({
    title: "无法载入课程配置",
    body: "请确认本地服务已启动（npm start）。",
    clear: false
  });
  setChip(playerChip, "不可用", "fail");
});

// 调试辅助：仅在控制台显式调用时暴露内核，便于核对状态来源
window.__encryptionLab = () => lab;
