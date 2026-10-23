import assert from "node:assert/strict"
import { test } from "node:test"
import { collectSessionUsage, collectTimeline, filterEntries, formatTokens } from "../turns.ts"

const model = { providerID: "anthropic", id: "claude", variant: undefined }

function user(id: string, text: string, created = 0): any {
  return { type: "user", id, text, time: { created } }
}

function assistant(
  id: string,
  opts: {
    read?: number
    input?: number
    output?: number
    cost?: number
    text?: string
    tools?: number
    created?: number
    streamed?: number
    providerID?: string
  } = {},
): any {
  const content: any[] = []
  if (opts.text) content.push({ type: "text", text: opts.text })
  for (let i = 0; i < (opts.tools ?? 0); i++) content.push({ type: "tool" })
  return {
    type: "assistant",
    id,
    model: { ...model, providerID: opts.providerID ?? model.providerID },
    tokens: {
      input: opts.input ?? 0,
      output: opts.output ?? 0,
      reasoning: 0,
      cache: { read: opts.read ?? 0, write: 0 },
    },
    cost: opts.cost,
    time: { created: opts.created ?? 0, streamed: opts.streamed },
    content,
  }
}

function compaction(id: string, status: "running" | "completed" | "failed" = "completed"): any {
  const base = { type: "compaction", id, status, reason: "auto", time: { created: 0 } }
  if (status === "running") return { ...base, summary: "" }
  if (status === "failed") return { ...base, error: { type: "aborted", message: "stop" } }
  return { ...base, summary: "sum", tokens: undefined, cost: undefined }
}

test("filterEntries matches all terms case-insensitively and keeps order", () => {
  const { entries } = collectTimeline([
    user("u1", "Fix the Login bug"),
    assistant("a1", { text: "ok" }),
    user("u2", "write docs"),
    user("u3", "login docs update"),
  ])
  assert.equal(filterEntries(entries, "").length, 3)
  assert.equal(filterEntries(entries, "   ").length, 3)
  assert.deepEqual(filterEntries(entries, "LOGIN").map((e) => e.id), ["u1", "u3"])
  assert.deepEqual(filterEntries(entries, "login docs").map((e) => e.id), ["u3"])
  assert.deepEqual(filterEntries(entries, "nothing"), [])
})

test("filterEntries also searches assistant text replies, across steps", () => {
  const { entries } = collectTimeline([
    user("u1", "refactor"),
    assistant("a1", { text: "Moved the Parser into core" }),
    assistant("a2", { tools: 1 }),
    assistant("a3", { text: "done, tests green" }),
    user("u2", "unrelated"),
    assistant("a4", { text: "nothing here" }),
  ])
  assert.deepEqual(filterEntries(entries, "parser").map((e) => e.id), ["u1"])
  assert.deepEqual(filterEntries(entries, "refactor green").map((e) => e.id), ["u1"])
  assert.deepEqual(filterEntries(entries, "nothing").map((e) => e.id), ["u2"])
  assert.deepEqual(filterEntries(entries, "parser nothing"), [])
})

test("formatTokens", () => {
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(1000), "1k")
  assert.equal(formatTokens(1500), "1.5k")
  assert.equal(formatTokens(123_456), "123k")
  assert.equal(formatTokens(2_500_000), "2.5m")
})

test("turns count previousPrompts, replies, tools and skip blank prompts", () => {
  const { turns } = collectTimeline([
    user("u1", "first\nprompt"),
    assistant("a1", { text: "hi", tools: 2 }),
    assistant("a2", { tools: 1 }),
    user("blank", "   "),
    user("u2", "second"),
    assistant("a3", { text: "ok" }),
  ])
  assert.equal(turns.length, 2)
  assert.deepEqual(
    turns.map((t) => [t.number, t.previousPrompts, t.assistantMessages, t.replyStops, t.toolCalls]),
    [
      [1, 1, 2, 1, 3],
      [2, 0, 1, 1, 0],
    ],
  )
  assert.equal(turns[0]!.preview, "first prompt")
  assert.equal(turns[0]!.full, "first\nprompt")
})

test("turn token stats: latest step is the turn size, cost and tps accumulate", () => {
  const { turns } = collectTimeline([
    user("u1", "go"),
    assistant("a1", { input: 100, output: 50, read: 0, cost: 0.01, created: 0, streamed: 1000 }),
    assistant("a2", { input: 20, output: 80, read: 200, cost: 0.02, created: 2000, streamed: 3000 }),
  ])
  const turn = turns[0]!
  assert.equal(turn.tokenSteps, 2)
  assert.equal(turn.tokenTotal, 300)
  assert.equal(turn.tokenCached, 200)
  assert.equal(turn.tokenNew, 100)
  assert.ok(Math.abs(turn.tokenCost! - 0.03) < 1e-9)
  assert.equal(turn.tokenTps, 130 / 2)
  assert.equal(turn.tokenBusts, undefined)
})

test("cache bust is counted when cache read drops, except openai 1k-2k noise", () => {
  const busted = collectTimeline([
    user("u1", "go"),
    assistant("a1", { input: 10, read: 5000 }),
    assistant("a2", { input: 10, read: 100 }),
  ]).turns[0]!
  assert.equal(busted.tokenBusts, 1)

  const noise = collectTimeline([
    user("u1", "go"),
    assistant("a1", { input: 10, read: 5000, providerID: "openai" }),
    assistant("a2", { input: 10, read: 3500, providerID: "openai" }),
  ]).turns[0]!
  assert.equal(noise.tokenBusts, undefined)
})

test("compaction row: saved tokens, pending, running", () => {
  const done = collectTimeline([
    user("u1", "go"),
    assistant("a1", { input: 1000 }),
    compaction("c1"),
    assistant("a2", { input: 200 }),
  ])
  const row = done.entries[1] as any
  assert.equal(row.kind, "compaction")
  assert.equal(row.savedTokens, 800)
  assert.equal(row.preview, "compact · saved 800 (80%)")

  const pending = collectTimeline([user("u1", "go"), assistant("a1", { input: 1000 }), compaction("c1")])
  assert.equal((pending.entries[1] as any).preview, "compact · 1k→…")

  const running = collectTimeline([user("u1", "go"), assistant("a1", { input: 1000 }), compaction("c1", "running")])
  assert.equal((running.entries[1] as any).preview, "compact · running")
})

test("compaction jumpSteps is relative to the last user prompt", () => {
  const { entries } = collectTimeline([
    user("u1", "one"),
    assistant("a1", { text: "r1" }),
    compaction("c1"),
    user("u2", "two"),
    assistant("a2", { text: "r2" }),
  ])
  // boundaries: u1, a1, u2, a2 -> compaction maps to a1 (index 1), last user is u2 (index 2)
  assert.equal((entries[1] as any).jumpSteps, -1)
})

test("collectSessionUsage sums up to the turn and reports that turn's context", () => {
  const messages = [
    user("u1", "one"),
    assistant("a1", { input: 100, read: 0, cost: 0.1 }),
    user("u2", "two"),
    assistant("a2", { input: 50, read: 300, cost: 0.2 }),
    user("u3", "three"),
    assistant("a3", { input: 10, read: 999, cost: 0.3 }),
  ]
  const usage = collectSessionUsage(messages, "u2")!
  assert.equal(usage.total, 450)
  assert.equal(usage.cached, 300)
  assert.equal(usage.context, 350)
  assert.ok(Math.abs(usage.cost! - 0.3) < 1e-9)
  assert.equal(collectSessionUsage(messages, "missing"), undefined)
})
