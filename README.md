# Turn navigator

A TUI-only OpenCode plugin that lists conversation turns and jumps the
transcript when a turn is picked.

```
Alt+T            # toggle the expanded Turn navigator panel
/turns           # same, from the prompt
<leader>b        # host binding: show/hide the sidebar
```

## Where it appears

- **Sidebar (default).** On terminals wide enough for the sidebar, a `Turns`
  section is appended after the existing session title, Context, todo, and MCP
  blocks. It shows every loaded turn in chronological order, so the newest turn
  sits at the bottom. The list fills the remaining sidebar height and gains a
  vertical scrollbar as soon as its turns exceed the visible rows. Nothing
  needs to be enabled.
- **Expanded panel.** `Alt+T` opens the complete list (every loaded turn,
  oldest first) in the right pane, which is useful on narrow terminals or for
  long sessions. The row selected last is remembered and scrolled into view.

Both views show the turn number and prompt preview; hovering a row shows the
full prompt in a floating tooltip, preserving its original line breaks without
changing the row height or scroll position. The tooltip sits beside the row and
moves above it near the bottom of the terminal. While the session is running,
the newest turn carries a one-cell square at the end of its row: one edge lights
every 280ms in clockwise order (`▀`, `▐`, `▄`, `▌`), so the border appears to
flow gently around it. The square is only rendered while the run is active, so
it disappears as soon as the session goes idle. The expanded view also shows the
clock time and reply/tool counts when the pane is wide enough.

## How jumping works

The TUI plugin API does not expose transcript scrolling to plugins, and the
transcript is virtualized. The plugin therefore uses the host's public message
navigation commands:

1. `session.messages_last_user` jumps to the newest user prompt. This also
   makes the transcript mount every loaded row and seeds the current message.
2. After a short settle, `session.message.user.previous` is dispatched once per
   prompt that follows the clicked turn. Each step aligns that prompt at the
   top of the transcript.

A plain click or Enter stops at the prompt. Ctrl+click in either view also
dispatches `session.message.next` once per reply message that the host
navigation stops at, so the last step lands on the turn's final text reply. A
turn with no text reply stays at its prompt.

No dialog is opened, so there is no popup or flicker. The sidebar never takes
the session pane's input, so it jumps in place and stays open. The expanded
panel owns input, which disables the session commands, so it closes first; it
also stays closed because reopening would reflow the transcript at a different
width and move the aligned turn again. Press `Alt+T` to reopen it at the
remembered turn.

If those commands are not reachable (for example after a future host change),
the plugin reports it.

## Limitation: no left-side frame

A pure plugin cannot draw anything around the transcript. The published slot
tree only covers `app`, `prompt.footer*`, `session.composer.top`,
`session.panel`, and `sidebar.*`; there is no transcript slot, and there is no
"wrap" placement that would let a claim surround existing content.

Boxing each turn therefore needs a small host addition (a per-turn slot plus
scroll control). Until then this plugin keeps the navigation side only.

## Install

OpenCode discovers plugins in `<project>/.opencode/plugins/<name>/` and the
global config directory. Place these files in
`<project>/.opencode/plugins/turn-navigator/` (or the global equivalent); the
host resolves `<dir>/tui.tsx` as the CLI entrypoint. No `opencode.json` change
is needed.

Imports of `@opencode/plugin/tui` are resolved by OpenCode at runtime, so no
dependency install or build step is required. Copy this directory into another
project's `.opencode/plugins/turn-navigator/` to use it there, or into
`<global-config>/plugins/turn-navigator/` to use it everywhere.

## Try it

Copy or symlink this repository into a plugin directory, restart the TUI, and
open a session wide enough to show the sidebar: the `Turns` section should be
there without pressing anything. Click a turn to jump. Press `Alt+T` for the
expanded list.
