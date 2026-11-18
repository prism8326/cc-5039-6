# 授权教学媒体播放实验

用自制课程短片、测试密钥与浏览器 **ClearKey 测试密钥系统**，完整走一遍：

1. 用 ISO/IEC 23001-7 **CENC** 对自制媒体做实际加密封装；
2. 由本地许可端按「资产 + 密钥标识」发放测试许可；
3. 在浏览器里经 EME + MSE **真实解密并出帧**；
4. 用五阶段状态机区分「许可取得」「密钥可用」「媒体实际可解码」。

> **保护强度说明**：ClearKey 是**软件测试密钥系统**。密钥在客户端软件中可用，没有硬件信任根、
> 没有防篡改边界，无法抵御对播放环境有控制权的用户提取或替换密钥材料。
> 它**不具备**商业硬件 DRM（如 Widevine L1、PlayReady SL3000、FairPlay）的保密与健壮性保证。
> 本实验只服务本地虚构课程与授权链路教学，不绕过任何第三方内容保护，也不应被宣传为商业 DRM。

---

## 图形入口（主要交付）

```bash
npm install
npm run package:media   # 首次运行：生成加密封装（可重复执行）
npm start               # 启动本地服务
```

打开 **http://127.0.0.1:4173/** ：

- 左侧是加密教学图形播放器：可**选择测试凭据**、选择实验场景，点「开始实验」播放；
- 右侧结果区呈现**授权状态**（五阶段）与真实解密画面；
- 所有交互由页面内的加密教学内核驱动，失败会回到内核事件区与播放器遮罩。

图形入口就是 `ui/index.html`，由 `server/app.mjs` 提供；命令行工具只是辅助。

> 浏览器要求：支持 EME ClearKey 且具备 H.264/AAC 解码能力的 Chromium 系浏览器
> （Chrome for Testing、Google Chrome、新版 Edge 均可）。若系统未安装浏览器运行库，
> 见文末「无 root 的 Linux 验证环境」。

---

## 图形界面能做什么

| 区域 | 说明 |
| --- | --- |
| 测试凭据 | 选择用于本轮的测试密钥标识；主标识与封装清单一致，备用标识用于错误密钥场景。 |
| 实验场景 | 正常播放、改动初始化数据、错误密钥、许可端断开，另有两条诊断。 |
| 播放器 | 只有真实解密出帧后才会显示画面；遮罩文字来自内核失败反馈。 |
| 授权状态 | 五个阶段：测试密钥系统 → 密钥会话 → 许可取得 → 密钥可用 → 媒体实际可解码。 |
| 内核事件 | 逐条记录初始化数据、许可响应、密钥状态与解码帧数。 |

**判定原则**：收到许可响应不会直接显示授权成功。只有许可取得、密钥可用、媒体实际可解码
三个阶段全部成立，结果区才显示「已验证」。任何阶段失败，后续阶段标记为「已中止」。

---

## 实验场景与预期

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| 正常播放 | 主标识，初始化数据与封装一致 | 五阶段全部通过，画面真实推进 |
| 改动初始化数据 | 把 pssh 中的 KID 改成未知标识 | 许可取得失败：`unknown-kid`（HTTP 403） |
| 错误密钥 | 使用与本片不匹配的备用标识 | 许可取得失败：`credential-key-mismatch`（HTTP 403） |
| 许可端断开 | 请求未监听的本地端口 | 许可取得失败：网络不可达 |
| 诊断：会话创建失败 | 请求 `persistent-license` 会话 | 密钥会话失败：`NotSupportedError` |
| 诊断：正确许可 + 错误密钥材料 | 许可 200，客户端密钥材料被替换 | 密钥状态仍 usable，但**解码失败**，验证「密钥可用 ≠ 画面可解码」 |

许可端只服务本地虚构课程；错误密钥、未知标识、未知资产、格式错误、会话类型不支持分别返回
不同状态码与原因，且**不输出密钥材料到普通日志**（日志只含密钥标识的短指纹）。

---

## 真实加密封装（可重复）

```bash
npm run package:media
```

产物在 `media/packaged/lesson-authorization-01/`：

- `video-init.mp4` / `audio-init.mp4`：含 `pssh` 与 `tenc` 的加密初始化段；
- `video-seg-N.m4s` / `audio-seg-N.m4s`：CENC 加密分片；
- `manifest.json`：密钥标识、分片清单、逐文件 SHA-256，供播放内核与校验使用。

