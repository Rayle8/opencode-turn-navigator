import type { SessionMessageInfo, TokenUsageInfo } from "@opencode/client"

/**
 * One user prompt and everything the assistant produced before the next prompt.
 *
 * `previousPrompts` is how many non-empty user prompts follow this turn, which
 * is how many `session.message.user.previous` steps reach it from the last
 * prompt. `replyStops` counts assistant messages the host's message navigation
 * stops at, which is how many `session.message.next` steps reach the last
 * reply from this turn's prompt. `preview` collapses whitespace for one-line
 * rows; `full` keeps the original line breaks for the hover tooltip.
 */
export type Turn = {
  readonly kind: "turn"
  readonly id: string
  readonly number: number
  readonly createdAt: number
  readonly preview: string
  readonly full: string
  readonly previousPrompts: number
  readonly assistantMessages: number
  readonly replyStops: number
  readonly toolCalls: number
  readonly tokenSteps?: number
  readonly tokenNew?: number
  readonly tokenCached?: number
  readonly tokenTotal?: number
  readonly tokenCost?: number
  readonly tokenTps?: number
  readonly tokenBusts?: number
  readonly tokenModel?: { readonly providerID: string; readonly id: string; readonly variant?: string }
}

/**
 * A context compaction between turns. `beforeTokens` is the last context usage
 * reported before the compaction; `afterTokens` is the first one reported
 * afterwards, so `savedTokens` only exists once the next assistant step lands.
 * `usage` is the compaction request's own token spend, not the amount saved.
 */
export type Compaction = {
  readonly kind: "compaction"
  readonly id: string
  readonly createdAt: number
  readonly status: "running" | "completed" | "failed"
  readonly reason: "auto" | "manual"
  readonly preview: string
  readonly full: string
  readonly summary?: string
  readonly beforeTokens?: number
  readonly afterTokens?: number
  readonly savedTokens?: number
  readonly usage?: TokenUsageInfo
  readonly cost?: number
  readonly error?: string
  readonly cancelled: boolean
  /** Signed boundary steps from the last user prompt; undefined when no navigable message exists. */
  readonly jumpSteps?: number
}

export type TurnsEntry = Turn | Compaction

export type Timeline = {
  readonly turns: Turn[]
  readonly entries: TurnsEntry[]
}

