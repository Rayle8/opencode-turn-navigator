import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { BoxRenderable, MouseEvent, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { Portal } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { collectTimeline, formatClock, type Compaction, type Turn, type TurnsEntry } from "./turns"

const PLUGIN_ID = "turn-navigator"
const PANEL_NAME = "turn-navigator.turns"
const LAST_USER_COMMAND = "session.messages_last_user"
const PREVIOUS_USER_COMMAND = "session.message.user.previous"
const PREVIOUS_MESSAGE_COMMAND = "session.message.previous"
const NEXT_MESSAGE_COMMAND = "session.message.next"
const JUMP_SETTLE_MS = 120
const TOOLTIP_PIN_MS = 300
const TOOLTIP_MIN_ROWS = 8

// A single cell; each frame lights one edge in clockwise order so the border
// appears to flow around it.
const CHASE_FRAMES = ["▀", "▐", "▄", "▌"] as const
const CHASE_INTERVAL_MS = 280

// Fallback row count until the sidebar viewport is measured; the list then
// grows to fill the remaining height.
const SIDEBAR_TURN_ROWS = 8

function createChase(active: () => boolean) {
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (!active()) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % CHASE_FRAMES.length), CHASE_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })
  return () => CHASE_FRAMES[frame()]!
}

// A new click cancels the previous walk so two jumps cannot interleave.
let jumpGeneration = 0

type JumpTarget = "prompt" | "reply"

function createTimelineJump(context: Plugin.Context, options?: { prepare?: () => void; restore?: () => void }) {
  const reachable = (id: string) => context.keymap.commands().some((command) => command.id === id)
  return (turn: Turn, target: JumpTarget = "prompt") => {
    // Session commands are only reachable while the session pane owns input.
    // The expanded panel owns input, so it closes first; the sidebar never
    // takes the session pane's input.
    options?.prepare?.()
    const required =
      target === "reply"
        ? [LAST_USER_COMMAND, PREVIOUS_USER_COMMAND, NEXT_MESSAGE_COMMAND]
        : [LAST_USER_COMMAND, PREVIOUS_USER_COMMAND]
    const generation = ++jumpGeneration
    let waits = 0
    const start = () => {
      if (generation !== jumpGeneration) return
      if (!required.every(reachable)) {
        if (++waits < (options?.prepare ? 50 : 10)) {
          setTimeout(start, 10)
          return
        }
        options?.restore?.()
        context.ui.toast.show({
          variant: "warning",
          message: "Turn jumps are unavailable in this view",
        })
        return
      }
      // The host does not expose transcript scrolling to plugins. Start at the
      // newest prompt, let that jump mount the remaining rows, then walk back
      // with the host's own user-message navigation. No dialog is opened, so
      // the transcript does not flicker.
      context.keymap.dispatch(LAST_USER_COMMAND)
      if (turn.previousPrompts === 0 && target === "prompt") return
      setTimeout(() => {
        if (generation !== jumpGeneration) return
        for (let index = 0; index < turn.previousPrompts; index++) {
          if (generation !== jumpGeneration) return
          context.keymap.dispatch(PREVIOUS_USER_COMMAND)
        }
        if (target === "prompt") return
        // From the turn's prompt, each reply stop walks forward. `replyStops`
        // only counts assistant messages the host stops at, so the last step
        // lands on the turn's final text reply.
        for (let index = 0; index < turn.replyStops; index++) {
          if (generation !== jumpGeneration) return
          context.keymap.dispatch(NEXT_MESSAGE_COMMAND)
        }
      }, JUMP_SETTLE_MS)
    }
    setTimeout(start, 0)
  }
}

