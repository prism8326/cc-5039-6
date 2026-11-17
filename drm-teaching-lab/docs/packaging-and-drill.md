# 可复现的加密封装与许可演练

所有步骤都可在干净环境中从零重放；默认使用**确定性**测试密钥与确定性 IV，因此同一输入产出一致结果，
便于教学比对与自动化断言。

## 1. 准备依赖

```bash
npm install
```

依赖仅含 `ffmpeg-static`（生成自制教学画面/音频）与 `playwright`（驱动真实 Chrome 做端到端验证）。

## 2. 生成测试密钥

```bash
npm run keygen
```

- 两门虚构课程各得到一对 16 字节 KID / 16 字节 KEY（AES-128）。
- 默认 `deterministic` 模式：由固定种子经 SHA-256 派生，重跑结果一致；加 `--random` 可改为随机。
- 写入 `keys/courses.json`，权限 `0600`；控制台只打印 KID，KEY 以 `***` 占位。
- 该文件仅存本地测试密钥，已被 `.gitignore` 忽略，**禁止用于生产或真实内容**。

## 3. 加密封装

```bash
npm run package     # 或 npm run build 一步完成 keygen + package
```

每门课程执行：

1. ffmpeg 用 `testsrc2` + `sine` 合成自制视频/音频，切成约 2 秒的 fMP4 分片（明文，存 `plain/`）。
2. `bin/cenc-postprocess.js` 对每个分片做 CENC-AES-CTR 加密封装（存 `enc/`），改写样本条目、注入
   PSSH/tenc，并在每个 `traf` 写入完整 CENC v1 信令（见 [architecture.md](architecture.md)）。
3. 生成 `manifest.json`（codecs、分片 URL、KID、scheme 等）与 `verify-report.json`。

封装阶段自带的校验会确认：密文与明文字节不同、明文不含加密盒、`encv/enca/sinf/tenc/saiz/saio/pssh`
齐全、tenc KID 与清单一致。端到端测试前还有独立脚本对全部样本解密并与明文**逐字节比对**。

## 4. 启动图形播放器

```bash
npm start
```

打开输出中的图形入口（默认 `http://127.0.0.1:8088/`）。选择课程与场景后点击「播放」，观察：

- 三阶段授权状态灯（① 许可取得 / ② 密钥 usable / ③ 真实可解码）；
- 状态机详情与（脱敏的）事件日志；
- 「截取解密画面」按钮与中心像素非全黑断言。

## 5. 许可演练场景与预期结果

| 演练 | 操作 | 阶段① 许可 | 阶段② 密钥 | 阶段③ 解码/画面 |
| --- | --- | --- | --- | --- |
| 正常播放 | scenario=normal | 已取得 | usable | 成功，呈现真实解密画面 |
| 篡改 initData | 勾选「篡改初始化数据」 | 拒绝（CDM 侧结构失效） | 失败 | 无画面 |
| 错误密钥 | scenario=wrong-key | **已取得**（HTTP 200） | 失败（update 拒绝/非 usable） | 拒绝，无画面 |
| 未知 KID | scenario=unknown-kid | 失败（HTTP 404 unknown_kid） | 不进入 | 无画面 |
| 会话创建失败 | scenario=session-fail | 失败（HTTP 500） | 不进入 | 无画面 |
| 许可端断开 | scenario=offline | 失败（fetch/503） | 不进入 | 无画面 |
| 明文对照 | 勾选「明文对照组」 | 不点亮（标注非加密链验证） | 不点亮 | 明文可播，但不算加密链成功 |

注意「错误密钥」与「未知 KID」的差别：前者许可响应**确实送达**（阶段①达成），只是其中的 KEY 无法
让 CDM 进入 usable；后者请求在许可端即因 KID 未登记被 404 拒绝（阶段①就失败）。

## 6. 自动化验证

```bash
npm test
```

- `test/packaging.test.js`：加密盒完整性、KID 一致、密文≠明文。
- `test/license.test.js`：五类场景的 HTTP 行为、状态接口与日志不含 KEY 明文、畸形请求 400。
- `test/e2e.playwright.js`：真实 Chrome for Testing + Xvfb，跑通上表全部场景；正常场景断言
  `readyState`、640×360 尺寸、播放时间推进与画布中心像素非全黑，失败场景断言对应里程碑被拒、无画面。

## 7. 一致性保证（PSSH / KID / 许可响应）

- 分片 `tenc` 与 `pssh` 使用同一个课程 KID；
- 前端从分片 `moov` 提取该 PSSH 作为 initData，发起 ClearKey 请求；
- 许可服务按请求中的 KID 在本地课程库查找，normal 场景返回与该 KID 严格配对的 KEY；
- 三者一致时 CDM 才会把密钥标记为 `usable` 并成功解密；任一环节被替换（错误 KEY / 未知 KID /
  被篡改的 initData）都会在对应阶段被显式拒绝。
