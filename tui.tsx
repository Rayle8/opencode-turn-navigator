import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { BoxRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { collectTurns, formatClock, type Turn } from "./turns"

const PLUGIN_ID = "turn-navigator"
const PANEL_NAME = "turn-navigator.turns"
const LAST_USER_COMMAND = "session.messages_last_user"
const PREVIOUS_USER_COMMAND = "session.message.user.previous"
const NEXT_MESSAGE_COMMAND = "session.message.next"
const JUMP_SETTLE_MS = 120

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

function TurnsPanel(props: { context: Plugin.Context; panel: PanelInput }) {
  const theme = props.context.theme
  const [remembered, setRemembered] = props.context.storage.memory<{ id?: string }>("selection", { initial: {} })
  const [hovered, setHovered] = createSignal<string>()
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
  let scroll: ScrollBoxRenderable | undefined

  const messages = createMemo(() => props.context.data.session.message.list(props.panel.sessionID))
  const turns = createMemo(() => collectTurns(messages()))
  // Chronological, oldest first.
  const ordered = createMemo(() => turns())
  const running = createMemo(() => props.context.data.session.status(props.panel.sessionID) === "running")
  const chase = createChase(running)
  const selectedTurn = createMemo(() => turns().find((turn) => turn.id === selected()))

  createEffect(() => {
    const list = ordered()
    if (list.length === 0) {
      setSelected(undefined)
      return
    }
    if (!list.some((turn) => turn.id === selected())) setSelected(list[list.length - 1]!.id)
  })

  const reveal = (id: string | undefined) => {
    if (!id || !scroll || scroll.isDestroyed) return
    const index = ordered().findIndex((turn) => turn.id === id)
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
    const list = ordered()
    if (list.length === 0) return
    const index = list.findIndex((turn) => turn.id === selected())
    const next = index === -1 ? 0 : (index + delta + list.length) % list.length
    setSelected(list[next]!.id)
    reveal(list[next]!.id)
  }

  const select = (turn: Turn | undefined) => {
    if (!turn) return
    setSelected(turn.id)
    reveal(turn.id)
  }

  const open = (turn: Turn, target: JumpTarget) => {
    setSelected(turn.id)
    jump(turn, target)
  }

  props.context.keymap.layer(() => ({
    priority: 20,
    commands: [
      {
        id: "turn-navigator.panel.next",
        title: "Next turn",
        group: "Turn navigator",
        bind: "j",
        run: () => move(1),
      },
      {
        id: "turn-navigator.panel.previous",
        title: "Previous turn",
        group: "Turn navigator",
        bind: "k",
        run: () => move(-1),
      },
      {
        id: "turn-navigator.panel.first",
        title: "First turn",
        group: "Turn navigator",
        bind: "g",
        run: () => select(ordered()[0]),
      },
      {
        id: "turn-navigator.panel.last",
        title: "Last turn",
        group: "Turn navigator",
        bind: "shift+g",
        run: () => select(ordered()[ordered().length - 1]),
      },
      {
        id: "turn-navigator.panel.open",
        title: "Jump to turn",
        group: "Turn navigator",
        bind: "return",
        run: () => {
          const turn = selectedTurn()
          if (turn) jump(turn)
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

  const isRunningTurn = (turn: Turn) => running() && turn.id === turns()[turns().length - 1]?.id
  const rowBackground = (turn: Turn) => {
    if (turn.id === selected()) return theme.background.raised.high
    if (turn.id === hovered()) return theme.background.raised.max
  }
  const rowColor = (turn: Turn) =>
    turn.id === selected() || turn.id === hovered() ? theme.text.base : theme.text.muted
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
        when={ordered().length > 0}
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
          <For each={ordered()}>
            {(turn) => (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
                backgroundColor={rowBackground(turn)}
                onMouseOver={() => setHovered(turn.id)}
                onMouseOut={() => {
                  if (hovered() === turn.id) setHovered(undefined)
                }}
                onMouseDown={() => props.panel.focus()}
                onMouseUp={(event) => open(turn, event.modifiers.ctrl ? "reply" : "prompt")}
              >
                <text fg={rowColor(turn)} wrapMode="none" flexShrink={0}>
                  {String(turn.number).padStart(2, " ")}
                </text>
                <text fg={theme.text.faint} wrapMode="none" flexShrink={0}>
                  {formatClock(turn.createdAt)}
                </text>
                <text
                  fg={rowColor(turn)}
                  wrapMode={hovered() === turn.id ? "word" : "none"}
                  truncate={hovered() !== turn.id}
                  flexGrow={1}
                  minWidth={0}
                >
                  {hovered() === turn.id ? turn.full : turn.preview}
                </text>
                <Show when={props.panel.width >= 46}>
                  <text fg={theme.text.faint} wrapMode="none" flexShrink={0}>
                    {detail(turn)}
                  </text>
                </Show>
                <Show when={isRunningTurn(turn)}>
                  <text fg={rowColor(turn)} wrapMode="none" flexShrink={0}>
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
          click / enter prompt · ctrl+click last reply
        </text>
        <text fg={theme.text.faint} wrapMode="none" truncate>
          j k move · g shift+g first/last · alt+t close
        </text>
      </box>
    </box>
  )
}

function SidebarTurns(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const [hovered, setHovered] = createSignal<string>()
  const jump = createTimelineJump(props.context)

  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const turns = createMemo(() => collectTurns(messages()))
  const running = createMemo(() => props.context.data.session.status(props.sessionID) === "running")
  const chase = createChase(running)
  const isRunningTurn = (turn: Turn) => running() && turn.id === turns()[turns().length - 1]?.id

  // The sidebar scrollbox owns the remaining viewport height, so measure from
  // this section's top to the viewport bottom and let the list fill it.
  const [listRows, setListRows] = createSignal(SIDEBAR_TURN_ROWS)
  let root: BoxRenderable | undefined
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
    const rows = scroll.viewport.height - top - 1
    if (rows >= 1) setListRows(rows)
  }
  const scheduleMeasure = () => setTimeout(measure, 0)

  onMount(() => {
    scheduleMeasure()
  })
  onCleanup(() => {
    observed?.content.off("resize", scheduleMeasure)
    observed?.viewport.off("resize", scheduleMeasure)
    observed = undefined
  })

  return (
    <box ref={(value: BoxRenderable) => (root = value)}>
      <text fg={theme.text.base} wrapMode="none">
        <b>Turns ({turns().length})</b>
      </text>
      <Show
        when={turns().length > 0}
        fallback={
          <text fg={theme.text.muted} wrapMode="word">
            No user turns yet
          </text>
        }
      >
        <scrollbox
          height={Math.min(turns().length, listRows())}
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
          <For each={turns()}>
            {(turn) => (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={hovered() === turn.id ? theme.background.raised.high : undefined}
                onMouseOver={() => setHovered(turn.id)}
                onMouseOut={() => {
                  if (hovered() === turn.id) setHovered(undefined)
                }}
                onMouseUp={(event) => jump(turn, event.modifiers.ctrl ? "reply" : "prompt")}
              >
                <text fg={hovered() === turn.id ? theme.text.base : theme.text.muted} wrapMode="none" flexShrink={0}>
                  {turn.number}.
                </text>
                <text
                  fg={hovered() === turn.id ? theme.text.base : theme.text.muted}
                  wrapMode={hovered() === turn.id ? "word" : "none"}
                  truncate={hovered() !== turn.id}
                  flexGrow={1}
                  minWidth={0}
                >
                  {hovered() === turn.id ? turn.full : turn.preview}
                </text>
                <Show when={isRunningTurn(turn)}>
                  <text fg={hovered() === turn.id ? theme.text.base : theme.text.muted} wrapMode="none" flexShrink={0}>
                    {chase()}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </scrollbox>
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
