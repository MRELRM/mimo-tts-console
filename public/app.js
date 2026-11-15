'use strict';

/* ============================================================
 * MiMo V2.5-TTS 三合一测试台 · 前端逻辑
 *
 * 三个模型：
 *   mimo-v2.5-tts            预置音色语音合成（audio.voice = 预置音色 ID）
 *   mimo-v2.5-tts-voicedesign 音色设计（user 消息必填音色描述，可选 optimize_text_preview）
 *   mimo-v2.5-tts-voiceclone  音色克隆（audio.voice = Base64 音频样本 Data URL，≤ 10 MB）
 *
 * 所有请求发往本地服务端 /api/tts，浏览器端不接触 API Key。
 * ============================================================ */

/* ==================== 常量 ==================== */

const MAX_BASE64_CHARS = 10 * 1024 * 1024; // 10 MB（Base64 字符数）
const VOICE_PLACEHOLDER = '__VOICE_SAMPLE__';

const MIME_BY_FORMAT = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  pcm: 'application/octet-stream',
  pcm16: 'application/octet-stream',
};

const MODEL_META = {
  'mimo-v2.5-tts': {
    showVoice: true,
    showOptimize: false,
    showSample: false,
    userLabelHTML: '风格 / 语气指令 <span class="field-note">（可选，放入 user 消息）</span>',
    userPlaceholder: '例如：用轻快愉悦的语气播报',
  },
  'mimo-v2.5-tts-voicedesign': {
    showVoice: false,
    showOptimize: true,
    showSample: false,
    userLabelHTML: '音色描述 <span class="req">*</span><span class="field-note">（必填，放入 user 消息）</span>',
    userPlaceholder: '例如：年轻女性，声音明亮活泼，语速偏快',
  },
  'mimo-v2.5-tts-voiceclone': {
    showVoice: false,
    showOptimize: false,
    showSample: true,
    userLabelHTML: '风格 / 语气指令 <span class="field-note">（可选，可留空，放入 user 消息）</span>',
    userPlaceholder: '例如：沉稳、正式的播报口吻（可留空）',
  },
};

const MODEL_DESC = {
  'mimo-v2.5-tts':
    '预置音色语音合成：正文放 assistant 消息，audio.voice 选择预置音色，audio.format 选择输出格式（wav / mp3 / pcm / pcm16）。',
  'mimo-v2.5-tts-voicedesign':
    '音色设计：用自然语言描述想要的音色（user 消息，必填）；可勾选 optimize_text_preview 让模型自动润色播报文本（勾选后正文可省略，assistant 消息可省略）。低延迟流式尚未上线，本页统一走非流式调用。',
  'mimo-v2.5-tts-voiceclone':
    '音色克隆：上传或录制一段 mp3 / wav 样本，audio.voice 传入样本的 Base64 Data URL（编码后不超过 10 MB）；user 消息可放风格指令，也可留空。低延迟流式尚未上线（会降级为一次性返回），本页统一走非流式调用。',
};

/* ==================== DOM ==================== */

