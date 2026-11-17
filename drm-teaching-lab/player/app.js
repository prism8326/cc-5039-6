'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  video: $('video'),
  overlay: $('stageOverlay'),
  playBtn: $('playBtn'),
  stopBtn: $('stopBtn'),
  snapshotBtn: $('snapshotBtn'),
  timeLabel: $('timeLabel'),
  courseSelect: $('courseSelect'),
  tamperInit: $('tamperInit'),
  plainMode: $('plainMode'),
  statePill: $('statePill'),
  stateDetail: $('stateDetail'),
  eventLog: $('eventLog'),
  snapshot: $('snapshot'),
  msLicense: $('ms-license'),
  msKey: $('ms-key'),
  msDecode: $('ms-decode'),
};

const S = window.EME_STATES;
let kernel = null;
let courses = [];
let currentManifest = null;

function logEvent(kind, detail) {
  const line = { t: new Date().toLocaleTimeString(), kind, detail };
  els.eventLog.textContent += `${JSON.stringify(line)}\n`;
  els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

function setPill(kind, text) {
  els.statePill.className = `state-pill ${kind}`;
  els.statePill.textContent = text;
}

function setMilestone(el, done, failed, text) {
  el.classList.remove('done', 'failed', 'pending');
  el.classList.add(done ? 'done' : failed ? 'failed' : 'pending');
  el.querySelector('b').textContent = text;
}

function resetMilestones() {
  setMilestone(els.msLicense, false, false, '未取得');
  setMilestone(els.msKey, false, false, '未确认');
  setMilestone(els.msDecode, false, false, '未验证');
}

function renderState(state, snap, detail) {
  const labels = window.EME_STATE_LABELS;
  const infoStates = new Set([S.CONFIGURING_MKS, S.MKS_CONFIGURED, S.WAITING_LICENSE, S.LICENSE_RECEIVED, S.KEY_USABLE, S.LOADING_SEGMENTS]);
  const okStates = new Set([S.DECODABLE, S.PLAYING]);
  const errStates = new Set([S.LICENSE_FAILED, S.KEY_ERROR, S.DECODE_ERROR]);
  const kind = okStates.has(state) ? 'success' : errStates.has(state) ? 'error' : infoStates.has(state) ? 'info' : 'idle';
  setPill(kind, labels[state] || state);
  els.stateDetail.textContent = detail ? JSON.stringify(detail, null, 2) : '状态机推进中…';

  // Each milestone is driven only by its own flag / matching failure state, so a
  // later rejection (e.g. key unusable) can never erase an already-achieved stage.
  const m = snap.milestones;
  if (m.licenseReceived) {
    setMilestone(els.msLicense, true, false, '已取得响应');
  } else if (state === S.LICENSE_FAILED) {
    setMilestone(els.msLicense, false, true, '取得失败');
  }
  if (m.keyUsable) {
    setMilestone(els.msKey, true, false, 'usable');
  } else if (state === S.KEY_ERROR) {
    setMilestone(els.msKey, false, true, '密钥状态异常');
  }
  if (m.decodable) {
    setMilestone(els.msDecode, true, false, '已真实呈现');
  } else if (state === S.DECODE_ERROR) {
    setMilestone(els.msDecode, false, true, '解码被拒绝');
  }
  if ([S.PLAYING, S.DECODABLE].includes(state)) {
    els.overlay.classList.add('hidden');
  }
  if (errStates.has(state)) {
    els.overlay.classList.remove('hidden');
    els.overlay.textContent = `播放被拒绝：${labels[state]}`;
  }
}

async function syncScenario() {
  const scenario = document.querySelector('input[name="scenario"]:checked').value;
  await fetch('/api/scenario', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  logEvent('scenario-set', { scenario });
}

async function loadCourses() {
  const resp = await fetch('/api/state');
  const state = await resp.json();
  courses = state.courses;
  els.courseSelect.innerHTML = '';
  for (const c of courses) {
    const opt = document.createElement('option');
    opt.value = c.courseId;
    opt.textContent = `${c.title}（KID ${c.kid.slice(0, 8)}…）`;
    els.courseSelect.appendChild(opt);
  }
}

async function fetchManifest(courseId) {
  const resp = await fetch(`/content/${courseId}/manifest.json`);
  if (!resp.ok) {
    throw new Error(`清单加载失败 HTTP ${resp.status}`);
  }
  return resp.json();
}

async function playPlain(manifest) {
  resetMilestones();
  setPill('info', '明文对照组播放（不是加密链验证）');
  els.stateDetail.textContent = '直接通过 MSE 播放未加密分段；即使成功也不能证明 EME 加密链有效。';
  logEvent('plain-control-start', { segments: manifest.segments.length });
  const ms = new MediaSource();
  els.video.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer(`video/mp4; codecs="${manifest.video.rfc6381}, ${manifest.audio.rfc6381}"`);
  sb.mode = 'segments';
  let chain = Promise.resolve();
  for (const seg of manifest.segments) {
    const resp = await fetch(`/content/${manifest.courseId}/${seg.plainUrl}`);
    const data = await resp.arrayBuffer();
    chain = chain.then(() => new Promise((resolve) => {
      sb.addEventListener('updateend', resolve, { once: true });
      sb.appendBuffer(data);
    }));
  }
  await chain;
  ms.endOfStream();
  await els.video.play();
  setPill('success', '明文对照组播放成功（注意：这不是加密链验证）');
}

async function start() {
  resetMilestones();
  els.eventLog.textContent = '';
  els.overlay.classList.remove('hidden');
  els.overlay.textContent = '实验启动中…';
  els.playBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.snapshotBtn.disabled = false;

  const courseId = els.courseSelect.value;
  await syncScenario();
  currentManifest = await fetchManifest(courseId);
  logEvent('manifest-loaded', { courseId, kid: currentManifest.kid, segments: currentManifest.segments.length });

  if (els.plainMode.checked) {
    try {
      await playPlain(currentManifest);
    } catch (e) {
      setPill('error', '明文对照组异常');
      els.stateDetail.textContent = String(e);
    } finally {
      els.playBtn.disabled = false;
    }
    return;
  }

  kernel = new window.EmeTeachingKernel({
    video: els.video,
    licenseUrl: '/api/license',
    logger: logEvent,
  });
  kernel.onState(renderState);
  const scenario = document.querySelector('input[name="scenario"]:checked').value;
  try {
    await kernel.run(currentManifest, `/content/${courseId}`, {
      tamperInitData: els.tamperInit.checked,
      unknownKidHex: scenario === 'unknown-kid' ? window.EME_UNKNOWN_TEST_KID : null,
    });
    await els.video.play();
  } catch (e) {
    logEvent('fatal', { message: String(e) });
  } finally {
    els.playBtn.disabled = false;
  }
}

async function stop() {
  if (kernel) {
    await kernel.reset();
  }
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
  resetMilestones();
  setPill('idle', '空闲');
  els.stateDetail.textContent = '已复位。';
  els.overlay.classList.remove('hidden');
  els.overlay.textContent = '尚未开始实验';
  els.snapshotBtn.disabled = true;
  els.stopBtn.disabled = true;
  els.playBtn.disabled = false;
}

function snapshot() {
  const ctx = els.snapshot.getContext('2d');
  ctx.drawImage(els.video, 0, 0, els.snapshot.width, els.snapshot.height);
  logEvent('snapshot', { at: els.video.currentTime.toFixed(2) });
}

function tickTime() {
  const cur = els.video.currentTime || 0;
  const dur = els.video.duration || 0;
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  els.timeLabel.textContent = `${fmt(cur)} / ${fmt(dur)}`;
}

els.playBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', stop);
els.snapshotBtn.addEventListener('click', snapshot);
els.video.addEventListener('timeupdate', tickTime);

document.querySelectorAll('input[name="scenario"]').forEach((r) => r.addEventListener('change', () => {
  if (r.checked) syncScenario();
}));

loadCourses().then(() => {
  els.playBtn.disabled = false;
  logEvent('ui-ready', { emeSupported: 'requestMediaKeySystemAccess' in Navigator.prototype });
}).catch((e) => {
  els.stateDetail.textContent = `初始化失败: ${e}`;
});
