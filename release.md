# Turn Navigator v1.0.2

发布日期：2026-10-23
对比范围：[v1.0.1...v1.0.2](https://github.com/Rayle8/opencode-turn-navigator/compare/v1.0.1...v1.0.2)（16 个提交）

本版本专注悬浮提示框（tooltip）的交互与信息密度：提示框按内容自适应、可滚动、可固定，并在头部给出会话与单轮的 token、费用和速度摘要。

## 新增

- **悬浮提示框用量摘要**：头部显示会话与当前轮次的 token 统计。
  - `Session` 行：截至该轮（不是当前最新）的累计 token、累计缓存命中、累计费用，以及该轮结束时的上下文剩余百分比。
  - `Turn` 行：该轮总 token、新增 token、缓存 token（含占比）、步数、该轮费用和 TPS。
  - 缓存失效次数（`cache bust`）单独一行，仅在有失效时出现。`cache bust` 指某一步的缓存命中量低于上一步，说明缓存前缀失效、这部分 token 按新输入计费。
- **固定与状态标签**：提示框停留 300ms 后固定，边框右上角以浅色显示 `Unpinned` / `Pinned`，不额外占用一行，也没有锁图标。
- **可滚动内容**：提示词或详情超出面板高度时，提示框内部显示垂直滚动条。

## 改进

- **尺寸自适应**：提示框以被悬停的标题为垂直中心，始终限制在会话面板范围内；最小高度 5 行（含边框），随内容增高，最高不超过面板高度。
- **固定交互**：指针移入提示框会立即固定，保留当前内容并允许滚动；固定后离开该行仍然保持打开，直到点击提示框外部或停留在另一行。
- **平滑切换**：划过其他行不再立即换内容，需要在新行停留 220ms；避免快速扫过时闪烁。
- **头部排版**：指标改用 `Tot` / `Cache` / `New` 简写；摘要按词换行并按实际行数预留高度，长行不再被截断；提示框最大宽度由 60 列提升到 72 列。

## 修复

- 长内容或窄终端下提示框高度失控、内容被裁剪的问题。
- `Unpinned` / `Pinned` 状态原先占用额外行的问题。
- 固定状态在切换行、离开行后未正确复位的问题。

## 文档

- 新增中英文 README 的稀疏克隆安装步骤，以及“确认插件已加载”的检查方法。
- 补充悬浮层行为、`cache bust` 含义与导航实现说明。
- `.gitignore` 忽略 JetBrains 的 `.idea/` 目录。

## 升级

已安装全局插件的用户：

```sh
git -C ~/.config/opencode/plugins/turn-navigator pull --ff-only
```

Windows（PowerShell）：

```powershell
git -C "$env:USERPROFILE\.config\opencode\plugins\turn-navigator" pull --ff-only
```

首次安装见 [README](README.md) 的「安装」章节。更新后若当前会话未生效，切换会话或重开 TUI。

## 兼容性

- 仅支持提供 TUI 插件接口的 OpenCode 版本；跳转依赖 `session.messages_last_user`、`session.message.user.previous`、`session.message.next` 等公开导航命令。
- 主机版本变更导致这些命令不可用时，插件会显示提示。
