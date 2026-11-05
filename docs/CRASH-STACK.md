# 崩溃记录栈（CRASH-STACK）

> 一句话：**DSH 才是记录器**；本仓提供「读 + 缩窗 + 修」三块里属于我们的部分，其余用现成轮子。
> 本文是安装、验证、回滚、边界的唯一入口。

## 1. 四层结构

| 层 | 组件 | 谁提供 | 作用 |
|---|---|---|---|
| 记录 | DSH 官方 jsonl persistence | 桌面端 DSH 内置 | append-only 拼接 zstd 帧；每批 append 带 fsync；**`flush` 才是 durability barrier** |
| 缩窗 | [`dsh-session-sync-flush`](../extras/dsh-session-sync-flush/)（本仓适配版） | 本仓 `extras/` | 关键事件后立即 flush，把丢失窗口从「整个请求」缩到「单个事件」 |
| 修复 | [`dsh-session-surgeon`](https://github.com/xiaoshenming/dsh-session-surgeon)（MIT，第三方） | 从 GitHub 安装，不在本仓 vendor | 修崩溃损坏：torn zstd、write/fsync 之间崩溃导致的零填充尾部、seq gap、缺 message id 等；默认 dry-run + `.bak.<utc>` |
| 读 | `launch-dsh-replay`（本仓） | 本仓 | DSH 起不来时只读查看：v4/v3、torn 尾帧容错、单文件 HTML |

## 2. 官方语义（决定「崩前最后一刻」能到哪）

- 事件先进有界 write-behind buffer，窗口到期才 `append`；`append` 是 best-effort，**只有 `flush` 承诺崩后还在**。
- 桌面端实测（2026-11-05，`dsh-desktop 0.2.2-rc.1`）：最后已提交事件落后「现在」约 **0.7–0.8 s**；日志被截断半帧时本仓读取器仍能解码全部完整帧（-320 B 只丢 1 个事件，不报错）。
- 因此：**不加插件的丢失窗口 ≈ 请求级 / 亚秒级**；加 sync-flush 后 ≈ 单事件级；**任何方案都不承诺 0 丢失**。

## 3. 安装（桌面端）

profile：`%USERPROFILE%\.dsh\profiles\desktop`

```jsonc
// package.json → dependencies
"dsh-session-sync-flush": "link:G:/DSH/CMAIN/CINTRO/launch-dsh-replay/extras/dsh-session-sync-flush",
"dsh-session-surgeon": "github:xiaoshenming/dsh-session-surgeon#3da26706e88e7f825925d52cbf2cfa53c2ae3808"

// package.json → dsh.profile.bundles 追加
"dsh-session-sync-flush",
"dsh-session-surgeon"
```

```powershell
$p="$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json" "$p\package.json.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
cd $p
pnpm install --ignore-scripts --no-frozen-lockfile   # surgeon 需联网/GitHub；sync-flush 是 link
```

**重启桌面端**后生效（当前版本 `0.2.2-rc.1`；会话格式仍为 v4）。

## 4. 验证（重启后）

```powershell
# 4.1 崩溃窗口：重启前后各跑一次，对比 lag
node G:\DSH\CMAIN\CINTRO\launch-dsh-replay\tools\persistence-lag.mjs

# 4.2 插件是否加载
Select-String -Path "$env:USERPROFILE\.dsh\logs\startup-*.log" -Pattern 'sync-flush|session-surgeon' | Select-Object -Last 5
```

- 界面：左侧栏出现 **会话医生**（surgeon）。
- Agent 工具：`session_scan` / `session_inspect` / `session_repair`。
- 读取器：`node render.mjs --list` / 引导页照常工作（不依赖插件）。

## 5. 崩后应急

```powershell
$surgeon="$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-surgeon\bin\dsh-session-surgeon.mjs"

# 1) 先备份原日志（只复制，不改）
$id = "<session-id>"
$ws = "<workspace-dir-name>"   # 例如 --G-DSH-CMAIN-CINTRO--
Copy-Item "$env:USERPROFILE\.dsh\sessions\$ws\$id\session.v4.jsonl.zstd" "$env:TEMP\$id.zstd.bak"

# 2) 体检（只读）
node $surgeon inspect $id

# 3) 修复（默认 dry-run；--apply 才写，写前自动 .bak.<utc>）
node $surgeon repair $id
node $surgeon repair $id --apply
```

> ⚠️ 本机全局 CLI 仍是 0.1.5（只读 v3），**CLI 对 v4 日志会报 `foreign-version`**。
> 崩后修复优先用**插件形态**（重启后按桌面端 0.2.2 运行时识别 v4）；或先升级全局 CLI 再跑 CLI。

## 6. 回滚

```powershell
$p="$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json.bak-20261105-184302" "$p\package.json" -Force
Copy-Item "$p\pnpm-lock.yaml.bak-20261105-184302" "$p\pnpm-lock.yaml" -Force
cd $p; pnpm install --no-frozen-lockfile
# 重启桌面端
```

## 7. 保证与不保证

| 保证 | 不保证 |
|---|---|
| DSH 已 flush 的数据能读（含 torn 尾帧之前的全部完整帧） | DSH 未 flush 的事件（sync-flush 只是把窗口缩到单事件，不是 0） |
| 日志结构损坏可修（surgeon，带备份、默认 dry-run） | 修不回**从未落盘**的数据 |
| 只读查看不修改原始日志 | 断电/蓝屏下 fsync 语义之外的数据（取决于 DSH 后端） |
