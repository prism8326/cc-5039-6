# 授权教学媒体播放实验（ClearKey EME + CENC）

一个**完全本地、可复现**的教学实验：用自制内容和测试密钥做真实的 CENC 加密封装，再通过浏览器原生
支持的 **W3C ClearKey 测试密钥系统（`org.w3.clearkey`）与 EME 加密媒体扩展接口**完成许可获取、
密钥可用性确认、MSE 喂入与真实解密播放。

> 仅用于本地虚构课程的授权教学。不涉及、也不绕过 Widevine / PlayReady / FairPlay 等任何第三方商业
> 内容保护；测试密钥禁止用于生产环境或真实内容。保护强度边界见
> [docs/scope-and-limitations.md](docs/scope-and-limitations.md)。

## 它验证的是一条“真加密链”，而不是“能播放”

本实验严格区分三个阶段，任何一阶段未达成都不会显示授权成功：

1. **① 许可取得（license received）** —— 仅代表收到了 ClearKey 许可响应，不代表密钥可用；
2. **② 密钥可用（key usable）** —— CDM 的 `keystatuseschange` 报告该 KID 状态为 `usable`；
3. **③ 媒体实际可解码（decodable）** —— 视频元素触发 `loadeddata`，并在画布上截到**非全黑的真实解密画面**。

另外提供**明文对照组**：未加密分段确实能播放，但界面明确标注「不是加密链验证」，且不会点亮任何
EME 里程碑，避免把“明文能播”误判为“加密链打通”。

## 图形播放器入口（主要使用方式）

```bash
npm install        # 安装 playwright / ffmpeg-static 等依赖
npm run build      # 生成测试密钥库 + 加密封装两门虚构课程（可复现）
npm start          # 启动本地服务，默认 http://127.0.0.1:8088/
```

启动后在浏览器打开终端打印的 **图形播放器入口 `http://127.0.0.1:8088/`**，即可：

- 在下拉框选择虚构课程（测试凭据）；
- 切换许可端演练场景（正常 / 错误密钥 / 未知 KID / 会话创建失败 / 许可端断开）；
- 可选「篡改初始化数据」或「明文对照组」；
- 点击播放，观察三阶段授权状态灯、状态机详情、解密画面截图与（不含密钥明文的）事件日志。

CLI（`npm run build`、各测试脚本）只负责封装与自动化校验，**图形界面才是实验主入口**。

## 可复现的命令

| 命令 | 作用 |
| --- | --- |
| `npm run keygen` | 确定性派生两门课程的测试 KID/KEY，写入 `keys/courses.json`（权限 0600） |
| `npm run package` | ffmpeg 生成分片 → 自研 CENC 后处理加密封装 → 结构与密文校验 |
| `npm run build` | 等价于 keygen + package |
| `npm start` | 启动带图形播放器与许可接口的本地服务 |
| `npm test` | 依次运行封装结构、许可服务、端到端 EME 三套测试 |

端到端测试使用 Playwright 驱动真实的 Chrome for Testing（通过 Xvfb 提供显示环境），在真实 CDM 上
验证 ClearKey 解密，而不是用桩件模拟。

## 目录导航

- [docs/architecture.md](docs/architecture.md) —— 组件、数据流与三阶段状态机
- [docs/packaging-and-drill.md](docs/packaging-and-drill.md) —— 可复现的加密封装与许可演练细节
- [docs/scope-and-limitations.md](docs/scope-and-limitations.md) —— 软件测试密钥的保护强度边界
- `bin/` —— 密钥生成、ffmpeg 封装、ISOBMFF/CENC 加密封装、服务启动
- `server/` —— 本地 ClearKey 许可服务（含四类失败演练）
- `player/` —— 图形播放器与 EME 教学内核
- `test/` —— 封装、许可、端到端三套自动化测试

## 安全约定

- 普通日志与 `/api/state` **绝不输出 KEY 明文**；KID 仅以前缀脱敏形式出现，许可响应显式标注
  `keyMaterialReturned:false`。
- 密钥库 `keys/courses.json` 已在 `.gitignore` 中忽略，文件权限 0600。
- 许可服务只登记两门本地虚构课程；未登记 KID 返回 404，不提供任何真实内容的密钥。
