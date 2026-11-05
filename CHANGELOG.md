# Changelog

## 1.3.0 — 2026-11-05

整包整合：把崩溃栈收进同一个仓库/分发包。

### 新增
- `extras/dsh-session-sync-flush/`：适配桌面端 `0.2.2-rc.1` 的缩窗插件（事件级 flush，双接口回退），
  随包分发但需手动登记到 profile 后启用（不自动安装）。
- `docs/CRASH-STACK.md`：崩溃记录栈唯一入口——四层结构、官方 flush 语义、安装/验证/崩后应急/回滚/边界。
- README 目录树与「崩前记录与崩溃修复」章节链接到上述文档。

### 变更
- 分发包更名 `launch-dsh-replay-1.3.0.zip`（21+ 文件，含 extras 与 docs）。
- 本项目仍是只读查看器；缩窗与修复分别由 sync-flush / surgeon 承担（surgeon 不 vendor，从 GitHub 安装）。

## 1.2.0 — 2026-11-05

崩溃记录 / 修复整合。

### 新增
- `tools/persistence-lag.mjs`：落盘滞后探针（最后已提交事件 vs 现在、torn 尾帧、帧数），用于量化崩溃窗口。
- README 新增「崩前记录与崩溃修复（配套轮子）」：官方 flush=durability barrier 语义、实测滞后 0.7–0.8 s、
  `dsh-session-sync-flush`（事件级 flush）与 `dsh-session-surgeon`（崩后修复）的用法。
- 适配 `dsh-session-sync-flush` 到桌面端 `0.2.2-rc.1`：复制到 `CINTRO`（不改 WEB 原件）、
  兼容声明放宽、flush 调用双接口回退（`sessions.flush` → `sessionPersistence.flush`），已装入 desktop profile。
- 安装 `dsh-session-surgeon 0.2.11`（desktop profile，插件形态，用于崩后修复；CLI 的 v4 限制已在 README 注明）。

### 变更
- 更正桌面端版本事实：当前为 `dsh-desktop 0.2.2-rc.1`（会话格式仍为 v4）。
- 自检保持 9 项。

## 1.1.1 — 2026-11-05

导出的 HTML 指向本项目仓库。

### 变更
- 单文件 HTML 导出中的仓库链接改为本项目仓库
  （`github.com/hpsks416/launch-dsh-replay`）：页头 GitHub 链接、页脚 Install · Star 链接。
- 页脚文案改为「Exported by launch-dsh-replay · engine @mingozhou/dsh-replay (MIT)」，
  保留上游引擎署名；页头品牌名改为 launch-dsh-replay；`<meta name="generator">` 同步。
- 引导页页脚新增本项目仓库链接（引擎署名保留）。
- 实现方式：vendor 内的 viewer 文件保持字节不变（SHA-256 仍与上游一致），只在生成 HTML
  时对链接/品牌文案做 overlay，见 `lib/sessions.mjs` 的 `applyAttributionOverlay`。
- 自检增至 9 项（新增「HTML 链接指向本项目且保留引擎署名」）。

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