// Compaction rows are not host navigation boundaries, so start at the newest
// prompt and walk to the nearest user/assistant boundary around the compaction.
function createCompactionJump(
  context: Plugin.Context,
  options?: { prepare?: () => void; restore?: () => void },
) {
  const reachable = (id: string) => context.keymap.commands().some((command) => command.id === id)
  return (entry: Compaction) => {
    const steps = entry.jumpSteps
    if (steps === undefined) {
      context.ui.toast.show({
        variant: "warning",
        message: "Cannot locate this compaction in the transcript",
      })
      return
    }
    // Session commands are only reachable while the session pane owns input.
    options?.prepare?.()
    const required = [LAST_USER_COMMAND, PREVIOUS_MESSAGE_COMMAND, NEXT_MESSAGE_COMMAND]
    const generation = ++jumpGeneration
    let waits = 0
    const start = () => {
      if (generation !== jumpGeneration) return
      if (!required.every(reachable)) {
        if (++waits < (options?.prepare ? 50 : 10)) {
          setTimeout(start, 10)
          return
        }
        options?.restore?.()
        context.ui.toast.show({
          variant: "warning",
          message: "Compaction jumps are unavailable in this view",
        })
        return
      }
      context.keymap.dispatch(LAST_USER_COMMAND)
      if (steps === 0) return
      setTimeout(() => {
        if (generation !== jumpGeneration) return
        const command = steps > 0 ? NEXT_MESSAGE_COMMAND : PREVIOUS_MESSAGE_COMMAND
        for (let index = 0; index < Math.abs(steps); index++) {
          if (generation !== jumpGeneration) return
          context.keymap.dispatch(command)
        }
      }, JUMP_SETTLE_MS)
    }
    setTimeout(start, 0)
  }
}

type TooltipState = {
  readonly id: string
  readonly text: string
  readonly screenX: number
  readonly screenY: number
  readonly rowWidth: number
  readonly terminalWidth: number
  readonly terminalHeight: number
  readonly paneTop: number
  readonly paneHeight: number
}

function sessionPaneBounds(context: Plugin.Context) {
  const pane = context.renderer.root.findDescendantById("session-pane")
  if (!pane || pane.isDestroyed || pane.height <= 0) {
    return { top: 0, height: context.renderer.height }
  }
  return { top: pane.screenY, height: pane.height }
}

