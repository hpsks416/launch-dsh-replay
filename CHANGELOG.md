# Changelog

## 1.1.0 — 2026-11-05

部署就绪版：从「本机可用」升级为「他人可直接安装」。

### 新增
- `install.cmd` / `install.ps1`：Windows 一键安装/卸载（Node ≥22.19 校验、内置 zstd 检查、自检、
  可选桌面快捷方式「DSH 会话回放」与 `~/.dsh` 转发入口、备份已有转发入口）。
- 分发 zip：`launch-dsh-replay-1.1.0.zip`（含 `SHA256SUMS.txt`），解压即用。
- `tests/smoke.mjs`：8 项零依赖自检（zstd 帧解码 / v4 解析 / 工具结果配对 / HTML 导出 /
  会话根目录解析三种优先级）。
- 根目录 `LICENSE`（MIT，含第三方声明）、`.gitignore`、`.gitattributes`。
- README：人话版三要素（是什么/环境依赖/目录结构）、安装方式 A/B/C、隐私警告、格式版本矩阵。
- 支持 `DSH_HOME`：会话根目录解析顺序 `DSH_REPLAY_ROOT → DSH_HOME/sessions → ~/.dsh/sessions`。
- 跨平台自动开浏览器：Windows `cmd start`、macOS `open`、Linux `xdg-open`。

### 修复
- README 中的个人路径（`C:\Users\...`）与机器专属说明已通用化。
- `.cmd`/`.ps1` 统一 CRLF，`.ps1` 统一 UTF-8 BOM（Windows PowerShell 5.1 中文不乱码）。
- 引导页 `VERSION` 与 `package.json` 对齐到 1.1.0。

### 已知限制
- 启动器仅 Windows；macOS/Linux 用 `node` 命令（功能等价）。
- 不支持 v2 / 无版本后缀的旧日志（更早的 DSH）。
- 无跨会话检索/索引（单会话列表 + 渲染）。

## 1.0.0 — 2026-11-04

首个桌面端移植版本。

- 把 DSH WEB 的 `dsh-replay-web.mjs` 移植到桌面端，支持桌面 DSH 的 **v4** 会话日志
  （原 WEB 版只认 v3，桌面会话列不出来、工具结果错位）。
- 内置 `@mingozhou/dsh-replay@0.4.2` core + viewer（MIT，未改动）：
  v4 原生解析、会话标题、工具结果精确配对、审批、交付物、token/成本、审计发现。
- 引导页（127.0.0.1:7781，端口占用自动顺延）+ CLI（`--list/--latest/--id/--file/--stats`）。
- 单文件自包含 HTML 导出（React 内联，可离线分享）。
- Windows 启动器 `launch-dsh-replay.cmd` / `.ps1`。