export function collectTimeline(messages: readonly SessionMessageInfo[]): Timeline {
  const totalPrompts = messages.filter((message) => message.type === "user" && message.text.trim()).length
  const before = compactionBefore(messages)
  const after = compactionAfter(messages)
  const jumps = compactionJumps(messages)
  const turns: Turn[] = []
  const entries: TurnsEntry[] = []
  let promptIndex = 0
  let current: Turn | undefined
  let currentEntry = -1
  let tokenSteps = 0
  let tokenNew = 0
  let tokenCached = 0
  let tokenTotal = 0
  let tokenCost = 0
  let tokenHasCost = false
  let tokenBusts = 0
  let tpsOutput = 0
  let tpsDuration = 0
  let tokenModel: Turn["tokenModel"]
  let previousToken: { read: number; model: NonNullable<Turn["tokenModel"]> } | undefined

  const resetTokens = () => {
    tokenSteps = 0
    tokenNew = 0
    tokenCached = 0
    tokenTotal = 0
    tokenCost = 0
    tokenHasCost = false
    tokenBusts = 0
    tpsOutput = 0
    tpsDuration = 0
    tokenModel = undefined
    previousToken = undefined
  }

  for (const message of messages) {
    if (message.type === "user") {
      const text = message.text.replace(/\s+/g, " ").trim()
      if (!text) {
        current = undefined
        currentEntry = -1
        continue
      }
      const index = promptIndex++
      resetTokens()
      current = {
        kind: "turn",
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
      currentEntry = entries.length
      entries.push(current)
      continue
    }
    if (message.type === "assistant") {
      if (!current) continue
      const tokens = message.tokens
      if (tokens) {
        const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
        if (total > 0) {
          const cached = tokens.cache.read
          tokenSteps += 1
          tokenNew = total - cached
          tokenCached = cached
          tokenTotal = total
          tokenModel = {
            providerID: message.model.providerID,
            id: message.model.id,
            variant: message.model.variant,
          }
          if (message.cost !== undefined) {
            tokenCost += message.cost
            tokenHasCost = true
          }
          if (message.time.streamed !== undefined) {
            tpsOutput += tokens.output + tokens.reasoning
            tpsDuration += Math.max(0, message.time.streamed - message.time.created)
          }
          if (
            previousToken &&
            previousToken.model.providerID === message.model.providerID &&
            previousToken.model.id === message.model.id &&
            previousToken.model.variant === message.model.variant
          ) {
            const drop = previousToken.read - cached
            if (!(message.model.providerID === "openai" && drop >= 1_024 && drop <= 2_048) && drop > 0) {
              tokenBusts += 1
            }
          }
          previousToken = {
            read: cached,
            model: {
              providerID: message.model.providerID,
              id: message.model.id,
              variant: message.model.variant,
            },
          }
        }
      }
      const updated: Turn = {
        ...current,
        assistantMessages: current.assistantMessages + 1,
        replyStops:
          current.replyStops + (message.content.some((part) => part.type === "text" && part.text.trim()) ? 1 : 0),
        toolCalls: current.toolCalls + message.content.filter((part) => part.type === "tool").length,
        ...(tokenSteps > 0
          ? {
              tokenSteps,
              tokenNew,
              tokenCached,
              tokenTotal,
              tokenCost: tokenHasCost ? tokenCost : undefined,
              tokenTps: tpsDuration > 0 ? tpsOutput / (tpsDuration / 1_000) : undefined,
              tokenBusts: tokenBusts || undefined,
              tokenModel,
            }
          : {}),
      }
      turns[turns.length - 1] = updated
      entries[currentEntry] = updated
      current = updated
      continue
    }
    if (message.type === "compaction") {
      entries.push(
        collectCompaction(message, before.get(message.id), after.get(message.id), jumps.get(message.id)),
      )
    }
  }

  return { turns, entries }
}

/**
 * The context size reported by the most recent assistant step before each
 * compaction. A compaction does not report the context it replaced, so the
 * preceding step is the last observable size.
 */
function compactionBefore(messages: readonly SessionMessageInfo[]) {
  const result = new Map<string, number>()
  let last: number | undefined
  for (const message of messages) {
    if (message.type === "assistant") {
      const tokens = contextTokens(message)
      if (tokens !== undefined) last = tokens
      continue
    }
    if (message.type !== "compaction") continue
    if (last !== undefined) result.set(message.id, last)
    // A compaction starts a new context, so an assistant before it cannot be
    // the size observed before the next compaction.
    last = undefined
  }
  return result
}

/**
 * The context size reported by the first assistant step after each compaction.
 * Until that step exists the benefit is unknown, so the row shows the pending
 * marker instead of inventing a number from the compaction request usage.
 */
function compactionAfter(messages: readonly SessionMessageInfo[]) {
  const result = new Map<string, number>()
  let next: number | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === "assistant") {
      const tokens = contextTokens(message)
      if (tokens !== undefined) next = tokens
      continue
    }
    if (message.type !== "compaction") continue
    if (next !== undefined) result.set(message.id, next)
    // Do not attribute an assistant after a later compaction to this one.
    next = undefined
  }
  return result
}

/** The host counts a step's context as its input, output, reasoning, and both caches. */
function contextTokens(message: Extract<SessionMessageInfo, { type: "assistant" }>) {
  const tokens = message.tokens
  if (!tokens) return undefined
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/**
 * Compaction rows have no host navigation boundary of their own, so jump to the
 * nearest user/assistant boundary around them. The count is relative to the last
 * user prompt, which is where the jump starts.
 */
function compactionJumps(messages: readonly SessionMessageInfo[]) {
  const boundaries: Array<{ index: number; user: boolean }> = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.type === "user" && message.text.trim()) {
      boundaries.push({ index, user: true })
      continue
    }
    if (message.type === "assistant" && message.content.some((part) => part.type === "text" && part.text.trim())) {
      boundaries.push({ index, user: false })
    }
  }
  const lastUser = boundaries.findLastIndex((boundary) => boundary.user)
  if (lastUser === -1) return new Map<string, number>()

  const result = new Map<string, number>()
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.type !== "compaction") continue
    const target = boundaries.findLastIndex((boundary) => boundary.index < index)
    const position = target !== -1 ? target : boundaries.findIndex((boundary) => boundary.index > index)
    if (position === -1) continue
    result.set(messages[index]!.id, position - lastUser)
  }
  return result
}

