#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, ".verify");
const PORT = Number(process.env.VERIFY_PORT ?? 4174);

function log(message) {
  process.stdout.write(`[verify] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[verify] 失败：${message}\n`);
  process.exitCode = 1;
}

function detectLibraries() {
  const candidates = [
    process.env.BROWSER_LIB_DIR,
    resolve(ROOT, ".sysroot/usr/lib/aarch64-linux-gnu"),
    resolve(ROOT, ".sysroot/usr/lib/x86_64-linux-gnu"),
    resolve(ROOT, ".sysroot/lib/aarch64-linux-gnu"),
    resolve(ROOT, ".sysroot/lib/x86_64-linux-gnu")
  ].filter(Boolean);
  const libs = candidates.filter((dir) => existsSync(dir)).join(":");
  if (libs) process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  return libs || null;
}

function detectBrowser() {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  const candidates = [];
  const chromeDir = resolve(ROOT, ".chrome/chrome");
  if (existsSync(chromeDir)) {
    for (const entry of readdirSync(chromeDir)) {
      candidates.push(resolve(chromeDir, entry, "chrome-linux-arm64/chrome"));
      candidates.push(resolve(chromeDir, entry, "chrome-linux64/chrome"));
    }
  }
  for (const path of [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ]) {
    candidates.push(path);
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function startServer(port) {
  const child = spawn(process.execPath, ["server/app.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`服务启动超时\n${output}`)), 8000);
    const check = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/course`);
        if (response.ok) {
          clearTimeout(timer);
          clearInterval(check);
          resolveReady();
        }
      } catch {
        /* 尚未监听 */
      }
    }, 120);
  });
  await ready;
  return { child, output: () => output };
}

const SCENARIO_EXPECTATIONS = [
  { id: "normal", expectOk: true, stage: null },
  { id: "init-data-mismatch", expectOk: false, stage: "license" },
  { id: "wrong-key", expectOk: false, stage: "license" },
  { id: "license-offline", expectOk: false, stage: "license" },
  { id: "session-failure", expectOk: false, stage: "session" },
  { id: "mismatched-key-material", expectOk: false, stage: "decode" },
  {
    id: "legacy-session-interface",
    expectOk: false,
    stage: "session",
    failureTextIncludes: "eme-session/v1"
  },
  { id: "key-rotation", expectOk: true, stage: null, minKeyUpdates: 2 },
  { id: "session-teardown", expectOk: true, stage: null, expectSessionRelease: true }
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const libs = detectLibraries();
  if (libs) log(`使用本地浏览器运行库：${libs}`);
  const executablePath = detectBrowser();
  const { chromium } = await import("playwright-core");
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"]
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
    log(`使用浏览器：${executablePath}`);
  } else {
    log("未指定浏览器可执行文件，使用 playwright 默认 Chromium");
  }

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    fail(`无法启动浏览器：${error.message.split("\n")[0]}`);
    return;
  }

  const server = await startServer(PORT);
  const results = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const responses = [];
    page.on("response", (response) => {
      responses.push({ url: response.url(), status: response.status() });
    });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => typeof window.__encryptionLab === "function" && window.__encryptionLab() !== null,
      null,
      { timeout: 10000 }
    );

    for (const expectation of SCENARIO_EXPECTATIONS) {
      await page.selectOption("#scenario-select", expectation.id);
      const scenarioCredential = await page.evaluate((scenarioId) => {
        const course = window.__encryptionLab().course;
        return (
          course.scenarios.find((s) => s.id === scenarioId) ??
          course.diagnostics.find((s) => s.id === scenarioId)
        ).credentialId;
      }, expectation.id);
      if (scenarioCredential) {
        await page.selectOption("#credential-select", scenarioCredential);
      }

      await page.click("#run-button");
      await page.waitForFunction(
        (scenarioId) => {
          const lab = window.__encryptionLab();
          return lab && lab.lastOutcome?.scenarioId === scenarioId;
        },
        expectation.id,
        { timeout: 60000 }
      );
      await page.waitForFunction(
        () => !document.getElementById("run-button").disabled,
        null,
        { timeout: 15000 }
      );

      const outcome = await page.evaluate(() => {
        const lab = window.__encryptionLab();
        return {
          result: lab.lastOutcome,
          stages: lab.snapshotStages(),
          sessionInterface: lab.sessionAdapter?.version ?? null,
          videoElement: {
            hasMediaKeys: Boolean(lab.video.mediaKeys),
            currentTime: lab.video.currentTime,
            readyState: lab.video.readyState,
            errorCode: lab.video.error?.code ?? null,
            errorMessage: lab.video.error?.message ?? null,
            paused: lab.video.paused,
            duration: Number.isFinite(lab.video.duration) ? lab.video.duration : null
          },
          mediaFrames: lab.video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
          playbackText: document.getElementById("player-chip").textContent,
          ui: {
            verdictChip: document.getElementById("verdict-chip").textContent,
            failureVisible: !document.getElementById("failure-box").hidden,
            failureBody: document.getElementById("failure-body").textContent,
            playerChip: document.getElementById("player-chip").textContent,
            sessionInterfaceLabel: document.getElementById("session-interface-label").textContent
          }
        };
      });

      if (expectation.expectOk && !expectation.expectSessionRelease) {
        const progress = await page.evaluate(async () => {
          const lab = window.__encryptionLab();
          const start = lab.video.currentTime;
          const framesBefore = lab.video.getVideoPlaybackQuality().totalVideoFrames;
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return {
            start,
            end: lab.video.currentTime,
            framesBefore,
            framesAfter: lab.video.getVideoPlaybackQuality().totalVideoFrames
          };
        });
        outcome.playbackProgress = progress;
        if (progress.end - progress.start < 0.5 || progress.framesAfter - progress.framesBefore < 5) {
          outcome.playbackStalled = true;
        }
      }

      const stages = outcome.stages;
      const failedStage = Object.entries(stages).find(([, s]) => s.state === "failed")?.[0] ?? null;
      const verdictOk = Object.values(stages).every((s) => s.state === "passed");
      const licenseResponse = responses
        .filter((r) => r.url.includes("/api/license"))
        .slice(-1)[0] ?? null;

      let evidenceOk = true;
      let evidenceNote = "";
      if (expectation.minKeyUpdates) {
        const updates = outcome.result.evidence?.keyUpdates ?? 0;
        evidenceOk = updates >= expectation.minKeyUpdates;
        evidenceNote = `密钥更新 ${updates} 次`;
      }
      if (expectation.expectSessionRelease) {
        const release = outcome.result.evidence?.sessionRelease;
        evidenceOk =
          release?.closed === true &&
          release?.keyStatusesReleased === true &&
          release?.playbackHalted === true;
        evidenceNote = release
          ? `会话关闭 ${release.closed} · 状态释放 ${release.keyStatusesReleased} · 画面停住 ${release.playbackHalted}`
          : "缺少会话释放证据";
      }
      if (expectation.failureTextIncludes) {
        evidenceOk = outcome.ui.failureBody.includes(expectation.failureTextIncludes);
        evidenceNote = `界面提示含「${expectation.failureTextIncludes}」：${evidenceOk}`;
      }
      if (outcome.sessionInterface !== "eme-session/v2") {
        evidenceOk = false;
        evidenceNote = `${evidenceNote} · 接口版本异常：${outcome.sessionInterface}`.trim();
      }

      const passed =
        outcome.result.ok === expectation.expectOk &&
        verdictOk === expectation.expectOk &&
        (expectation.stage === null || failedStage === expectation.stage) &&
        evidenceOk &&
        (expectation.expectOk
          ? !outcome.playbackStalled &&
            outcome.mediaFrames > 0 &&
            outcome.ui.verdictChip === "已验证" &&
            !outcome.ui.failureVisible
          : outcome.ui.verdictChip === "未通过" && outcome.ui.failureVisible);

      results.push({
        scenario: expectation.id,
        expectation,
        ok: passed,
        result: outcome.result,
        failedStage,
        stages,
        licenseResponse,
        sessionInterface: outcome.sessionInterface,
        evidenceNote: evidenceNote || null,
        videoElement: outcome.videoElement,
        mediaFrames: outcome.mediaFrames,
        playbackProgress: outcome.playbackProgress ?? null,
        ui: outcome.ui
      });

      const statusText = passed ? "通过" : "不符合预期";
      const progressText = outcome.playbackProgress
        ? ` · 播放推进 ${outcome.playbackProgress.start.toFixed(2)}→${outcome.playbackProgress.end.toFixed(
            2
          )}s / 帧 ${outcome.playbackProgress.framesBefore}→${outcome.playbackProgress.framesAfter}`
        : "";
      const noteText = evidenceNote ? ` · ${evidenceNote}` : "";
      log(
        `${expectation.id}: ${statusText} · 结果 ${outcome.result.ok ? "已验证" : "未通过"} · 失败阶段 ${
          failedStage ?? "无"
        } · 原因 ${outcome.result.reason ?? "无"} · 界面 ${outcome.ui.verdictChip}${progressText}${noteText}`
      );

      await page.screenshot({
        path: resolve(OUT_DIR, `scenario-${expectation.id}.png`),
        fullPage: true
      });
    }

    await writeFile(resolve(OUT_DIR, "results.json"), JSON.stringify({ results, consoleErrors, responses }, null, 2));
    const expectedErrorPatterns = [/403 \(Forbidden\)/, /ERR_CONNECTION_REFUSED/];
    const unexpectedErrors = consoleErrors.filter(
      (text) => !expectedErrorPatterns.some((pattern) => pattern.test(text))
    );
    if (unexpectedErrors.length) {
      fail(`页面出现未预期的错误：${unexpectedErrors.join(" | ")}`);
      return;
    }
    const failures = results.filter((r) => !r.ok);
    if (failures.length) {
      fail(`${failures.length} 个场景不符合预期：${failures.map((f) => f.scenario).join(", ")}`);
      return;
    }
    if (consoleErrors.length) {
      log(`页面错误均为场景预期的拒绝（${consoleErrors.length} 条：403 拒绝与许可端断开）`);
    }
    log("九个场景均符合预期（正常播放、改动初始化数据、错误密钥、许可端断开、会话创建失败、正确许可但错误密钥材料、旧版会话接口配置、密钥更新、会话结束与资源释放）");
  } finally {
    await browser.close();
    server.child.kill("SIGTERM");
  }
}

main().catch((error) => {
  fail(error.stack ?? error.message);
});
