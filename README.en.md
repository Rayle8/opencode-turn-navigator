# Turn Navigator

[English](README.en.md) | [简体中文](README.md)

A TUI-only OpenCode plugin for browsing conversation turns, inspecting compaction details, and jumping through the transcript.

```text
Alt+T       Open or close the expanded Turn navigator panel
/turns      Run the same action from the prompt
<leader>b   Show or hide the sidebar using the host binding
```

## Screenshots

### With the plugin installed

![Turn Navigator installed](assets/turn-navigator-installed.png)

### Without the plugin

![Turn Navigator without the plugin](assets/turn-navigator-not-installed.png)

## Install

Place the plugin files in one of the directories below, then restart OpenCode. The plugin only needs `tui.tsx` and `turns.ts`. The sparse clone commands below skip the README, screenshots, and other unrelated files, and download only these two source files.

### Install globally (available in every project)

| Platform | Plugin directory |
| --- | --- |
| macOS / Linux | `~/.config/opencode/plugins/turn-navigator/` |
| Windows | `%USERPROFILE%\.config\opencode\plugins\turn-navigator\` |

macOS / Linux:

```sh
mkdir -p ~/.config/opencode/plugins
git clone --depth 1 --filter=blob:none --no-checkout --branch main https://github.com/Rayle8/opencode-turn-navigator.git ~/.config/opencode/plugins/turn-navigator
git -C ~/.config/opencode/plugins/turn-navigator sparse-checkout set --no-cone /tui.tsx /turns.ts
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins" | Out-Null
$pluginDir = "$env:USERPROFILE\.config\opencode\plugins\turn-navigator"
git clone --depth 1 --filter=blob:none --no-checkout --branch main https://github.com/Rayle8/opencode-turn-navigator.git $pluginDir
git -C $pluginDir sparse-checkout set --no-cone /tui.tsx /turns.ts
```

### Install for one project only

Run this from the project root:

```sh
mkdir -p .opencode/plugins
git clone --depth 1 --filter=blob:none --no-checkout --branch main https://github.com/Rayle8/opencode-turn-navigator.git .opencode/plugins/turn-navigator
git -C .opencode/plugins/turn-navigator sparse-checkout set --no-cone /tui.tsx /turns.ts
```

To update a global installation, run `git -C ~/.config/opencode/plugins/turn-navigator pull --ff-only`. For a project installation, replace the path with `.opencode/plugins/turn-navigator`.

OpenCode loads local plugins from the global plugin directory `~/.config/opencode/plugins/` (Windows: `%USERPROFILE%\.config\opencode\plugins\`) and the project directory `<project-root>/.opencode/plugins/`. No `opencode.json` change, dependency installation, or build step is required.

After restarting OpenCode, open a session wide enough to show the sidebar and confirm that the `Turns` section appears. Click a turn to jump, or press `Alt+T` to open the full list.

## Where it appears

- **Sidebar (default).** On terminals wide enough for the sidebar, a `Turns` section is appended after the existing session title, Context, todo, and MCP blocks. It lists every loaded turn in chronological order, with the newest at the bottom. The list fills the remaining sidebar height and becomes scrollable when turns exceed the visible rows. A fixed `alt+t expand turns` hint sits below the list. Click the triangle beside the `Turns` header to collapse or expand the block; the choice is remembered. Nothing needs to be enabled.
- **Expanded panel.** Press `Alt+T` to open the complete list of loaded turns, oldest first, in the right pane. This is useful on narrow terminals or in long sessions. Use `↑` / `↓` to move, `Home` / `End` for the first or last entry, `Enter` to jump, and `Escape` to close. The last selected row is remembered and scrolled into view.

Compaction messages appear between turns. Once the next assistant step reports the result, the compaction row shows the context saved (for example, `compact · saved 82.3k (68%)`). A running compaction shows `compact · running`; failed or cancelled compactions show their outcome. Hover over a compaction row to see the before and after context, the exact saving and percentage, the compaction request's own token usage and cost, and its summary or error. Until the next assistant step arrives, the row shows the previous context size and an ellipsis instead of guessing the benefit.

Clicking a compaction row jumps to the nearest navigable message around it (usually the message just before the compaction, when one exists), because the host's message navigation does not expose compaction rows themselves.

Both views show the turn number and prompt preview; compaction rows use a `⇣` marker. Hover over a turn to see the full prompt, or over a compaction to see its details. The floating tooltip preserves line breaks without changing row height or scroll position, and moves above the row near the bottom of the terminal. After three seconds over the same row, the tooltip pins: it stays open after the pointer leaves until the user clicks outside it or hovers over another row. Long pinned content scrolls and shows a vertical scrollbar.

While a session is running, the newest turn has a one-cell square at the end of its row. One edge lights every 280 ms in clockwise order (`▀`, `▐`, `▄`, `▌`), making the border appear to flow. The square disappears as soon as the session goes idle. When the expanded pane is wide enough, it also shows the time and reply/tool counts.

## How jumping works

The TUI plugin API does not expose transcript scrolling, and the transcript is virtualized. The plugin therefore uses the host's public message-navigation commands:

1. `session.messages_last_user` jumps to the newest user prompt. This also makes the transcript mount every loaded row and seeds the current message.
2. After a short settle, `session.message.user.previous` is dispatched once per prompt that follows the clicked turn. Each step aligns that prompt at the top of the transcript.

A plain click or `Enter` stops at the prompt. Ctrl+click in either view also dispatches `session.message.next` once per reply message that the host navigation stops at, so the last step lands on the turn's final text reply. A turn with no text reply stays at its prompt.

A compaction row starts at the same newest-user prompt and then walks `session.message.previous` or `session.message.next` to the nearest user/assistant boundary. The host's boundary list excludes compaction rows, so the click lands on the message immediately around the compaction (usually the assistant reply just before it).

No dialog is opened, so there is no popup or flicker. The sidebar never takes the session pane's input, so it jumps in place and stays open. The expanded panel owns input, which disables the session commands, so it closes first. It stays closed because reopening would reflow the transcript at a different width and move the aligned turn again. Press `Alt+T` to reopen it at the remembered turn.

If those commands are not reachable (for example, after a future host change), the plugin reports it.

## Limitation: no left-side frame

A pure plugin cannot draw anything around the transcript. The published slot tree only covers `app`, `prompt.footer*`, `session.composer.top`, `session.panel`, and `sidebar.*`; there is no transcript slot and no “wrap” placement that would let a claim surround existing content.

Boxing each turn therefore needs a small host addition: a per-turn slot plus scroll control. Until then, this plugin provides navigation only.