function collectCompaction(
  message: Extract<SessionMessageInfo, { type: "compaction" }>,
  before: number | undefined,
  after: number | undefined,
  jumpSteps: number | undefined,
): Compaction {
  const cancelled =
    message.status === "failed" &&
    (message.error.type === "aborted" || message.error.type === "compaction.interrupted")
  const summary = message.status === "failed" ? "" : message.summary.trim()
  const usage = message.status === "running" ? undefined : message.tokens
  const cost = message.status === "running" ? undefined : message.cost
  const error = message.status === "failed" ? message.error.message : undefined
  // A failed or cancelled compaction leaves the context unchanged, so its
  // neighbouring assistant sizes are not a saving.
  const beforeTokens = message.status === "failed" ? undefined : before
  const afterTokens = message.status === "failed" ? undefined : after
  const saved =
    beforeTokens !== undefined && afterTokens !== undefined ? beforeTokens - afterTokens : undefined
  const native = message.status === "completed" && Boolean(message.native?.messages)
  const statusLabel = cancelled ? "cancelled" : message.status

  return {
    kind: "compaction",
    id: message.id,
    createdAt: message.time.created,
    status: message.status,
    reason: message.reason,
    preview: compactionPreview(message.status, cancelled, beforeTokens, afterTokens, saved),
    full: compactionDetails({
      reason: message.reason,
      status: statusLabel,
      native,
      summary,
      before: beforeTokens,
      after: afterTokens,
      saved,
      usage,
      cost,
      error,
    }),
    summary: summary || undefined,
    beforeTokens,
    afterTokens,
    savedTokens: saved,
    usage,
    cost,
    error,
    cancelled,
    jumpSteps,
  }
}

function compactionPreview(
  status: Compaction["status"],
  cancelled: boolean,
  before: number | undefined,
  after: number | undefined,
  saved: number | undefined,
) {
  if (status === "running") return "compact · running"
  if (status === "failed") return cancelled ? "compact · cancelled" : "compact · failed"
  if (saved !== undefined) {
    if (saved > 0) {
      const percent = before! > 0 ? Math.round((saved / before!) * 100) : 0
      return `compact · saved ${formatTokens(saved)} (${percent}%)`
    }
    return `compact · ${formatTokens(before!)}→${formatTokens(after!)}`
  }
  if (before !== undefined) return `compact · ${formatTokens(before)}→…`
  if (after !== undefined) return `compact · ${formatTokens(after)} ctx`
  return "compact · completed"
}

function compactionDetails(input: {
  reason: "auto" | "manual"
  status: string
  native: boolean
  summary: string
  before: number | undefined
  after: number | undefined
  saved: number | undefined
  usage: TokenUsageInfo | undefined
  cost: number | undefined
  error: string | undefined
}) {
  const lines = [`${input.reason === "auto" ? "Auto" : "Manual"} compaction · ${input.status}`]
  if (input.native) lines.push("Provider-native compaction")

  if (input.before !== undefined && input.after !== undefined) {
    lines.push(`Context: ${formatExactTokens(input.before)} → ${formatExactTokens(input.after)} tokens`)
    if (input.saved !== undefined && input.saved > 0) {
      const percent = input.before! > 0 ? Math.round((input.saved / input.before!) * 100) : 0
      lines.push(`Saved: ${formatExactTokens(input.saved)} tokens (${percent}%)`)
    } else if (input.saved !== undefined && input.saved < 0) {
      lines.push(`Context grew by ${formatExactTokens(-input.saved)} tokens`)
    } else {
      lines.push("Context size unchanged")
    }
  } else if (input.before !== undefined) {
    lines.push(`Context before: ${formatExactTokens(input.before)} tokens`)
    lines.push("New context size: pending the next reply")
  } else if (input.after !== undefined) {
    lines.push(`Context after: ${formatExactTokens(input.after)} tokens`)
  }

  if (input.usage) {
    const tokens = input.usage
    const tokenInput = tokens.input + tokens.cache.read + tokens.cache.write
    const tokenOutput = tokens.output + tokens.reasoning
    lines.push(`Compact request: ${formatExactTokens(tokenInput)} in · ${formatExactTokens(tokenOutput)} out`)
  }
  if (input.cost !== undefined) lines.push(`Cost: $${input.cost.toFixed(4)}`)
  if (input.status === "failed" && input.error) lines.push(`Error: ${input.error}`)
  if (input.summary) {
    lines.push("")
    lines.push(input.summary)
  }
  return lines.join("\n")
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${formatUnit(value, 1_000_000)}m`
  if (value >= 1_000) return `${formatUnit(value, 1_000)}k`
  return String(Math.round(value))
}

function formatUnit(value: number, unit: number) {
  const scaled = value / unit
  if (scaled >= 100) return String(Math.round(scaled))
  return scaled.toFixed(1).replace(/\.0$/, "")
}

function formatExactTokens(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value))
}

export function formatClock(createdAt: number) {
  const date = new Date(createdAt)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
