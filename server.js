#!/usr/bin/env node
'use strict';

/**
 * MiMo V2.5-TTS 三合一测试台 · 零依赖本地服务
 *
 * 职责：
 *   1. 托管 public/ 下的静态页面（原生 http 模块，无 Express、无任何 npm 依赖）
 *   2. POST /api/tts —— 把前端 payload 原样转发到 MiMo 的
 *      {MIMO_API_BASE_URL}/chat/completions（OpenAI 兼容 Chat 接口），
 *      请求头按官方要求使用 api-key，而不是 Authorization: Bearer
 *   3. GET /api/health —— 健康检查
 *   4. 以整个 payload 的 SHA-256 为 key，把生成的 Base64 音频缓存到 .cache/tts/，
 *      相同请求命中缓存时不再调用 MiMo API
 *
 * 安全：API Key 只存在于本进程内存与 .env 文件中，永远不会下发给浏览器。
 * 运行：node server.js，然后打开 http://127.0.0.1:8787
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ==================== 配置加载（.env，进程环境变量优先） ==================== */

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value[0] === '"' && value[value.length - 1] === '"') ||
         (value[0] === "'" && value[value.length - 1] === "'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv() {
  try {
    return parseEnvText(fs.readFileSync(path.join(__dirname, '.env'), 'utf8'));
  } catch (e) {
    return {};
  }
}

const dotEnv = loadDotEnv();
function cfg(name, fallback) {
  const v = process.env[name] !== undefined ? process.env[name] : dotEnv[name];
  return v === undefined || v === '' ? fallback : v;
}

const MIMO_API_KEY = cfg('MIMO_API_KEY', '');
// .env.example 中的占位符值：视为未配置，避免用户忘填 Key 时页面误显示“已配置”
const KEY_PLACEHOLDER = '你的Key';
const keyConfigured = MIMO_API_KEY.length > 0 && MIMO_API_KEY !== KEY_PLACEHOLDER;
const MIMO_API_BASE_URL = String(cfg('MIMO_API_BASE_URL', 'https://api.xiaomimimo.com/v1')).replace(/\/+$/, '');
const PORT = parseInt(cfg('PORT', '8787'), 10) || 8787;
const HOST = cfg('HOST', '127.0.0.1');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, '.cache', 'tts');

const ALLOWED_MODELS = [
  'mimo-v2.5-tts',
  'mimo-v2.5-tts-voicedesign',
  'mimo-v2.5-tts-voiceclone',
];
const MAX_VOICE_CHARS = 10 * 1024 * 1024;   // 音色克隆样本 Base64 字符数上限（10 MB）
const BODY_LIMIT = 13 * 1024 * 1024;         // 请求体读取上限（为 10 MB Base64 留出 JSON 外壳余量）
const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;   // 上游生成可能较慢，给 5 分钟

fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ==================== 小工具 ==================== */

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    /* 客户端可能已断开连接，忽略写入失败 */
  }
}

