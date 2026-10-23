# Turn Navigator v1.0.2

[English](RELEASE.en.md) | [简体中文](RELEASE.md)

Released: 2026-10-23
Compare: [v1.0.1...v1.0.2](https://github.com/Rayle8/opencode-turn-navigator/compare/v1.0.1...v1.0.2)

This release focuses on the hover tooltip: it now sizes itself to its content, scrolls, pins in place, and summarizes tokens, cost, and speed for both the session and the hovered turn.

## Added

- **Usage summary in the tooltip header** for sessions and turns.
  - `Session` line: cumulative tokens, cache hits, and cost from the session start through the hovered turn (not the latest state), plus the context left at the end of that turn.
  - `Turn` line: that turn's total, new, and cached tokens (with the cached share), step count, cost, and TPS.
  - The cache-bust count gets its own line and only appears when one occurred. A cache bust is a step whose cache hits fell below the previous step, meaning the cached prefix was invalidated and that part was billed as new input.
- **Pinning and a state label**: the tooltip pins after 300 ms, and its top border shows a faint `Unpinned` or `Pinned` on the right without an extra row or a lock icon.
- **Scrollable content**: when the prompt or details exceed the pane height, the tooltip scrolls with a vertical scrollbar.

## Improved

- **Content-sized layout**: the tooltip is vertically centered on the hovered title, stays within the session pane, has a minimum height of five rows including its border, grows with its content, and never exceeds the pane height.
- **Pinning behavior**: moving the pointer into the tooltip pins it immediately, keeps the current content, and lets it scroll. Once pinned it stays open after the pointer leaves, until the user clicks outside it or dwells on another row.
- **Smooth switching**: crossing another row no longer swaps the content immediately; the new row must be hovered for 220 ms, so sweeping past rows no longer flickers.
- **Header layout**: metrics use the shorter `Tot` / `Cache` / `New` labels; summary lines wrap by word and reserve their measured height instead of being truncated; the tooltip's maximum width grew from 60 to 72 columns.

## Fixed

- Runaway tooltip height and clipped content with long text or narrow terminals.
- The `Unpinned` / `Pinned` state previously consumed an extra row.
- The pinned state was not always reset after switching or leaving a row.

## Docs

- Added sparse-clone install steps to both READMEs, along with a "confirm the plugin loaded" check.
- Documented the tooltip behavior, what a cache bust means, and how jumping works.
- `.gitignore` now ignores the JetBrains `.idea/` directory.

## Upgrade

For an existing global installation:

```sh
git -C ~/.config/opencode/plugins/turn-navigator pull --ff-only
```

Windows (PowerShell):

```powershell
git -C "$env:USERPROFILE\.config\opencode\plugins\turn-navigator" pull --ff-only
```

See the "Install" section of the [README](README.en.md) for a first-time install. If the current session does not pick up the update, switch sessions or reopen the TUI.

## Compatibility

- Requires an OpenCode version that exposes the TUI plugin API; jumping relies on the public navigation commands `session.messages_last_user`, `session.message.user.previous`, and `session.message.next`.
- If a host change makes those commands unreachable, the plugin reports it.
