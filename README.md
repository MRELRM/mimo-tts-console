# MiMo V2.5-TTS 三合一测试台

本地运行的 [小米 MiMo V2.5-TTS](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5) 调试控制台，一个页面覆盖三个模型：

| 模型 | 用途 | audio.voice 取值 |
|---|---|---|
| `mimo-v2.5-tts` | 预置音色语音合成 | 预置音色 ID（如 `冰糖`） |
| `mimo-v2.5-tts-voicedesign` | 音色设计（自然语言描述想要的声音） | 不传 |
| `mimo-v2.5-tts-voiceclone` | 音色克隆（上传/录制样本） | Base64 音频 Data URL（≤ 10 MB） |

**特点：零 npm 依赖**（Node 原生 `http`/`https`，不用 Express）、原生 HTML/CSS/JS 前端（无构建工具）、API Key 只保存在服务端 `.env` 中，浏览器端代码与网络请求里均不出现密钥，相同请求命中本地缓存不重复消耗额度。

---

## 快速开始

### 方式一：便携发布包（推荐，无需安装 Node.js）

从 Releases 下载 `mimo-tts-console-v1.0.0-win-x64-portable.zip`，解压后双击 **`start.bat`**：

1. 首次运行会自动从 `.env.example` 生成 `.env`，并在记事本中打开，填写 `MIMO_API_KEY=你的Key` 后保存并关闭记事本
2. 服务自动启动，浏览器自动打开 `http://127.0.0.1:8787`
3. 停止服务：直接关闭命令行窗口；修改 `.env` 后需重新双击 `start.bat`

> 便携包内置 Node.js v24 运行时（win-x64），无需任何运行环境与依赖安装。
> 若 zip 从网络下载后解压，Windows 可能因「下载文件保护（SmartScreen）」弹出安全提示，选择「仍要运行/运行」即可；本程序完全本地运行，不会上传任何数据（调用 MiMo API 由本机服务端直连）。

### 方式二：源码运行（需 Node.js 18+，无需 `npm install`）

```bash
# 1. 进入目录
cd mimo-tts-console

# 2. 复制配置文件并填入你的 Key
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env

# 3. 启动（也可直接双击 start.bat，未检测到内置 node.exe 时会回退系统 Node）
node server.js

# 4. 打开页面
# http://127.0.0.1:8787
```

### 配置说明（.env）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `MIMO_API_KEY` | 是 | — | 你的 MiMo API Key，仅保存在服务端 |
| `MIMO_API_BASE_URL` | 否 | `https://api.xiaomimimo.com/v1` | Token Plan 国内集群改为 `https://token-plan-cn.xiaomimimo.com/v1` |
| `PORT` | 否 | `8787` | 本地服务端口 |
| `HOST` | 否 | `127.0.0.1` | 监听地址 |

> 修改 `.env` 后需重启 `node server.js`。页面顶部健康栏实时显示 Key 配置状态；健康检查接口：`GET /api/health` 返回 `{ ok: true, keyConfigured, baseUrl }`。

---

## 接口调用要点（踩坑汇总）

MiMo TTS **不是** OpenAI 的 `/audio/speech` 端点，而是复用 OpenAI 兼容的 **Chat Completions** 接口：

- **端点**：`POST {MIMO_API_BASE_URL}/chat/completions`
- **请求头**：`api-key: <MIMO_API_KEY>` + `Content-Type: application/json`。**不要用 `Authorization: Bearer`**——Token Plan 的 `tp-` 开头 Key 在部分环境下用 Bearer 会 401，官方推荐 `api-key` 请求头。
- **消息角色分工**（最容易出错的地方）：
  - `assistant` 消息的 `content` = **待合成正文**（必填，voicedesign 勾选 optimize 时可省略）
  - `user` 消息的 `content` = 风格指令或音色描述。对 `mimo-v2.5-tts` 可选；对 `voicedesign` 必填；对 `voiceclone` 可留空
  - **绝对不能把正文放在 user 消息里**，否则报 `messages must contain an assistant role for TTS model`
- **audio.format**：支持 `wav` / `mp3` / `pcm` / `pcm16`，**不支持 opus 和 aac**（传了报错）。流式拼接用 `pcm16`。
- **音色克隆**：`audio.voice` 不是音色 ID，而是样本的 Base64 Data URL（`data:audio/mpeg;base64,<BASE64>` 或 `data:audio/wav;base64,<BASE64>`），Base64 字符串大小 ≤ 10 MB，仅支持 mp3/wav。浏览器录音得到 webm 需先转 wav/mp3。
- **音色设计**：可选 `audio.optimize_text_preview: true`，让模型自动润色播报文本，此时 assistant 消息可省略。
- **返回结构**：音频在 `response.choices[0].message.audio.data`（Base64 字符串），解码后即可播放/写文件。
- **流式说明**：voiceclone 与 voicedesign 的低延迟流式尚未真正上线（流式调用会降级为全部生成完后一次返回），本测试台统一走非流式调用。

### 请求示例

