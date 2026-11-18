# 授权教学媒体播放实验

本地虚构课程 · 测试密钥专用 · 非商业 DRM

完整说明见 **[docs/README.md](docs/README.md)**。

## 快速开始

```bash
npm install
npm run package:media   # 生成可重复的 CENC 加密封装
npm start               # 图形入口：http://127.0.0.1:4173/
```

图形入口为主要交付：在浏览器中选择测试凭据与实验场景，由加密教学内核驱动播放，
结果区呈现五阶段授权状态与真实解密画面。

## 辅助命令

```bash
npm run license:demo     # 许可端演练（辅助，非主入口）
npm run verify:flow      # 许可内核断言
npm run verify:browser   # 浏览器端到端验证（六个场景）
```

ClearKey 是软件测试密钥系统，不具备商业硬件 DRM 的能力，详见文档中的「保护强度范围」。
