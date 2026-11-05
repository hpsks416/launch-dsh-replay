# dsh-session-sync-flush（桌面端 DSH 0.2.2-rc.1 适配版）

原插件来自本机 WEB 工作区 `G:\CodexDS\DSH\INTRO\dsh-session-sync-flush`（0.1.0，兼容 `^0.1.5-rc.2`）。
本目录是**桌面端适配副本**，不改 WEB 原件。

## 作用

DSH 会话日志是「有界 write-behind buffer + 请求级 flush」：`append` 是 best-effort，
**`flush` 才是 durability barrier**。崩溃会把当前请求尚未 flush 的事件整段丢掉。
本插件在关键事件（`user/message`、`assistant/message`、`tool/call`、`tool/result`）
落库后立即 flush，把丢失窗口从「整个请求」缩到「单个事件」。

## 适配内容（相对 0.1.0）

- 兼容声明：`^0.2.2-rc.1`，`dshReleases` 补 `0.2.1-rc.5` / `0.2.2-rc.1`。
- flush 调用：优先 `ctx.get("sessions").flush(session)`（0.2.2-rc.1 二进制中仍存在），
  回退到服务级 `ctx.sessionPersistence.flush()`（官方 handle 化持久化的 durability barrier）。
- 保持 fire-and-forget，失败仅告警，不阻塞会话。

## 安装（桌面端 profile）

```powershell
cd C:\Users\Razer\.dsh\profiles\desktop
# 在 package.json dependencies 与 dsh.profile.bundles 中登记（已由部署脚本完成）
pnpm install
```

重启桌面端 DSH 后生效。验证：看启动日志加载列表 / 用
`node G:\DSH\CMAIN\CINTRO\launch-dsh-replay\tools\persistence-lag.mjs` 对比落盘滞后。