const $id = (id) => document.getElementById(id);
const els = {
  healthBar: $id('healthBar'),
  healthText: $id('healthText'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  modelDesc: $id('modelDesc'),

  fieldText: $id('fieldText'),
  textLabel: $id('textLabel'),
  textNote: $id('textNote'),
  textInput: $id('textInput'),
  charCount: $id('charCount'),

  fieldUser: $id('fieldUser'),
  userLabel: $id('userLabel'),
  userInput: $id('userInput'),

  fieldVoice: $id('fieldVoice'),
  voiceSelect: $id('voiceSelect'),
  fieldFormat: $id('fieldFormat'),
  formatSelect: $id('formatSelect'),

  fieldOptimize: $id('fieldOptimize'),
  optimizeCheck: $id('optimizeCheck'),

  sampleSection: $id('sampleSection'),
  fileInput: $id('fileInput'),
  recordBtn: $id('recordBtn'),
  clearSampleBtn: $id('clearSampleBtn'),
  compressBtn: $id('compressBtn'),
  recordStatus: $id('recordStatus'),
  sampleInfo: $id('sampleInfo'),
  sampleWarn: $id('sampleWarn'),

  generateBtn: $id('generateBtn'),

  previewArea: $id('previewArea'),
  expertCheck: $id('expertCheck'),
  regenPreviewBtn: $id('regenPreviewBtn'),

  resultCard: $id('resultCard'),
  resultMeta: $id('resultMeta'),
  audioPlayer: $id('audioPlayer'),
  pcmNote: $id('pcmNote'),
  downloadBtn: $id('downloadBtn'),

  errorCard: $id('errorCard'),
  errorStatus: $id('errorStatus'),
  errorBody: $id('errorBody'),
  errorHints: $id('errorHints'),
};

/* ==================== 状态 ==================== */

const state = {
  model: 'mimo-v2.5-tts',
  sample: null,          // { dataUrl, mime, name, sizeBytes, base64Len, duration, overLimit, raw }
  recording: false,
  recorder: null,
  recChunks: [],
  stream: null,
  recTimer: null,
  recStart: 0,
  expert: false,
  loading: false,
  loadTimer: null,
  loadT0: 0,
  lastElapsed: '0.0',
  audioUrl: null,
  lastResult: null,
};

/* ==================== 工具函数 ==================== */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function fmtMBChars(chars) {
  return (chars / 1024 / 1024).toFixed(2) + ' MB';
}

function fileTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function base64PartOf(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i === -1 ? '' : dataUrl.slice(i + 1);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('文件读取失败'));
    r.readAsDataURL(blob);
  });
}

function getAudioDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const finish = (fn, v) => { URL.revokeObjectURL(url); fn(v); };
    a.onloadedmetadata = () => finish(resolve, isFinite(a.duration) ? a.duration : null);
    a.onerror = () => finish(reject, new Error('无法解码该音频'));
    a.src = url;
  });
}

/* ==================== 模型切换与表单联动 ==================== */