// The row itself never grows: the full prompt is drawn in a root-level overlay
// so the list geometry, scroll position, and hover target stay fixed.
function TurnTooltip(props: {
  context: Plugin.Context
  state: TooltipState
  pinned: boolean
  onDismiss: () => void
}) {
  const theme = props.context.theme
  const [wrapper, setWrapper] = createSignal<BoxRenderable>()
  const [height, setHeight] = createSignal(0)
  const [contentHeight, setContentHeight] = createSignal(0)
  const minTooltipHeight = () => Math.min(TOOLTIP_MIN_ROWS, props.state.paneHeight)
  const maxContentHeight = () => Math.max(1, props.state.paneHeight - 3)
  const needsScroll = () => contentHeight() > maxContentHeight()
  const measureContent = function (this: Renderable) {
    setContentHeight(this.height)
  }
  let measuredID: string | undefined
  createEffect(() => {
    const id = props.state.id
    if (measuredID !== undefined && measuredID !== id) setContentHeight(0)
    measuredID = id
  })
  const width = () =>
    Math.max(20, Math.min(60, Math.floor(props.state.terminalWidth / 2), props.state.terminalWidth - 6))
  const left = () => {
    const state = props.state
    const gap = 2
    const right = state.screenX + state.rowWidth + gap
    if (right + width() <= state.terminalWidth - 1) return right
    const leftSide = state.screenX - gap - width()
    if (leftSide >= 1) return leftSide
    return Math.max(1, Math.min(right, state.terminalWidth - width() - 1))
  }
  const top = () => {
    const state = props.state
    const current = height()
    const preferred = current === 0 ? state.screenY : state.screenY - Math.round((current - 1) / 2)
    const lowest = state.paneTop + state.paneHeight - Math.max(1, current)
    return Math.max(state.paneTop, Math.min(preferred, lowest))
  }
  createEffect(() => {
    const node = wrapper()
    if (!node || node.isDestroyed) return
    node.left = left()
    node.top = top()
  })
  // While pinned, any mouse-down that reaches the root is outside the tooltip:
  // the tooltip stops propagation for its own clicks and scrollbar.
  createEffect(() => {
    if (!props.pinned) return
    const root = props.context.renderer.root
    const previous = root.onMouseDown
    const handler = (event: MouseEvent) => {
      previous?.call(root, event)
      props.onDismiss()
    }
    root.onMouseDown = handler
    onCleanup(() => {
      if (root.onMouseDown === handler) root.onMouseDown = previous
    })
  })
  return (
    <Portal
      ref={(value) => {
        const node = value as BoxRenderable
        node.position = "absolute"
        node.zIndex = 2200
        node.flexDirection = "column"
        setWrapper(node)
      }}
    >
      <box
        width={width()}
        minHeight={minTooltipHeight()}
        maxHeight={Math.max(1, props.state.paneHeight)}
        overflow="hidden"
        border
        borderColor={theme.border.base}
        backgroundColor={theme.background.raised.max}
        onMouseDown={(event) => event.stopPropagation()}
        onSizeChange={function (this: BoxRenderable) {
          setHeight(this.height)
        }}
      >
        <box flexDirection="row" justifyContent="flex-end" flexShrink={0} paddingRight={1}>
          <text fg={theme.text.muted} wrapMode="none">
            {props.pinned ? "\u{1F512}\uFE0E Pinned" : "\u{1F513}\uFE0E Unpinned"}
          </text>
        </box>
        <box flexDirection="column" flexGrow={1} minHeight={0} justifyContent="center">
          <Show
            when={needsScroll()}
            fallback={
              <box width="100%" maxHeight={maxContentHeight()} overflow="hidden">
                <box width="100%" paddingLeft={1} paddingRight={1} onSizeChange={measureContent}>
                  <text fg={theme.text.base} wrapMode="word">
                    {props.state.text}
                  </text>
                </box>
              </box>
            }
          >
            <scrollbox
              width="100%"
              height={maxContentHeight()}
              flexShrink={0}
              horizontalScrollbarOptions={{ visible: false }}
              verticalScrollbarOptions={{
                position: "absolute",
                right: 0,
                top: 0,
                width: 1,
                height: "100%",
                trackOptions: {
                  backgroundColor: theme.background.raised.max,
                  foregroundColor: theme.scrollbar.base,
                },
              }}
            >
              <box width="100%" paddingLeft={1} paddingRight={1}>
                <text fg={theme.text.base} wrapMode="word">
                  {props.state.text}
                </text>
              </box>
            </scrollbox>
          </Show>
        </box>
      </box>
    </Portal>
  )
}