可重复性来自三处固定：源滤镜 `seed`、`libx264` 单线程 `deterministic=1`、Shaka Packager
固定测试 IV。封装后还将初始化段的创建/修改时间归一化。因此同一台机器上重复运行
`npm run package:media`，`manifest.json` 中的 `bundleSha256` 与所有分片哈希逐字节一致。

> 测试密钥材料不在媒体目录里，也不进客户端代码；它只由本地许可端按标识匹配后发放。

---

## 许可端

```bash
npm run license:demo
```

该 CLI 与图形入口调用**同一个**许可内核（`server/license-service.mjs`），依次演练：
正常许可、未知标识、凭据不匹配、未知资产、不支持的会话类型，并打印每轮的响应分类与
脱敏日志，最后检查日志是否泄露密钥材料。命令行只用于辅助核对，**不是**主要入口。

接口：`POST /api/license`

```json
{ "assetId": "lesson-authorization-01", "kids": ["<base64url KID>"], "sessionType": "temporary" }
```

成功响应只含与请求标识匹配的课程密钥：

```json
{ "keys": [{ "kty": "oct", "kid": "…", "k": "…" }], "type": "temporary", "assetId": "lesson-authorization-01" }
```

失败分类：`unknown-kid`、`credential-key-mismatch`、`asset-not-found`、`malformed-request`、
`unsupported-session-type`。

---

## 验证

```bash
npm run verify:flow     # 许可内核断言（含日志脱敏检查）
npm run verify:browser  # 真实浏览器：六个场景 + 界面状态 + 播放推进
```

`verify:browser` 通过页面控件选择场景与凭据、点击「开始实验」，然后断言：

- 正常场景五阶段全绿、`已验证`、无失败提示，且播放时钟推进、帧数增长；
- 其余场景在预期阶段失败、界面显示 `未通过`，且不会误报成功；
- 截图保存在 `.verify/`。

已验证的观测（本机 Chrome 158 / Linux arm64）：正常场景 1.5 秒内播放位置
`0.30s → 1.80s`、解码帧 `11 → 47`；错误密钥材料时密钥状态为
`usable` 但媒体报 `PIPELINE_ERROR_DECODE`，界面停在「媒体实际可解码」。

---

## 保护强度范围（务必阅读）

| 能力 | 本实验（ClearKey 软件测试密钥） | 商业硬件 DRM |
| --- | --- | --- |
| 抽样加密与解密链路 | 有（真实 CENC + EME） | 有 |
| 密钥在客户端可用 | 是（软件内存中） | 通常受限，部分在 TEE/安全硬件内 |
| 硬件信任根 / 防篡改 | 无 | 有（依等级） |
| 抗终端用户提取密钥 | 无 | 依等级提供 |
| 输出保护（HDCP 等） | 无 | 有 |
| 适合真实版权内容 | **否** | 是 |

因此：**不能**把本实验的软件测试密钥流程宣传为已具备商业硬件 DRM 的所有能力。

---

## 目录

```
config/lesson.json          课程、凭据、场景、保护强度声明（无密钥材料）
config/test-keys.json       测试密钥材料（仅许可端读取）
config/package.json         封装参数
media/source/lesson.ass     自制裁剪字幕
media/source/fonts/         字幕字形子集（随项目交付，保证可重复封装）
tools/package-media.mjs     可重复 CENC 封装
tools/license-demo.mjs      许可演练 CLI（辅助）
server/license-service.mjs  许可内核（图形与 CLI 共用）
server/app.mjs              静态服务 + 许可接口
shared/stages.js            阶段、判定与原因文案
ui/js/kernel.js             加密教学内核（驱动控件与状态判定）
ui/js/app.js                图形界面
tests/flow.test.mjs         许可断言
tests/browser-playback.mjs  浏览器端到端验证
```

## 无 root 的 Linux 验证环境

若机器缺少 Chromium 运行库，可把 Debian 包解包到本地目录，测试脚本会自动加入
`LD_LIBRARY_PATH`，也可用 `BROWSER_LIB_DIR` 指定。浏览器可用 `BROWSER_BIN` 指定，
或放置在 `.chrome/`（例如 `@puppeteer/browsers` 的安装结果）。这些目录都已在 `.gitignore` 中。