function switchModel(model) {
  if (!MODEL_META[model]) return;
  if (state.recording) stopRecording();
  state.model = model;
  els.tabs.forEach((b) => {
    const active = b.dataset.model === model;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  updateFormVisibility();
  updatePreview();
}

function updateFormVisibility() {
  const meta = MODEL_META[state.model];
  els.fieldVoice.hidden = !meta.showVoice;
  els.fieldOptimize.hidden = !meta.showOptimize;
  els.sampleSection.hidden = !meta.showSample;
  els.userLabel.innerHTML = meta.userLabelHTML;
  els.userInput.placeholder = meta.userPlaceholder;
  els.modelDesc.textContent = MODEL_DESC[state.model];
  updateTextNote();
}

function updateTextNote() {
  let note;
  let showReq = true;
  if (state.model === 'mimo-v2.5-tts-voicedesign') {
    if (els.optimizeCheck.checked) {
      note = '（可留空：已勾选 optimize_text_preview，模型将自动润色播报文本）';
      showReq = false;
    } else {
      note = '（必填，放入 assistant 消息；勾选下方 optimize 后可省略）';
    }
  } else {
    note = '（必填，放入 assistant 消息）';
  }
  els.textNote.textContent = note;
  const reqStar = els.textLabel.querySelector('.req');
  if (reqStar) reqStar.style.display = showReq ? '' : 'none';
}

function updateCharCount() {
  els.charCount.textContent = els.textInput.value.length + ' 字符';
}

/* ==================== payload 构造与预览 ==================== */

function buildPayload() {
  const user = els.userInput.value.trim();
  const text = els.textInput.value.trim();
  const messages = [];
  if (user) messages.push({ role: 'user', content: user });
  if (text) messages.push({ role: 'assistant', content: text });

  const audio = {};
  if (state.model === 'mimo-v2.5-tts') {
    audio.voice = els.voiceSelect.value;
  } else if (state.model === 'mimo-v2.5-tts-voiceclone' && state.sample) {
    audio.voice = state.sample.dataUrl;
  }
  audio.format = els.formatSelect.value;
  if (state.model === 'mimo-v2.5-tts-voicedesign' && els.optimizeCheck.checked) {
    audio.optimize_text_preview = true;
  }
  return { model: state.model, messages, audio };
}

/** 生成预览 JSON：克隆样本 Base64 以占位符显示，避免撑爆文本框 */
function previewJSON() {
  const payload = buildPayload();
  const shown = JSON.parse(JSON.stringify(payload));
  if (shown.audio && typeof shown.audio.voice === 'string' && shown.audio.voice.indexOf('data:') === 0) {
    const v = payload.audio.voice;
    const comma = v.indexOf(',');
    const base64Len = v.length - comma - 1;
    shown.audio.voice = v.slice(0, comma + 1) + VOICE_PLACEHOLDER;
    shown.audio.voice_preview_note = `占位符，发送时替换为完整 Base64（共 ${base64Len} 字符，前 100 字符：${v.slice(comma + 1, comma + 101)}...）`;
  }
  return JSON.stringify(shown, null, 2);
}

function updatePreview() {
  if (state.expert) return; // 专家模式下不覆盖用户编辑
  els.previewArea.value = previewJSON();
}

function onExpertToggle() {
  state.expert = els.expertCheck.checked;
  els.previewArea.readOnly = !state.expert;
  els.previewArea.classList.toggle('editable', state.expert);
  if (!state.expert) updatePreview();
}

/* ==================== 校验与发送 ==================== */

function validate() {
  const text = els.textInput.value.trim();
  const user = els.userInput.value.trim();

  if (state.model === 'mimo-v2.5-tts' || state.model === 'mimo-v2.5-tts-voiceclone') {
    if (!text) return '待合成正文（assistant 消息）不能为空。MiMo TTS 要求正文必须放在 assistant 消息中。';
  }
  if (state.model === 'mimo-v2.5-tts-voicedesign') {
    if (!user) return '音色设计必须填写音色描述（user 消息，必填）。';
    if (!text && !els.optimizeCheck.checked) {
      return 'voicedesign：请填写正文（assistant 消息），或勾选 optimize_text_preview 由模型自动润色播报文本。';
    }
  }
  if (state.model === 'mimo-v2.5-tts-voiceclone') {
    if (!state.sample) return '请先上传或录制克隆样本（mp3 / wav）。';
    if (state.sample.overLimit) {
      return `样本 Base64 后为 ${fmtMBChars(state.sample.base64Len)}，超过 10 MB 上限。请点击「转码压缩（16kHz 单声道 WAV）」或截取较短片段。`;
    }
  }
  return null;
}

async function generate() {
  if (state.loading) return;

  // 专家模式完全由用户构造 payload，跳过表单校验（用于复现报错等调试）
  if (!state.expert) {
    const problem = validate();
    if (problem) {
      showError({ local: true, status: null, error: problem });
      return;
    }
  }

  let payload;
  if (state.expert) {
    let raw = els.previewArea.value;
    if (state.sample && raw.indexOf(VOICE_PLACEHOLDER) !== -1) {
      raw = raw.split(VOICE_PLACEHOLDER).join(base64PartOf(state.sample.dataUrl));
    }
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      showError({ local: true, status: null, error: '专家模式 JSON 解析失败：' + e.message });
      return;
    }
  } else {
    payload = buildPayload();
  }

  hideResult();
  setLoading(true);
  const t0 = Date.now();
  try {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error('本地代理返回了非 JSON 响应（HTTP ' + resp.status + '）');
    }
    state.lastElapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (data && data.success) {
      handleSuccess(data);
    } else {
      showError(data || { status: resp.status, error: '空响应' });
    }
  } catch (e) {
    showError({ status: null, error: '请求失败：' + ((e && e.message) || e) });
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  state.loading = on;
  els.generateBtn.disabled = on;
  if (on) {
    state.loadT0 = Date.now();
    els.generateBtn.textContent = '生成中… 0s';
    state.loadTimer = setInterval(() => {
      const s = Math.floor((Date.now() - state.loadT0) / 1000);
      els.generateBtn.textContent = `生成中… ${s}s（首次生成可能需要数十秒）`;
    }, 500);
  } else {
    if (state.loadTimer) { clearInterval(state.loadTimer); state.loadTimer = null; }
    els.generateBtn.textContent = '生成语音';
  }
}

/* ==================== 结果展示 ==================== */

function handleSuccess(data) {
  hideError();
  const format = data.format || 'wav';
  const bytes = base64ToBytes(data.audio);

  if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }
  state.audioUrl = URL.createObjectURL(new Blob([bytes], { type: MIME_BY_FORMAT[format] || 'application/octet-stream' }));
  state.lastResult = { format, cached: !!data.cached, cacheKey: data.cacheKey || '' };

  const playable = format === 'wav' || format === 'mp3';
  els.audioPlayer.style.display = playable ? '' : 'none';
  if (playable) {
    els.audioPlayer.src = state.audioUrl;
  } else {
    els.audioPlayer.removeAttribute('src');
  }
  els.pcmNote.hidden = playable;

  const parts = [
    `模型 ${esc(state.model)}`,
    `格式 ${esc(format)}`,
    `大小 ${fmtSize(bytes.length)}`,
    `耗时 ${state.lastElapsed}s`,
  ];
  parts.push(data.cached
    ? '<span class="badge badge-cache">命中本地缓存 · 未调用 MiMo API</span>'
    : '<span class="badge badge-fresh">MiMo API 生成</span>');
  els.resultMeta.innerHTML = parts.join(' · ');

  els.resultCard.hidden = false;
  els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function downloadAudio() {
  if (!state.audioUrl || !state.lastResult) return;
  const ext = state.lastResult.format || 'wav';
  const a = document.createElement('a');
  a.href = state.audioUrl;
  a.download = `mimo-tts-${state.model}-${fileTs()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function hideResult() {
  els.resultCard.hidden = true;
  els.audioPlayer.removeAttribute('src');
}

/* ==================== 错误展示与友好提示 ==================== */

function showError(data) {
  const status = data && data.status;
  const error = data && data.error;
  els.errorCard.hidden = false;
  els.errorStatus.textContent = (data && data.local)
    ? '本地提示（请求未发送或已被拦截）'
    : (status ? `请求失败 · HTTP ${status}` : '请求失败');

  let body = typeof error === 'string' ? error : (error ? JSON.stringify(error, null, 2) : '未知错误');
  if (data && data.raw) {
    body += '\n\n—— MiMo 原始响应 ——\n' + JSON.stringify(data.raw, null, 2);
  }
  els.errorBody.textContent = body;

  const hints = buildHints(status, body);
  els.errorHints.innerHTML = hints.length
    ? '<div class="hints-title">可能的原因与排查建议</div>' +
      hints.map((h) => `<div class="hint-item">${esc(h)}</div>`).join('')
    : '';
  els.errorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideError() {
  els.errorCard.hidden = true;
}

function buildHints(status, errorText) {
  const t = String(errorText || '');
  const hints = [];

  if (status === 401 || /\b401\b|unauthorized/i.test(t)) {
    hints.push('【鉴权】401：检查 .env 中的 MIMO_API_KEY 是否正确。MiMo TTS 要求 api-key 请求头而非 Authorization: Bearer（本测试台服务端已按官方要求实现，tp- 开头的 Token Plan Key 用 Bearer 在部分环境会 401）。修改 .env 后需重启 node server.js。');
  }
  if (/param incorrect/i.test(t)) {
    hints.push('【参数】Param Incorrect：① voiceclone 模型不能选预置音色，audio.voice 必须是 Base64 音频样本 Data URL；② voicedesign 不要传预置音色；③ 检查 voice 字段类型是否为字符串；④ 克隆样本 Base64 是否超过 10 MB。');
  }
  if (/must contain an assistant role/i.test(t)) {
    hints.push('【结构】正文必须放在 assistant 消息中：messages 需包含 { "role": "assistant", "content": "正文" }；user 消息只放风格指令或音色描述。');
  }
  if (status === 413 || /10\s*MB|too large|超过 10/i.test(t)) {
    hints.push('【体积】音色克隆样本 Base64 后不能超过 10 MB：请使用页面上的「转码压缩（16kHz 单声道 WAV）」按钮，或截取约 4 分钟以内的片段。');
  }
  if (/format/i.test(t) && /opus|aac/i.test(t)) {
    hints.push('【格式】audio.format 仅支持 wav / mp3 / pcm / pcm16，不支持 opus 与 aac。');
  }
  if (/MIMO_API_KEY/.test(t)) {
    hints.push('【配置】服务端尚未配置 API Key：复制 .env.example 为 .env，填入 MIMO_API_KEY 后重启 node server.js。');
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i.test(t)) {
    hints.push('【网络】无法连接上游：检查本机网络与 DNS，或 .env 中 MIMO_API_BASE_URL 是否正确（Token Plan 国内集群为 https://token-plan-cn.xiaomimimo.com/v1）。');
  }
  if (!hints.length && status >= 500) {
    hints.push(`【上游】MiMo 服务端错误（HTTP ${status}），可稍后重试；若持续出现请检查网络或 .env 配置。`);
  }
  return hints;
}

/* ==================== 克隆样本：上传 / 录音 / 转码 ==================== */

function isAllowedAudio(file) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  return name.endsWith('.mp3') || name.endsWith('.wav') ||
    type === 'audio/mpeg' || type === 'audio/mp3' ||
    type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave';
}

function handleFile(file) {
  if (!file) return;
  if (!isAllowedAudio(file)) {
    showError({
      local: true,
      status: null,
      error: `仅支持 mp3 / wav 样本，收到「${file.name}」。浏览器录音得到的是 webm，需先转码（本页录音功能已内置自动转码为 WAV）。`,
    });
    return;
  }
  loadSampleFromBlob(file, file.name);
}

async function loadSampleFromBlob(blob, displayName) {
  let dataUrl;
  try {
    dataUrl = await blobToDataUrl(blob);
  } catch (e) {
    showError({ local: true, status: null, error: '读取样本失败：' + e.message });
    return;
  }
  if (dataUrl.indexOf('base64,') === -1) {
    showError({ local: true, status: null, error: '样本编码异常：' + displayName });
    return;
  }
  const base64Len = base64PartOf(dataUrl).length;
  let duration = null;
  try { duration = await getAudioDuration(blob); } catch (e) { duration = null; }

  state.sample = {
    dataUrl,
    mime: dataUrl.slice(5, dataUrl.indexOf(';')) || 'application/octet-stream',
    name: displayName,
    sizeBytes: blob.size,
    base64Len,
    duration,
    overLimit: base64Len > MAX_BASE64_CHARS,
    raw: blob,
  };
  updateSampleUI();
  updatePreview();
}

function updateSampleUI() {
  const s = state.sample;
  if (!s) {
    els.sampleInfo.hidden = true;
    els.sampleWarn.hidden = true;
    els.clearSampleBtn.hidden = true;
    els.compressBtn.hidden = true;
    return;
  }
  els.sampleInfo.hidden = false;
  els.clearSampleBtn.hidden = false;
  els.compressBtn.hidden = false;
  els.sampleInfo.textContent =
    `样本就绪：${s.name} · 原始 ${fmtSize(s.sizeBytes)} · Base64 后 ${fmtMBChars(s.base64Len)}` +
    (s.duration ? ` · 时长 ${s.duration.toFixed(1)}s` : '');
  if (s.overLimit) {
    els.sampleWarn.hidden = false;
    els.sampleWarn.textContent =
      `样本 Base64 后为 ${fmtMBChars(s.base64Len)}，超过 10 MB 上限，发送将被阻止。请点击「转码压缩（16kHz 单声道 WAV）」或截取约 4 分钟以内的片段。`;
  } else {
    els.sampleWarn.hidden = true;
  }
}

function clearSample() {
  state.sample = null;
  updateSampleUI();
  updatePreview();
}

async function compressSample() {
  if (!state.sample || !state.sample.raw) return;
  els.recordStatus.hidden = false;
  els.recordStatus.textContent = '正在转码压缩为 16kHz 单声道 WAV…';
  try {
    const wav = await transcodeToWav16kMono(state.sample.raw);
    const baseName = (state.sample.name || 'sample').replace(/\.[^.]*$/, '');
    await loadSampleFromBlob(wav, baseName + '-16k.wav');
  } catch (e) {
    showError({ local: true, status: null, error: '转码失败：' + e.message + '。若原始文件无法解码，请换一个 mp3 / wav 文件。' });
  } finally {
    els.recordStatus.hidden = true;
  }
}

/* ---------- 录音（MediaRecorder → webm → 16kHz 单声道 WAV） ---------- */

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showError({ local: true, status: null, error: '当前浏览器不支持 MediaRecorder 录音，请使用 Chrome / Edge，或改用文件上传 mp3 / wav。' });
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    showError({ local: true, status: null, error: '无法获取麦克风权限：' + e.message });
    return;
  }
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  const rec = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.recorder = rec;
  state.recChunks = [];
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) state.recChunks.push(ev.data); };
  rec.onerror = (ev) => showError({ local: true, status: null, error: '录音出错：' + ((ev.error && ev.error.message) || '未知错误') });
  rec.onstop = async () => {
    stopRecTimer();
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    const webm = new Blob(state.recChunks, { type: rec.mimeType || 'audio/webm' });
    els.recordStatus.hidden = false;
    els.recordStatus.textContent = '正在转码为 16kHz 单声道 WAV…';
    try {
      const wav = await transcodeToWav16kMono(webm);
      await loadSampleFromBlob(wav, '录音-' + fileTs() + '.wav');
    } catch (e) {
      showError({ local: true, status: null, error: '录音转码失败：' + e.message + '（可改用文件上传 mp3 / wav）' });
    } finally {
      els.recordStatus.hidden = true;
    }
  };
  rec.start();
  state.recording = true;
  els.recordBtn.textContent = '停止录音';
  els.recordBtn.classList.add('recording');
  startRecTimer();
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  els.recordBtn.textContent = '开始录音';
  els.recordBtn.classList.remove('recording');
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

function startRecTimer() {
  state.recStart = Date.now();
  els.recordStatus.hidden = false;
  const tick = () => {
    const s = Math.floor((Date.now() - state.recStart) / 1000);
    els.recordStatus.textContent = '录音中 ' + fmtRecTime(s) + '（停止后将自动转码为 16kHz 单声道 WAV）';
  };
  tick();
  state.recTimer = setInterval(tick, 500);
}

function stopRecTimer() {
  if (state.recTimer) { clearInterval(state.recTimer); state.recTimer = null; }
}

function fmtRecTime(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

/* ---------- Web Audio 转码：任意音频 → 16kHz 单声道 WAV ---------- */

async function transcodeToWav16kMono(source) {
  const arrayBuffer = source instanceof Blob ? await source.arrayBuffer() : source;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('当前浏览器不支持 Web Audio API');
  const tmp = new Ctx();
  let decoded;
  try {
    decoded = await tmp.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    if (tmp.close) { try { tmp.close(); } catch (e) { /* 忽略 */ } }
  }
  const targetRate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWavBlob(rendered);
}

/** AudioBuffer → 16-bit PCM 单声道 WAV Blob */
function encodeWavBlob(audioBuffer) {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const src = audioBuffer.getChannelData(0);
  const bytesPerSample = 2;
  const dataSize = src.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);                          // fmt 块大小
  view.setUint16(20, 1, true);                           // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);                          // 位深
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < src.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, src[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/* ==================== 健康检查 ==================== */

async function checkHealth() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const d = await r.json();
    if (d && d.ok) {
      els.healthBar.className = 'health-bar ok';
      els.healthText.innerHTML =
        `本地服务正常 · API 基址 ${esc(d.baseUrl)} · API Key ` +
        (d.keyConfigured
          ? '<span class="ok-text">已配置</span>'
          : '<span class="bad-text">未配置（编辑 .env 后重启 node server.js）</span>');
      return;
    }
    throw new Error('ok = false');
  } catch (e) {
    els.healthBar.className = 'health-bar bad';
    els.healthText.textContent = '本地服务异常：' + ((e && e.message) || e);
  }
}

/* ==================== 初始化 ==================== */

function init() {
  els.tabs.forEach((b) => b.addEventListener('click', () => switchModel(b.dataset.model)));

  els.textInput.addEventListener('input', () => { updateCharCount(); updatePreview(); });
  els.userInput.addEventListener('input', updatePreview);
  els.voiceSelect.addEventListener('change', updatePreview);
  els.formatSelect.addEventListener('change', updatePreview);
  els.optimizeCheck.addEventListener('change', () => { updateTextNote(); updatePreview(); });

  els.generateBtn.addEventListener('click', generate);
  els.downloadBtn.addEventListener('click', downloadAudio);

  els.fileInput.addEventListener('change', (e) => {
    handleFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });
  els.recordBtn.addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  els.clearSampleBtn.addEventListener('click', clearSample);
  els.compressBtn.addEventListener('click', compressSample);

  els.expertCheck.addEventListener('change', onExpertToggle);
  els.regenPreviewBtn.addEventListener('click', () => { els.previewArea.value = previewJSON(); });

  updateCharCount();
  switchModel('mimo-v2.5-tts');
  checkHealth();
  els.textInput.focus();
}

init();