function TurnsPanel(props: { context: Plugin.Context; panel: PanelInput }) {
  const theme = props.context.theme
  const [remembered, setRemembered] = props.context.storage.memory<{ id?: string }>("selection", { initial: {} })
  const [hovered, setHovered] = createSignal<string>()
  const [tip, setTip] = createSignal<TooltipState>()
  const [pinned, setPinned] = createSignal(false)
  let pinTimer: ReturnType<typeof setTimeout> | undefined
  const clearPinTimer = () => {
    if (pinTimer) clearTimeout(pinTimer)
    pinTimer = undefined
  }
  const dismissTip = () => {
    clearPinTimer()
    setPinned(false)
    setHovered(undefined)
    setTip(undefined)
  }
  const armPin = (entry: TurnsEntry) => {
    setPinned(false)
    clearPinTimer()
    pinTimer = setTimeout(() => {
      pinTimer = undefined
      if (tip()?.id === entry.id && hovered() === entry.id) setPinned(true)
    }, TOOLTIP_PIN_MS)
  }
  const selected = () => remembered.id
  const setSelected = (id: string | undefined) => {
    setRemembered((draft) => {
      draft.id = id
    })
  }
  const jump = createTimelineJump(props.context, {
    prepare: () => props.panel.close(),
    restore: () => props.context.ui.panel.open(PANEL_NAME),
  })
  const jumpCompact = createCompactionJump(props.context, {
    prepare: () => props.panel.close(),
    restore: () => props.context.ui.panel.open(PANEL_NAME),
  })
  let scroll: ScrollBoxRenderable | undefined

  const messages = createMemo(() => props.context.data.session.message.list(props.panel.sessionID))
  const timeline = createMemo(() => collectTimeline(messages()))
  const turns = createMemo(() => timeline().turns)
  const entries = createMemo(() => timeline().entries)
  const running = createMemo(() => props.context.data.session.status(props.panel.sessionID) === "running")
  const chase = createChase(running)
  const selectedEntry = createMemo(() => entries().find((entry) => entry.id === selected()))

  createEffect(() => {
    const list = entries()
    if (list.length === 0) {
      setSelected(undefined)
      return
    }
    if (!list.some((entry) => entry.id === selected())) setSelected(list[list.length - 1]!.id)
  })

  const reveal = (id: string | undefined) => {
    if (!id || !scroll || scroll.isDestroyed) return
    const index = entries().findIndex((entry) => entry.id === id)
    const target = index === -1 ? undefined : scroll.getChildren()[index]
    if (!target) return
    const y = target.y - scroll.y
    if (y < 0) scroll.scrollBy(y)
    else if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1)
  }

  onMount(() => {
    setTimeout(() => reveal(selected()), 0)
  })

  const move = (delta: number) => {
    const list = entries()
    if (list.length === 0) return
    const index = list.findIndex((entry) => entry.id === selected())
    const next = index === -1 ? 0 : (index + delta + list.length) % list.length
    setSelected(list[next]!.id)
    reveal(list[next]!.id)
  }

  const select = (entry: TurnsEntry | undefined) => {
    if (!entry) return
    setSelected(entry.id)
    reveal(entry.id)
  }

  const open = (entry: TurnsEntry, target: JumpTarget) => {
    dismissTip()
    setSelected(entry.id)
    if (entry.kind === "compaction") {
      jumpCompact(entry)
      return
    }
    jump(entry, target)
  }

  const showTip = (entry: TurnsEntry) => {
    const same = tip()?.id === entry.id
    setHovered(entry.id)
    const index = entries().findIndex((item) => item.id === entry.id)
    const row = index === -1 ? undefined : scroll?.getChildren()[index]
    if (!row || row.isDestroyed) {
      if (!same) dismissTip()
      return
    }
    const pane = sessionPaneBounds(props.context)
    setTip({
      id: entry.id,
      text: entry.full,
      screenX: row.screenX,
      screenY: row.screenY,
      rowWidth: row.width,
      terminalWidth: props.context.renderer.width,
      terminalHeight: props.context.renderer.height,
      paneTop: pane.top,
      paneHeight: pane.height,
    })
    if (same && (pinned() || pinTimer)) return
    armPin(entry)
  }

  const hideTip = (id: string) => {
    if (hovered() === id) setHovered(undefined)
    if (tip()?.id !== id) return
    clearPinTimer()
    if (pinned()) return
    setTip(undefined)
  }

  createEffect(() => {
    const current = tip()
    if (!current) return
    if (!entries().some((entry) => entry.id === current.id)) dismissTip()
  })
  onCleanup(clearPinTimer)

  props.context.keymap.layer(() => ({
    priority: 20,
    commands: [
      {
        id: "turn-navigator.panel.next",
        title: "Next entry",
        group: "Turn navigator",
        bind: "down",
        run: () => move(1),
      },
      {
        id: "turn-navigator.panel.previous",
        title: "Previous entry",
        group: "Turn navigator",
        bind: "up",
        run: () => move(-1),
      },
      {
        id: "turn-navigator.panel.first",
        title: "First entry",
        group: "Turn navigator",
        bind: "home",
        run: () => select(entries()[0]),
      },
      {
        id: "turn-navigator.panel.last",
        title: "Last entry",
        group: "Turn navigator",
        bind: "end",
        run: () => select(entries()[entries().length - 1]),
      },
      {
        id: "turn-navigator.panel.open",
        title: "Jump to entry",
        group: "Turn navigator",
        bind: "return",
        run: () => {
          const entry = selectedEntry()
          if (entry) open(entry, "prompt")
        },
      },
      {
        id: "turn-navigator.panel.close",
        title: "Close turn navigator",
        group: "Turn navigator",
        bind: "escape",
        run: () => props.panel.close(),
      },
    ],
  }))

  const isRunningTurn = (entry: TurnsEntry) =>
    entry.kind === "turn" && running() && entry.id === turns()[turns().length - 1]?.id
  const rowBackground = (entry: TurnsEntry) => {
    if (entry.id === selected()) return theme.background.raised.high
    if (entry.id === hovered()) return theme.background.raised.max
  }
  const rowColor = (entry: TurnsEntry) => {
    if (entry.id === selected()) return theme.text.base
    if (entry.id === hovered()) return theme.text.base
    return theme.text.muted
  }
  const detail = (turn: Turn) => {
    const parts = [`${turn.assistantMessages} ${turn.assistantMessages === 1 ? "reply" : "replies"}`]
    if (turn.toolCalls > 0) parts.push(`${turn.toolCalls} ${turn.toolCalls === 1 ? "tool" : "tools"}`)
    return parts.join(" · ")
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      minHeight={0}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0} gap={1}>
        <text fg={theme.text.base} wrapMode="none">
          <b>Turns ({turns().length})</b>
        </text>
        <Show when={running()}>
          <text fg={theme.text.feedback.success.base} wrapMode="none">
            ●
          </text>
        </Show>
      </box>

      <Show
        when={entries().length > 0}
        fallback={
          <box flexGrow={1} minHeight={0}>
            <text fg={theme.text.muted} wrapMode="word">
              No user turns yet. Send a prompt and every turn will appear here.
            </text>
          </box>
        }
      >
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (scroll = value)}
          flexGrow={1}
          minHeight={0}
          stickyStart="bottom"
          horizontalScrollbarOptions={{ visible: false }}
          verticalScrollbarOptions={{
            position: "absolute",
            right: 0,
            top: 0,
            width: 1,
            height: "100%",
            trackOptions: {
              backgroundColor: theme.background.raised.base,
              foregroundColor: theme.scrollbar.base,
            },
          }}
        >
          <For each={entries()}>
            {(entry) => (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
                backgroundColor={rowBackground(entry)}
                onMouseOver={() => showTip(entry)}
                onMouseOut={() => hideTip(entry.id)}
                onMouseDown={() => props.panel.focus()}
                onMouseUp={(event) => open(entry, event.modifiers.ctrl ? "reply" : "prompt")}
              >
                <text fg={rowColor(entry)} wrapMode="none" flexShrink={0}>
                  {entry.kind === "turn" ? String(entry.number).padStart(2, " ") : "⇣ "}
                </text>
                <text fg={theme.text.faint} wrapMode="none" flexShrink={0}>
                  {formatClock(entry.createdAt)}
                </text>
                <text fg={rowColor(entry)} wrapMode="none" truncate flexGrow={1} minWidth={0}>
                  {entry.preview}
                </text>
                <Show when={props.panel.width >= 46}>
                  <text fg={theme.text.faint} wrapMode="none" flexShrink={0}>
                    {entry.kind === "turn" ? detail(entry) : entry.reason}
                  </text>
                </Show>
                <Show when={isRunningTurn(entry)}>
                  <text fg={rowColor(entry)} wrapMode="none" flexShrink={0}>
                    {chase()}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>

      <box flexDirection="column" flexShrink={0} gap={0}>
        <text fg={theme.text.muted} wrapMode="none" truncate>
          click / enter jump · ctrl+click last reply
        </text>
        <text fg={theme.text.faint} wrapMode="none" truncate>
          ↑↓ move · home end first/last · alt+t close
        </text>
      </box>

      <Show when={tip()}>{(state) => <TurnTooltip context={props.context} state={state()} pinned={pinned()} onDismiss={dismissTip} />}</Show>
    </box>
  )
}