```json
{
  "model": "mimo-v2.5-tts",
  "messages": [
    { "role": "user", "content": "可选：风格指令" },
    { "role": "assistant", "content": "必填：要朗读的正文" }
  ],
  "audio": {
    "voice": "冰糖",
    "format": "wav"
  }
}
```

### 预置音色列表（mimo-v2.5-tts）

| 音色 | Voice ID | 语言 | 性别 |
|---|---|---|---|
| 冰糖 | `冰糖` | 中文 | 女性 |
| 茉莉 | `茉莉` | 中文 | 女性 |
| 苏打 | `苏打` | 中文 | 男性 |
| 白桦 | `白桦` | 中文 | 男性 |
| Mia | `Mia` | 英文 | 女性 |
| Chloe | `Chloe` | 英文 | 女性 |
| MiMo-默认 | `mimo_default` | 因集群而异 | — |

---

## 页面功能

- **模型切换**：顶部 Tab 切换三个模型，表单字段自动联动（预置音色下拉 / 音色描述 / optimize 复选框 / 样本上传区按需显隐）
- **克隆样本**：支持上传 mp3/wav 与浏览器录音。录音用 `MediaRecorder` 采集 webm 后，前端通过 Web Audio API 自动转码为 16kHz 单声道 WAV 再生成 Data URL；上传文件超 10 MB 时提供「转码压缩」按钮，压缩后仍超限则阻止发送
- **请求 JSON 预览**：发送前可查看完整 payload，克隆样本 Base64 以 `__VOICE_SAMPLE__` 占位符显示（附长度与前 100 字符）。**专家模式**勾选后可直接编辑 JSON 发送，用于复现报错等调试，占位符自动替换为完整内容
- **播放与下载**：Blob + `URL.createObjectURL` 生成播放器；下载文件名 `mimo-tts-{model}-{timestamp}.{format}`；pcm/pcm16 仅支持下载
- **缓存**：以完整 payload 的 SHA-256 为 key 缓存到 `.cache/tts/`，相同请求直接返回并在 UI 标注「命中本地缓存 · 未调用 MiMo API」

## 后端接口（本测试台自身）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/tts` | POST | 接收 `{ model, messages, audio }`，原样转发到 MiMo，成功返回 `{ success: true, audio: "<base64>", format, cached, cacheKey }`，失败返回 `{ success: false, status, error }`（status 与响应体原样透传） |
| `/api/health` | GET | 健康检查，返回 `{ ok: true, keyConfigured, baseUrl }` |

## 错误排查速查

| 现象 | 原因与建议 |
|---|---|
| HTTP 401 | 检查 `.env` 中的 Key；MiMo 要求 `api-key` 请求头而非 Bearer（本服务已按官方实现），改 Key 后需重启 |
| `Param Incorrect` | voiceclone 不能选预置音色；voice 字段类型不对；克隆样本 Base64 超 10 MB |
| `messages must contain an assistant role for TTS model` | 正文没放在 assistant 消息中，user 只放风格指令/音色描述 |
| HTTP 413 / 体积报错 | 克隆样本过大，用页面「转码压缩」或截取约 4 分钟内片段 |
| 连接失败 | 检查网络/DNS，或 `.env` 的 `MIMO_API_BASE_URL` 是否正确 |
| format 报错 | 仅支持 wav/mp3/pcm/pcm16，不支持 opus/aac |

页面收到错误时会以红框展示原始响应，并自动附上对应的中文排查建议。

## 目录结构

```
mimo-tts-console/
├── .env               # 你的本地配置（首次运行 start.bat 自动生成；不入库不打包）
├── .env.example       # 配置示例
├── server.js          # 零依赖后端：静态托管 + /api/tts 代理 + SHA-256 缓存
├── start.bat          # 一键启动（便携包/源码均可用）
├── public/
│   ├── index.html     # 页面结构
│   ├── style.css      # 深色控制台主题
│   └── app.js         # 前端逻辑（模型联动 / 录音转码 / 预览 / 播放下载）
├── .cache/tts/        # 音频缓存（运行时自动创建，可随时删除）
└── 【仅便携发布包额外包含】
    ├── node.exe       # 内置 Node.js v24 运行时（win-x64）
    └── LICENSE-NODE.txt  # Node.js 官方许可证（随包分发需保留）
```

## 常见问题

- **生成的音频在哪里？** 在页面播放器中播放/下载；同时以 Base64 缓存在服务端 `.cache/tts/` 目录。
- **如何清空缓存？** 直接删除 `.cache/tts/` 目录即可，不影响运行。
- **换电脑还能用吗？** 可以。直接拷贝整个解压后的文件夹（含 `.env`）到新机器双击 `start.bat`；或重新下载便携包。也可用源码方式（需 Node 18+）。
- **端口被占用？** 修改 `.env` 中的 `PORT` 后重启。

## 参考

- [MiMo 官方文档 · 语音合成 V2.5](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)
- [社区零依赖测试台 rholin33/mimotts](https://github.com/rholin33/mimotts)
- [端点/参数踩坑记录 wwwzhouhui/skills_collection](https://github.com/wwwzhouhui/skills_collection)
- [PHP 实现参考（腾讯云开发者社区）](https://developer.cloud.tencent.cn/article/2730358)

> AI生成