/** 读取请求体，超过 limit 时 resolve(null)（不中断连接，保证能回 413 JSON） */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** 向 MiMo 上游发起 POST，返回 { status, body } */
function requestUpstream(urlString, bodyStr, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      return reject(new Error(`无效的上游地址：${urlString}`));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const body = Buffer.from(bodyStr, 'utf8');
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: Object.assign({}, headers, { 'Content-Length': body.length }),
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          resolve({
            status: resp.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`上游请求超时（${Math.round(timeoutMs / 1000)} 秒）`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** 从 MiMo 响应中提取 choices[0].message.audio.data（Base64 字符串） */
function extractAudioData(json) {
  try {
    const a = json &&
      json.choices &&
      json.choices[0] &&
      json.choices[0].message &&
      json.choices[0].message.audio &&
      json.choices[0].message.audio.data;
    return typeof a === 'string' && a.length > 0 ? a : null;
  } catch (e) {
    return null;
  }
}

/** 转发前的本地结构校验（只做最小校验，结构性错误交给上游返回原始报错便于调试） */
function validatePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '请求体必须是 JSON 对象';
  if (!ALLOWED_MODELS.includes(p.model)) return `model 必须是以下之一：${ALLOWED_MODELS.join(' / ')}`;
  if (!Array.isArray(p.messages) || p.messages.length === 0) return 'messages 必须是非空数组';
  for (const m of p.messages) {
    if (!m || typeof m !== 'object') return 'messages 中存在非法消息';
    if (m.role !== 'user' && m.role !== 'assistant') return `消息 role 仅支持 user / assistant（收到 "${m.role}"）`;
    if (typeof m.content !== 'string') return `消息 content 必须是字符串（当前类型：${m.content === null ? 'null' : typeof m.content}）`;
  }
  const audio = p.audio;
  if (!audio || typeof audio !== 'object' || Array.isArray(audio)) return 'audio 必须是对象';
  // audio.voice 按模型分别校验（官方文档口径：
  //   mimo-v2.5-tts          → 必填预置音色 ID；
  //   voiceclone             → 必填音频样本 Data URL；
  //   voicedesign            → 音色由 user 消息的描述文本决定，audio 中不应传 voice）
  if (p.model === 'mimo-v2.5-tts') {
    if (typeof audio.voice !== 'string' || audio.voice.length === 0) {
      return 'mimo-v2.5-tts 的 audio.voice 必须是非空字符串（预置音色 ID，如 mimo_default / 冰糖 / Chloe）';
    }
  } else if (p.model === 'mimo-v2.5-tts-voiceclone') {
    if (typeof audio.voice !== 'string' || audio.voice.length === 0) {
      return 'voiceclone 的 audio.voice 必须是形如 data:audio/mpeg;base64,<BASE64> 的音频样本 Data URL（不能为空）';
    }
    if (!/^data:[^;]+;base64,/i.test(audio.voice)) {
      return 'voiceclone 的 audio.voice 必须是形如 data:audio/mpeg;base64,<BASE64> 的音频样本 Data URL（不能填预置音色 ID）';
    }
    if (audio.voice.length > MAX_VOICE_CHARS) {
      return `音频样本 Base64 后为 ${(audio.voice.length / 1024 / 1024).toFixed(2)} MB，超过 10 MB 上限，请压缩转码或截取片段`;
    }
  } else if (p.model === 'mimo-v2.5-tts-voicedesign' && audio.voice !== undefined) {
    return 'voicedesign 模型不支持 audio.voice：音色由 user 消息中的音色描述文本决定，请从 audio 中删除 voice 字段';
  }
  if (audio.format !== undefined && typeof audio.format !== 'string') {
    return 'audio.format 必须是字符串（wav / mp3 / pcm / pcm16）';
  }
  if (audio.optimize_text_preview !== undefined && typeof audio.optimize_text_preview !== 'boolean') {
    return 'audio.optimize_text_preview 必须是布尔值（true / false），仅 voicedesign 模型支持';
  }
  return null;
}

/** 请求摘要（日志用，绝不打印 Key 与完整 Base64） */
function payloadSummary(p) {
  const msgs = Array.isArray(p.messages)
    ? p.messages.map((m) => `${m.role}(${String(m.content).length}字符)`).join(' + ')
    : '无';
  let voice = '无';
  if (p.audio && typeof p.audio.voice === 'string') {
    voice = p.audio.voice.startsWith('data:')
      ? `样本Base64(${p.audio.voice.length}字符)`
      : p.audio.voice;
  }
  const format = p.audio && p.audio.format ? p.audio.format : '默认';
  return `model=${p.model} messages[${msgs}] voice=${voice} format=${format}`;
}

/* ==================== 缓存（SHA-256 key → .cache/tts/<key>.json） ==================== */

function cacheFileFor(key) {
  return path.join(CACHE_DIR, key + '.json');
}

function readCache(key) {
  try {
    return JSON.parse(fs.readFileSync(cacheFileFor(key), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(key, entry) {
  try {
    fs.writeFileSync(cacheFileFor(key), JSON.stringify(entry));
    return true;
  } catch (e) {
    log('缓存写入失败（不影响本次请求）：', e.message);
    return false;
  }
}

/* ==================== API 处理 ==================== */

function handleHealth(res) {
  sendJson(res, 200, {
    ok: true,
    keyConfigured,
    baseUrl: MIMO_API_BASE_URL,
    port: PORT,
    models: ALLOWED_MODELS,
    time: new Date().toISOString(),
  });
}

async function handleTts(req, res) {
  const started = Date.now();

  let raw;
  try {
    raw = await readBody(req, BODY_LIMIT);
  } catch (e) {
    return sendJson(res, 200, { success: false, status: 400, error: `读取请求体失败：${e.message}` });
  }
  if (raw === null) {
    return sendJson(res, 200, {
      success: false,
      status: 413,
      error: `请求体超过本地代理上限（${fmtBytes(BODY_LIMIT)}）。音色克隆样本 Base64 后不能超过 10 MB，请压缩转码或截取片段。`,
    });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return sendJson(res, 200, { success: false, status: 400, error: `请求体不是合法 JSON：${e.message}` });
  }

  const invalid = validatePayload(payload);
  if (invalid) {
    log('拒绝请求（本地校验）：', invalid);
    return sendJson(res, 200, { success: false, status: 400, error: invalid });
  }

  log('收到请求：', payloadSummary(payload));

  // 以完整 payload 的 SHA-256 作为缓存 key
  const payloadStr = JSON.stringify(payload);
  const cacheKey = crypto.createHash('sha256').update(payloadStr, 'utf8').digest('hex');
  const hit = readCache(cacheKey);
  if (hit && typeof hit.audio === 'string') {
    log(`命中缓存 key=${cacheKey.slice(0, 16)}… 直接返回，未调用 MiMo API`);
    return sendJson(res, 200, Object.assign({ success: true, cached: true, cacheKey }, hit));
  }

  if (!keyConfigured) {
    return sendJson(res, 200, {
      success: false,
      status: 500,
      error: MIMO_API_KEY
        ? '服务端检测到 MIMO_API_KEY 仍是占位符“你的Key”：请编辑 .env 填入真实 Key 后，关闭窗口并重新双击 start.bat（或重启 node server.js）。'
        : '服务端未配置 MIMO_API_KEY：请将 .env.example 复制为 .env，填入 MIMO_API_KEY=你的Key 后重启 node server.js。',
    });
  }

  log(`调用上游 ${MIMO_API_BASE_URL}/chat/completions（payload ${fmtBytes(Buffer.byteLength(payloadStr))}）…`);
  let upstream;
  try {
    upstream = await requestUpstream(
      MIMO_API_BASE_URL + '/chat/completions',
      payloadStr,
      {
        'api-key': MIMO_API_KEY,          // 官方要求：不要用 Authorization: Bearer
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      UPSTREAM_TIMEOUT_MS
    );
  } catch (e) {
    log('上游请求失败：', e.message);
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: `无法连接 MiMo API（${MIMO_API_BASE_URL}）：${e.message}。请检查网络、DNS，或 .env 中的 MIMO_API_BASE_URL 是否正确。`,
    });
  }

  if (upstream.status !== 200) {
    log(`上游返回 HTTP ${upstream.status}`);
    return sendJson(res, 200, { success: false, status: upstream.status, error: upstream.body });
  }

  let json;
  try {
    json = JSON.parse(upstream.body);
  } catch (e) {
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: `MiMo 返回了无法解析的非 JSON 响应：${String(upstream.body).slice(0, 600)}`,
    });
  }

  const audioData = extractAudioData(json);
  if (!audioData) {
    log('上游 200 但缺少 choices[0].message.audio.data');
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: 'MiMo 响应中没有找到 choices[0].message.audio.data 字段（Base64 音频）',
      raw: json,
    });
  }

  const format = (payload.audio && typeof payload.audio.format === 'string' && payload.audio.format) || 'wav';
  const entry = { audio: audioData, format };
  writeCache(cacheKey, entry);
  log(`成功：音频 ${fmtBytes(Buffer.from(audioData, 'base64').length)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，已写缓存`);
  return sendJson(res, 200, Object.assign({ success: true, cached: false, cacheKey }, entry));
}

/* ==================== 静态文件 ==================== */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(pathname, res, isHead) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  const root = path.normalize(PUBLIC_DIR + path.sep);
  if (filePath !== path.normalize(PUBLIC_DIR) && !filePath.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return res.end(isHead ? undefined : '404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(isHead ? undefined : data);
  });
}

