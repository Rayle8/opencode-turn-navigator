import type { SessionMessageInfo } from "@opencode/client"

/**
 * One user prompt and everything the assistant produced before the next prompt.
 *
 * `previousPrompts` is how many non-empty user prompts follow this turn, which
 * is how many `session.message.user.previous` steps reach it from the last
 * prompt. `replyStops` counts assistant messages the host's message navigation
 * stops at, which is how many `session.message.next` steps reach the last
 * reply from this turn's prompt. `preview` collapses whitespace for one-line
 * rows; `full` keeps the original line breaks for the hover view.
 */
export type Turn = {
  readonly id: string
  readonly number: number
  readonly createdAt: number
  readonly preview: string
  readonly full: string
  readonly previousPrompts: number
  readonly assistantMessages: number
  readonly replyStops: number
  readonly toolCalls: number
}

export function collectTurns(messages: readonly SessionMessageInfo[]): Turn[] {
  const totalPrompts = messages.filter((message) => message.type === "user" && message.text.trim()).length
  const turns: Turn[] = []
  let promptIndex = 0
  let current: Turn | undefined
  for (const message of messages) {
    if (message.type === "user") {
      const text = message.text.replace(/\s+/g, " ").trim()
      if (!text) {
        current = undefined
        continue
      }
      const index = promptIndex++
      current = {
        id: message.id,
        number: turns.length + 1,
        createdAt: message.time.created,
        preview: text,
        full: message.text.trim(),
        previousPrompts: totalPrompts - 1 - index,
        assistantMessages: 0,
        replyStops: 0,
        toolCalls: 0,
      }
      turns.push(current)
      continue
    }
    if (!current || message.type !== "assistant") continue
    turns[turns.length - 1] = {
      ...current,
      assistantMessages: current.assistantMessages + 1,
      replyStops:
        current.replyStops + (message.content.some((part) => part.type === "text" && part.text.trim()) ? 1 : 0),
      toolCalls: current.toolCalls + message.content.filter((part) => part.type === "tool").length,
    }
    current = turns[turns.length - 1]
  }
  return turns
}

export function formatClock(createdAt: number) {
  const date = new Date(createdAt)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