function SidebarTurns(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const [hovered, setHovered] = createSignal<string>()
  const [tip, setTip] = createSignal<TooltipState>()
  const [pinned, setPinned] = createSignal(false)
  let pinTimer: ReturnType<typeof setTimeout> | undefined
  const clearPinTimer = () => {
    if (pinTimer) clearTimeout(pinTimer)
    pinTimer = undefined
  }
  const dismissTip = () => {
    clearPinTimer()
    setPinned(false)
    setHovered(undefined)
    setTip(undefined)
  }
  const toggle = () => {
    dismissTip()
    void updateView((draft) => {
      draft.open = !draft.open
    }).catch((error) => console.error("Failed to persist Turns sidebar state", error))
  }
  const armPin = (entry: TurnsEntry) => {
    setPinned(false)
    clearPinTimer()
    pinTimer = setTimeout(() => {
      pinTimer = undefined
      if (tip()?.id === entry.id && hovered() === entry.id) setPinned(true)
    }, TOOLTIP_PIN_MS)
  }
  const jump = createTimelineJump(props.context)
  const jumpCompact = createCompactionJump(props.context)

  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const timeline = createMemo(() => collectTimeline(messages()))
  const turns = createMemo(() => timeline().turns)
  const entries = createMemo(() => timeline().entries)
  const hasEntries = createMemo(() => entries().length > 0)
  const running = createMemo(() => props.context.data.session.status(props.sessionID) === "running")
  const chase = createChase(running)
  const isRunningTurn = (entry: TurnsEntry) =>
    entry.kind === "turn" && running() && entry.id === turns()[turns().length - 1]?.id

  // The sidebar scrollbox owns the remaining viewport height, so measure from
  // this section's top to the viewport bottom and let the list fill it.
  const [listRows, setListRows] = createSignal(SIDEBAR_TURN_ROWS)
  let root: BoxRenderable | undefined
  let list: ScrollBoxRenderable | undefined
  let observed: ScrollBoxRenderable | undefined

  const measure = () => {
    const node = root
    if (!node || node.isDestroyed) return
    let scroll: ScrollBoxRenderable | undefined
    for (let current: Renderable | null | undefined = node.parent; current; current = current.parent) {
      if ("viewport" in current && "content" in current) {
        scroll = current as ScrollBoxRenderable
        break
      }
    }
    if (!scroll) return
    // Other sidebar sections can grow after this one mounts; measuring again
    // when the scroll content or viewport resizes keeps the fill exact.
    if (observed !== scroll) {
      observed?.content.off("resize", scheduleMeasure)
      observed?.viewport.off("resize", scheduleMeasure)
      scroll.content.on("resize", scheduleMeasure)
      scroll.viewport.on("resize", scheduleMeasure)
      observed = scroll
    }
    let top = 0
    let current: Renderable | null | undefined = node
    while (current && current !== scroll.content) {
      top += current.getComputedLayout().top
      current = current.parent
    }
    if (current !== scroll.content) return
    // Reserve one row for the fixed expand hint below the list.
    const rows = scroll.viewport.height - top - 1 - (hasEntries() ? 1 : 0)
    if (rows >= 1) setListRows(rows)
  }
  const scheduleMeasure = () => setTimeout(measure, 0)

  createEffect(() => {
    hasEntries()
    scheduleMeasure()
  })

  onMount(() => {
    scheduleMeasure()
  })
  onCleanup(() => {
    observed?.content.off("resize", scheduleMeasure)
    observed?.viewport.off("resize", scheduleMeasure)
    observed = undefined
  })

  const showTip = (entry: TurnsEntry) => {
    const same = tip()?.id === entry.id
    setHovered(entry.id)
    const index = entries().findIndex((item) => item.id === entry.id)
    const row = index === -1 ? undefined : list?.getChildren()[index]
    if (!row || row.isDestroyed) {
      if (!same) dismissTip()
      return
    }
    const pane = sessionPaneBounds(props.context)
    setTip({
      id: entry.id,
      text: entry.full,
      screenX: row.screenX,
      screenY: row.screenY,
      rowWidth: row.width,
      terminalWidth: props.context.renderer.width,
      terminalHeight: props.context.renderer.height,
      paneTop: pane.top,
      paneHeight: pane.height,
    })
    if (same && (pinned() || pinTimer)) return
    armPin(entry)
  }

  const hideTip = (id: string) => {
    if (hovered() === id) setHovered(undefined)
    if (tip()?.id !== id) return
    clearPinTimer()
    if (pinned()) return
    setTip(undefined)
  }

  createEffect(() => {
    const current = tip()
    if (!current) return
    if (!entries().some((entry) => entry.id === current.id)) dismissTip()
  })
  onCleanup(clearPinTimer)

  return (
    <box ref={(value: BoxRenderable) => (root = value)}>
      <box flexDirection="row" justifyContent="space-between" gap={1} onMouseDown={toggle}>
        <box flexDirection="row" gap={1} minWidth={0}>
          <text fg={theme.text.base} wrapMode="none">
            {view.open ? "▼" : "▶"}
          </text>
          <text fg={theme.text.base} wrapMode="none">
            <b>Turns ({turns().length})</b>
          </text>
        </box>
        <Show when={running()}>
          <text fg={theme.text.feedback.success.base} wrapMode="none">
            ●
          </text>
        </Show>
      </box>
      <Show when={view.open}>
        <Show
          when={entries().length > 0}
        fallback={
          <text fg={theme.text.muted} wrapMode="word">
            No user turns yet
          </text>
        }
      >
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (list = value)}
          height={Math.min(entries().length, listRows())}
          flexShrink={0}
          stickyStart="bottom"
          horizontalScrollbarOptions={{ visible: false }}
          verticalScrollbarOptions={{
            position: "absolute",
            right: 0,
            top: 0,
            width: 1,
            height: "100%",
            trackOptions: {
              backgroundColor: theme.background.raised.base,
              foregroundColor: theme.scrollbar.base,
            },
          }}
        >
          <For each={entries()}>
            {(entry) => (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={hovered() === entry.id ? theme.background.raised.high : undefined}
                onMouseOver={() => showTip(entry)}
                onMouseOut={() => hideTip(entry.id)}
                onMouseUp={(event) => {
                  dismissTip()
                  if (entry.kind === "turn") jump(entry, event.modifiers.ctrl ? "reply" : "prompt")
                  else jumpCompact(entry)
                }}
              >
                <text
                  fg={hovered() === entry.id ? theme.text.base : theme.text.muted}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {entry.kind === "turn" ? `${entry.number}.` : "⇣ "}
                </text>
                <text
                  fg={hovered() === entry.id ? theme.text.base : theme.text.muted}
                  wrapMode="none"
                  truncate
                  flexGrow={1}
                  minWidth={0}
                >
                  {entry.preview}
                </text>
                <Show when={isRunningTurn(entry)}>
                  <text fg={hovered() === entry.id ? theme.text.base : theme.text.muted} wrapMode="none" flexShrink={0}>
                    {chase()}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={hasEntries()}>
        <text fg={theme.text.faint} wrapMode="none" truncate>
          <b>alt+t</b> expand turns
        </text>
      </Show>
      <Show when={tip()}>{(state) => <TurnTooltip context={props.context} state={state()} pinned={pinned()} onDismiss={dismissTip} />}</Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarTurns context={context} sessionID={props.sessionID} />,
    })
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (panel.name === PANEL_NAME ? <TurnsPanel context={context} panel={panel} /> : null),
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "turn-navigator.toggle",
          title: "Turn navigator",
          group: "Session",
          palette: true,
          bind: "alt+t",
          slash: { name: "turns" },
          enabled: () => context.ui.router.current().type === "session",
          run: () => {
            const current = context.ui.panel.current()
            const route = context.ui.router.current()
            if (current && route.type === "session" && current.sessionID === route.sessionID) {
              context.ui.panel.close()
              return
            }
            if (!context.ui.panel.open(PANEL_NAME)) {
              context.ui.toast.show({ variant: "warning", message: "Open a session to browse its turns" })
            }
          },
        },
      ],
    }))
  },
})
