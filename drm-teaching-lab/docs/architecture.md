# 架构与数据流

## 组件总览

```
ffmpeg(testsrc2/sine)            bin/keygen.js
        │ 生成分片 fMP4                 │ 派生测试 KID/KEY（0600）
        ▼                               ▼
 content/<course>/plain/*.mp4    keys/courses.json
        │                               │
        └──────────────┬────────────────┘
                       ▼
            bin/cenc-postprocess.js（自研 CENC-AES-CTR 加密封装）
                       │  encv/enca + sinf/tenc + PSSH
                       │  每个 traf：sgpd/sbgp(seig) + saiz/saio(cenc) + senc + trun
                       ▼
            content/<course>/enc/*.mp4 + manifest.json
                       │
        ┌──────────────┴───────────────────────────────┐
        ▼                                                ▼
 player/（图形界面 + EME 教学内核）            server/license-server.js
   • EmeTeachingKernel（状态机）                 • /api/license ClearKey 许可
   • MSE SourceBuffer 喂入加密分片               • /api/scenario 失败演练
   • 画布截图验证真实画面                        • /api/state（不含 KEY）
```

## 加密封装（`bin/cenc-postprocess.js`）

- 读取 ffmpeg 产出的明文分片 fMP4（`empty_moov` + `default_base_moof` + `separate_moof`）。
- 样本条目 `avc1/mp4a` 改写为 `encv/enca`，并嵌入 `sinf → frma/schm(cenc)/schi/tenc`，
  `tenc` 携带本课程 KID、`isProtected=1`、`perSampleIvSize=8`。
- 在 `moov` 注入 ClearKey SystemID 的 `pssh`（v1，含 KID），作为 EME 的 initData 来源。
- 视频样本按 NAL 单元做**子样本加密**（NAL 头/长度字段明文，RBSP 字节进入 AES-CTR 密文区）；
  音频样本整体加密。每个样本的 8 字节 IV 由 `sha256(cenc-iv/<kid>/<fragment>/<sample>)` 确定性派生。

### 为什么需要完整的 CENC v1 信令（关键实现点）

仅在 `traf` 里放 `tenc/senc/saiz/saio` 并不够：浏览器会把样本当作未加密（`encrypted=0`）直接送给
解码器。要让 Chromium 的 ClearKey CDM 真正接管解密，每个 `traf` 必须给出与 W3C web-platform-tests
标准 ClearKey 向量一致的完整 CENC v1 布局：

| 盒子 | 关键设置 | 作用 |
| --- | --- | --- |
| `tfhd` | 含 `default-base-is-moof`（0x020000） | 使 `trun`/`saio` 偏移以 moof 为基 |
| `sgpd` | version=1，grouping_type=`seig`，条目含 isProtected=1、ivSize=8、KID | 定义加密样本组 |
| `sbgp` | grouping_type=`seig`，把分片内全部样本绑定到该组 | 样本↔加密组绑定（缺失即 `encrypted=0`） |
| `saiz` | flags=0x1，aux_info_type=`cenc`，列出每样本辅助信息大小 | 定位样本加密信息 |
| `saio` | version=1、flags=0x1，aux_info_type=`cenc`，64 位偏移 | 指向 `senc` 首条目（moof 相对） |
| `senc` | flags=0x2，含每样本 IV 与子样本 clear/cipher 字节数 | 实际样本加密参数 |
| `trun` | 重新计算 data_offset = moof 长度 + 8 | moof 扩容后仍正确指向 mdat 载荷 |

`traf` 内顺序为：`tfhd, tfdt, sgpd, sbgp, saiz, saio, trun, senc`。封装后有独立校验脚本对**全部
样本**做 AES-CTR 解密并与明文逐字节比对，确保密文、IV、子样本划分与偏移全部正确。

## 运行时数据流与三阶段状态机（`player/eme-kernel.js`）

1. `requestMediaKeySystemAccess('org.w3.clearkey', …)` → `createMediaKeys()` → `video.setMediaKeys()`。
2. 拉取全部加密分片，从首个分片 `moov` 中提取 `pssh` 作为 initData。
3. `createSession('temporary')` + `generateRequest('cenc', pssh)`，CDM 触发 `message` 事件。
4. 内核向 `/api/license` POST ClearKey 请求：
   - HTTP 非 2xx → 置 **LICENSE_FAILED**，阶段①失败；
   - HTTP 200 → 先点亮**阶段① 许可取得**，再调用 `session.update()`；
   - `update()` 被 CDM 拒绝（如错误密钥）→ 置 **KEY_ERROR**，阶段①保持已取得、阶段②失败。
5. `keystatuseschange`：所有 KID 均 `usable` 才点亮**阶段② 密钥可用**；否则 KEY_ERROR。
6. 建立 `MediaSource`，用单个 `SourceBuffer` 顺序 `appendBuffer` 喂入 init 与各 moof/mdat。
7. 视频元素 `loadeddata` → 点亮**阶段③ 可解码**；`playing` → 真实呈现。界面再用画布截取中心像素，
   断言非全黑，作为“画面确实由解密数据渲染”的证据。

### 失败被严格区分，不与成功混淆

- **许可取得失败**（404/500/503/网络断开/畸形）只影响阶段①；
- **密钥不可用**（错误密钥、CDM 拒绝 update、keystatus 非 usable）阶段①仍保留、阶段②失败；
- 任何失败路径都不会点亮阶段③，且覆盖层显示「播放被拒绝」。
- `reset()` 会置 `closed` 标记，旧会话迟到的事件将被忽略，避免复位后空指针与状态串扰。

## 许可服务（`server/license-server.js`）

仅依据 `keys/courses.json` 中登记的本地虚构课程应答，内置五类场景：

| 场景 | HTTP | 行为 |
| --- | --- | --- |
| normal | 200 | 返回 KID 匹配的正确 KEY |
| wrong-key | 200 | KID 匹配但返回被替换的错误 KEY |
| unknown-kid | 404 | `unknown_kid`，未登记标识 |
| session-fail | 500 | `session_creation_failed`，拒绝建会话 |
| offline | 503 | `license_unavailable`，模拟断连 |

“未知 KID”演练由前端在**结构合法**的 PSSH 中内置一个未登记测试 KID（`…0face`）发起，使请求真正
到达许可端并被 404 拒绝；这与“篡改 initData”（破坏盒子结构导致 CDM 侧失败）是两类不同的拒绝路径。
