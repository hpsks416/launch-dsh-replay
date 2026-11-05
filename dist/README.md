# 分发包（release artifacts）

仓库内的 `dist/` 存放已经打好、可直接分发的版本：

| 文件 | 说明 |
|---|---|
| `launch-dsh-replay-1.2.0.zip` | 可分发包（解压后双击 `install.cmd` 安装；任何平台也可直接 `node` 命令运行） |
| `SHA256SUMS.txt` | 上表的 SHA-256 校验和 |

校验（Windows PowerShell）：

```powershell
Get-FileHash .\launch-dsh-replay-1.2.0.zip -Algorithm SHA256
# 与 SHA256SUMS.txt 中的值逐字符比对
```

说明：

- 分发包与仓库源码同源（由 `github-ready-packager` 逐文件打包，排除 `.git`/`node_modules`/运行时产物）。
- 安装/卸载方式见仓库根目录 `README.md` 的「安装」章节。
- 重新出包：按 `README.md` 的打包说明生成新版本 zip，同步更新本目录与 `CHANGELOG.md`。