/* ==================== 服务器 ==================== */

async function route(req, res) {
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).pathname;
  } catch (e) {
    /* 保持默认 */
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return handleHealth(res);
  }
  if (req.method === 'POST' && pathname === '/api/tts') {
    return handleTts(req, res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(pathname, res, req.method === 'HEAD');
  }
  sendJson(res, 405, { success: false, status: 405, error: '不支持的请求方法：' + req.method });
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => route(req, res))
    .catch((e) => {
      log('处理请求时出错：', e && e.message);
      sendJson(res, 500, { success: false, status: 500, error: '本地服务内部错误：' + ((e && e.message) || e) });
    });
});

// TTS 生成可能超过默认 300s，关闭整体请求超时（上游自身仍有 5 分钟超时兜底）
server.requestTimeout = 0;
server.headersTimeout = 65000;

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('==========================================================');
  console.log('  MiMo V2.5-TTS 三合一测试台 · 本地服务已启动');
  console.log('==========================================================');
  console.log(`  页面地址    http://${HOST}:${PORT}`);
  console.log(`  API 基址    ${MIMO_API_BASE_URL}`);
  console.log(`  API Key     ${keyConfigured ? '已配置' : '未配置（请复制 .env.example 为 .env 并填写 MIMO_API_KEY，然后重启）'}`);
  console.log(`  音频缓存    ${CACHE_DIR}`);
  console.log(`  Node 版本   ${process.version}`);
  console.log('==========================================================');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`启动失败：端口 ${PORT} 已被占用，请修改 .env 中的 PORT 后重试`);
  } else {
    console.error('服务器启动失败：', e && e.message);
  }
  process.exit(1);
});

// 兜底：单个请求异常不应杀掉整个本地服务
process.on('uncaughtException', (e) => {
  console.error(`[${now()}] 未捕获异常（服务继续运行）：`, e && e.message);
});
