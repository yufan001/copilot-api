import fs from "node:fs"
import path from "node:path"

import { createHandlerLogger } from "./logger"
import { PATHS } from "./paths"

const LOG_DIR = path.join(PATHS.APP_DIR, "logs")

/**
 * Structured record of a single upstream Copilot API request.
 *
 * One line per request is appended to `<APP_DIR>/logs/upstream-trace-YYYY-MM-DD.jsonl`
 * in strict JSONL format, so it can be inspected with `jq` or read programmatically.
 *
 * The same payload is also written through the shared handler logger
 * (`<APP_DIR>/logs/upstream-trace-YYYY-MM-DD.log`) for human browsing.
 *
 * No request/response bodies are captured — only headers, status, and identifying metadata.
 */
export interface UpstreamTraceEntry {
  ts: string
  source_route: string | null
  upstream_path: string
  method: string
  model: string | null
  x_request_id: string | null
  x_interaction_id: string | null
  x_initiator: string | null
  x_interaction_type: string | null
  /**
   * Copilot CAPI `X-Agent-Task-Id`: a stable per-agent-instance identifier.
   * For subagent calls we set this to the `SubagentMarker.agent_id` injected
   * by the Claude Code `SubagentStart` hook (so all upstream requests from
   * the same subagent share the same task id).
   * Null on main-conversation requests — we do not currently generate one
   * for the root agent, since Claude Code does not expose a stable instance
   * id to the proxy layer.
   */
  x_agent_task_id: string | null
  has_vision: boolean
  anthropic_beta: string | null
  /** Parsed by the handler (currently only `/v1/messages` supports it). */
  subagent_marker_present: boolean
  subagent_agent_id: string | null
  subagent_agent_type: string | null
  subagent_session_id: string | null
  /**
   * True if the raw request body contains the literal `__SUBAGENT_MARKER__` string.
   * Diagnoses whether the plugin hook actually injected the marker,
   * independent of whether our parser matched it.
   */
  marker_in_body: boolean
  /** Total approximate size of the outbound JSON body (chars). */
  body_size: number
  /** Wall-clock ms between request start and response headers. */
  duration_ms: number | null
  /** HTTP status from upstream; null if fetch threw before any response. */
  status: number | null
  /**
   * Selected upstream response headers (keys lower-cased).
   * Whitelist: any header starting with `x-`, `openai-`, `github-`, `copilot-`,
   * plus a few well-known infrastructure headers.
   */
  response_headers: Record<string, string> | null
  /** Error message if the fetch threw or returned non-2xx (best-effort). */
  error: string | null
}

const logger = createHandlerLogger("upstream-trace")

const getTodayJsonlPath = (): string => {
  const dateKey = new Date().toLocaleDateString("sv-SE")
  return path.join(LOG_DIR, `upstream-trace-${dateKey}.jsonl`)
}

/** Absolute path to today's JSONL trace file (used by startup banner). */
export const getUpstreamTracePath = (): string => getTodayJsonlPath()

const ensureLogDir = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

/**
 * Returns true when the current process is a unit-test runner.
 *
 * `bun test` and `vitest` both set `NODE_ENV=test` automatically.
 * Skipping trace I/O during tests prevents test fixtures (mock model
 * names like `gpt-test`, `smoke-test-model`, `gpt-4.1`) from polluting
 * the production JSONL log and skewing the /admin Trace dashboard.
 *
 * Tests that explicitly *want* to assert on trace output can set
 * `COPILOT_API_FORCE_TRACE=1` to opt back in.
 */
const isTestEnv = (): boolean =>
  process.env.NODE_ENV === "test" && !process.env.COPILOT_API_FORCE_TRACE

export const recordUpstream = (entry: UpstreamTraceEntry): void => {
  if (isTestEnv()) return

  try {
    ensureLogDir()
    fs.appendFileSync(getTodayJsonlPath(), `${JSON.stringify(entry)}\n`)
  } catch (err) {
    // Best-effort: never let tracing fail the upstream request.
    console.warn("[upstream-trace] failed to append JSONL", err)
  }

  logger.info(JSON.stringify(entry))
}

const INTERESTING_HEADER_PREFIXES = ["x-", "openai-", "github-", "copilot-"]
const EXTRA_INTERESTING_HEADERS = new Set([
  "server",
  "via",
  "cf-ray",
  "cf-cache-status",
  "age",
  "date",
  "content-type",
])

/**
 * Pulls the diagnostic headers we care about out of an upstream Response.
 * Header names are lower-cased.
 */
export const extractInterestingHeaders = (
  headers: Headers,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase()
    if (
      EXTRA_INTERESTING_HEADERS.has(lower)
      || INTERESTING_HEADER_PREFIXES.some((p) => lower.startsWith(p))
    ) {
      out[lower] = value
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Aggregation for /admin Trace tab                                    */
/* ------------------------------------------------------------------ */

/**
 * Copilot per-model premium request multiplier.
 *
 * Source: GitHub Copilot's public pricing page (numbers verified against
 * live `x-quota-snapshot-premium_interactions` deltas in trace logs).
 *
 * A "premium unit" is the base ration where 1 unit = 1 request on a 1× model.
 * The monthly entitlement (`ent`) is expressed in these units (e.g. 1500).
 *
 * Lookups are done with a `.includes(key)` scan so we match both the short
 * marketing name (`gpt-5-mini`) and the fully qualified id
 * (`gpt-5-mini-20251010` / `claude-opus-4.7`) without maintaining a second
 * table. First match wins — order matters, put the most specific keys first.
 */
const MODEL_MULTIPLIERS: Array<{ match: string; multiplier: number }> = [
  { match: "gpt-5-mini", multiplier: 0 },
  { match: "gpt-4o-mini", multiplier: 0 },
  { match: "o4-mini", multiplier: 0.33 },
  { match: "gpt-4.1", multiplier: 0 },
  { match: "claude-haiku", multiplier: 0.33 },
  { match: "gpt-5.4", multiplier: 1 },
  { match: "gpt-5", multiplier: 1 },
  { match: "claude-sonnet", multiplier: 1 },
  { match: "claude-3-5-sonnet", multiplier: 1 },
  { match: "gemini-2", multiplier: 1 },
  { match: "o1-preview", multiplier: 10 },
  { match: "o1", multiplier: 1 },
  { match: "o3-mini", multiplier: 0.33 },
  { match: "o3", multiplier: 1 },
  { match: "claude-opus-4.7", multiplier: 7.5 },
  { match: "claude-opus-4.6", multiplier: 7.5 },
  { match: "claude-opus", multiplier: 7.5 },
  { match: "goldeneye", multiplier: 0 },
]

export const getModelMultiplier = (model: string | null): number | null => {
  if (!model) return null
  const lower = model.toLowerCase()
  for (const { match, multiplier } of MODEL_MULTIPLIERS) {
    if (lower.includes(match)) return multiplier
  }
  return null
}

export interface TraceDayBucket {
  /** YYYY-MM-DD in local TZ (matches the JSONL file naming). */
  date: string
  total: number
  subagent: number
  mainConversation: number
  /**
   * Sum of `rem` drops between consecutive entries, in **percent of monthly
   * entitlement** (e.g. 0.5 means 0.5% of the month's budget, which on a
   * 1500-unit plan = 7.5 premium units = 1 Opus call).
   *
   * Kept for backwards compatibility with external consumers of this field.
   * New UI should prefer `premiumConsumedUnits`.
   */
  premiumConsumed: number
  /**
   * Same drop, converted to absolute premium units using the plan's `ent`
   * (e.g. 1500). 1 unit ≈ 1 gpt-5.4 call, 7.5 units = 1 Opus call.
   */
  premiumConsumedUnits: number
  /** Total bytes pushed upstream for that day. */
  totalBytes: number
}

export interface TraceAgentTypeBucket {
  agentType: string
  count: number
  distinctSessions: number
  avgBodyKb: number
  /** Percent of monthly entitlement (legacy field). */
  premiumConsumed: number
  /** Absolute premium units consumed by this agent_type. */
  premiumConsumedUnits: number
}

export interface TraceModelBucket {
  model: string
  count: number
  subagentCount: number
  totalBytes: number
  /**
   * Per-call multiplier on Copilot's premium quota
   * (0 = free / mini, 1 = baseline / sonnet / gpt-5.4, 7.5 = opus).
   * `null` if we don't know the pricing yet.
   */
  multiplier: number | null
  /** count × multiplier (when multiplier known), undefined otherwise. */
  expectedUnits: number | null
}

export interface TraceRecentEntry {
  ts: string
  sourceRoute: string | null
  upstreamPath: string
  model: string | null
  subagentAgentType: string | null
  subagentAgentId: string | null
  bodySize: number
  status: number | null
  durationMs: number | null
  premiumRemaining: string | null
  copilotEditsSession: string | null
  xInteractionId: string | null
}

/**
 * Derived quota view — everything the /admin UI needs to show
 * "used / total + remaining → N opus calls" without doing arithmetic in JS.
 *
 * All figures reflect the *latest* `x-quota-snapshot-premium_interactions`
 * snapshot we've seen during the query window.
 */
export interface QuotaSnapshot {
  /** Raw `ent=...` from the snapshot; monthly entitlement in premium units. */
  entitled: number | null
  /** Raw `rem=...` from the snapshot; percent of entitlement remaining (0-100). */
  remainingPercent: number | null
  /** `entitled × remainingPercent / 100`. */
  remainingUnits: number | null
  /** `entitled - remainingUnits`. */
  usedUnits: number | null
  /** Used / entitled, 0-100. */
  usedPercent: number | null
  /** ISO timestamp of the snapshot that produced these numbers. */
  snapshotAt: string | null
  /** Raw header string, kept for diagnostics. */
  rawHeader: string | null
  /** Reset date from `rst=...` (ISO), when the monthly quota rolls over. */
  resetAt: string | null
}

export interface TraceStats {
  generatedAt: string
  windowDays: number
  totalRequests: number
  totalSubagent: number
  subagentRatio: number
  /** Percent drop across the window (legacy units). */
  totalPremiumConsumed: number
  /** Percent drop for today only (legacy units). */
  todayPremiumConsumed: number
  /** Absolute premium units consumed across the window. */
  totalPremiumConsumedUnits: number
  /** Absolute premium units consumed today. */
  todayPremiumConsumedUnits: number
  /** Latest premium_interactions snapshot we've seen (raw). */
  latestPremiumRemaining: string | null
  /** Parsed view of the latest snapshot (entitled / remaining / used). */
  quota: QuotaSnapshot
  byDay: Array<TraceDayBucket>
  byAgentType: Array<TraceAgentTypeBucket>
  byModel: Array<TraceModelBucket>
  recent: Array<TraceRecentEntry>
}

const PREMIUM_HEADER_KEY = "x-quota-snapshot-premium_interactions"

const parsePremiumRemaining = (raw: string | undefined): number | null => {
  if (!raw) return null
  const match = /rem=([\d.]+)/.exec(raw)
  if (!match) return null
  const v = Number.parseFloat(match[1])
  return Number.isFinite(v) ? v : null
}

/** Parses `ent=...` (monthly entitlement in premium units). */
const parsePremiumEntitled = (raw: string | undefined): number | null => {
  if (!raw) return null
  const match = /ent=([\d.]+)/.exec(raw)
  if (!match) return null
  const v = Number.parseFloat(match[1])
  return Number.isFinite(v) && v > 0 ? v : null
}

/** Parses `rst=...` (ISO timestamp for when this quota rolls over). */
const parsePremiumResetAt = (raw: string | undefined): string | null => {
  if (!raw) return null
  const match = /rst=([^&]+)/.exec(raw)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * Converts a "percent drop" (e.g. 0.5 for 0.5%) into absolute premium units
 * using the account's entitlement. Returns 0 when we don't know `ent` yet.
 */
const percentToUnits = (percent: number, entitled: number | null): number => {
  if (!entitled || percent <= 0) return 0
  return (percent * entitled) / 100
}

const formatLocalDate = (d: Date): string => d.toLocaleDateString("sv-SE")

const buildDateRange = (days: number): Array<string> => {
  const out: Array<string> = []
  const today = new Date()
  for (let i = 0; i < days; i += 1) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    out.push(formatLocalDate(d))
  }
  return out
}

const readJsonlEntries = (date: string): Array<UpstreamTraceEntry> => {
  const file = path.join(LOG_DIR, `upstream-trace-${date}.jsonl`)
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, "utf8")
  const out: Array<UpstreamTraceEntry> = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as UpstreamTraceEntry)
    } catch {
      // ignore malformed line
    }
  }
  return out
}

interface AggState {
  byDay: Map<string, TraceDayBucket>
  byAgentTypeCount: Map<string, number>
  byAgentTypeSessions: Map<string, Set<string>>
  byAgentTypeBytes: Map<string, number>
  byAgentTypePremium: Map<string, number>
  byModelCount: Map<string, number>
  byModelSubagent: Map<string, number>
  byModelBytes: Map<string, number>
  recent: Array<TraceRecentEntry>
  total: number
  totalSubagent: number
  totalPremium: number
  todayPremium: number
  latestPremium: string | null
  latestPremiumTs: string | null
  latestEntitled: number | null
  /**
   * Tracks the most recent premium snapshot in time order across all entries,
   * regardless of session. Drops between consecutive entries are attributed
   * to the newer entry. We use global ordering rather than per-session because
   * Copilot's `copilot-edits-session` header rotates per request and would
   * never produce a valid prev->next pair to diff against.
   */
  prevPremiumGlobal: number | null
}

const newDayBucket = (date: string): TraceDayBucket => ({
  date,
  total: 0,
  subagent: 0,
  mainConversation: 0,
  premiumConsumed: 0,
  premiumConsumedUnits: 0,
  totalBytes: 0,
})

const ensureDayBucket = (state: AggState, date: string): TraceDayBucket => {
  let bucket = state.byDay.get(date)
  if (!bucket) {
    bucket = newDayBucket(date)
    state.byDay.set(date, bucket)
  }
  return bucket
}

const safeBodySize = (entry: UpstreamTraceEntry): number => {
  const raw = entry.body_size
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0
}

const updateAgentTypeMaps = (
  state: AggState,
  entry: UpstreamTraceEntry,
  drop: number,
) => {
  const at = entry.subagent_agent_type
  if (!at) return
  state.byAgentTypeCount.set(at, (state.byAgentTypeCount.get(at) ?? 0) + 1)
  let sessions = state.byAgentTypeSessions.get(at)
  if (!sessions) {
    sessions = new Set<string>()
    state.byAgentTypeSessions.set(at, sessions)
  }
  if (entry.subagent_session_id) sessions.add(entry.subagent_session_id)
  state.byAgentTypeBytes.set(
    at,
    (state.byAgentTypeBytes.get(at) ?? 0) + safeBodySize(entry),
  )
  state.byAgentTypePremium.set(
    at,
    (state.byAgentTypePremium.get(at) ?? 0) + drop,
  )
}

const updateModelMaps = (state: AggState, entry: UpstreamTraceEntry) => {
  if (!entry.model) return
  state.byModelCount.set(
    entry.model,
    (state.byModelCount.get(entry.model) ?? 0) + 1,
  )
  state.byModelBytes.set(
    entry.model,
    (state.byModelBytes.get(entry.model) ?? 0) + safeBodySize(entry),
  )
  if (entry.subagent_marker_present) {
    state.byModelSubagent.set(
      entry.model,
      (state.byModelSubagent.get(entry.model) ?? 0) + 1,
    )
  }
}

const computePremiumDrop = (
  state: AggState,
  entry: UpstreamTraceEntry,
): number => {
  const remRaw = entry.response_headers?.[PREMIUM_HEADER_KEY] ?? null
  const remNum = parsePremiumRemaining(remRaw ?? undefined)
  if (remNum === null) return 0

  // Track latest snapshot string + ts + entitled for display.
  state.latestPremium = remRaw
  state.latestPremiumTs = entry.ts
  const entNum = parsePremiumEntitled(remRaw ?? undefined)
  if (entNum !== null) state.latestEntitled = entNum

  const prev = state.prevPremiumGlobal
  state.prevPremiumGlobal = remNum

  if (prev === null) return 0
  // Positive drop only (skip month resets / non-decreasing snapshots).
  // Cap at 5 to filter month-boundary noise (e.g. 60 -> 1500 reset).
  const drop = prev - remNum
  return drop > 0 && drop < 5 ? drop : 0
}

const handleEntry = (
  state: AggState,
  entry: UpstreamTraceEntry,
  todayKey: string,
) => {
  const dateKey = entry.ts.slice(0, 10)
  const day = ensureDayBucket(state, dateKey)
  day.total += 1
  day.totalBytes += safeBodySize(entry)

  if (entry.subagent_marker_present) {
    day.subagent += 1
    state.totalSubagent += 1
  } else {
    day.mainConversation += 1
  }

  const drop = computePremiumDrop(state, entry)
  if (drop > 0) {
    day.premiumConsumed += drop
    // Convert at-rest: we'll recompute units at finalize time using the
    // *latest* known entitlement, so a snapshot seen later in the window
    // still gives the earlier days the right units. For per-day accuracy
    // we also accumulate units eagerly with the best ent known *right now*.
    day.premiumConsumedUnits += percentToUnits(drop, state.latestEntitled)
    state.totalPremium += drop
    if (dateKey === todayKey) state.todayPremium += drop
  }

  updateAgentTypeMaps(state, entry, drop)
  updateModelMaps(state, entry)

  state.total += 1
}

const pushRecent = (
  state: AggState,
  entry: UpstreamTraceEntry,
  recentLimit: number,
) => {
  const recentEntry: TraceRecentEntry = {
    ts: entry.ts,
    sourceRoute: entry.source_route,
    upstreamPath: entry.upstream_path,
    model: entry.model,
    subagentAgentType: entry.subagent_agent_type,
    subagentAgentId: entry.subagent_agent_id,
    bodySize: safeBodySize(entry),
    status: entry.status,
    durationMs: entry.duration_ms,
    premiumRemaining: entry.response_headers?.[PREMIUM_HEADER_KEY] ?? null,
    copilotEditsSession:
      entry.response_headers?.["copilot-edits-session"] ?? null,
    xInteractionId: entry.x_interaction_id,
  }
  state.recent.push(recentEntry)
  // keep newest at end; trim from the front when oversized
  if (state.recent.length > recentLimit) {
    state.recent.splice(0, state.recent.length - recentLimit)
  }
}

const finalizeAgentTypes = (state: AggState): Array<TraceAgentTypeBucket> => {
  const out: Array<TraceAgentTypeBucket> = []
  for (const [at, count] of state.byAgentTypeCount.entries()) {
    const bytes = state.byAgentTypeBytes.get(at) ?? 0
    const premium = state.byAgentTypePremium.get(at) ?? 0
    out.push({
      agentType: at,
      count,
      distinctSessions: state.byAgentTypeSessions.get(at)?.size ?? 0,
      avgBodyKb: count > 0 ? bytes / count / 1024 : 0,
      premiumConsumed: premium,
      premiumConsumedUnits: percentToUnits(premium, state.latestEntitled),
    })
  }
  return out.sort((a, b) => b.premiumConsumed - a.premiumConsumed)
}

const finalizeModels = (state: AggState): Array<TraceModelBucket> => {
  const out: Array<TraceModelBucket> = []
  for (const [m, count] of state.byModelCount.entries()) {
    const multiplier = getModelMultiplier(m)
    out.push({
      model: m,
      count,
      subagentCount: state.byModelSubagent.get(m) ?? 0,
      totalBytes: state.byModelBytes.get(m) ?? 0,
      multiplier,
      expectedUnits: multiplier === null ? null : count * multiplier,
    })
  }
  return out.sort((a, b) => {
    // Rank by expected units first (known cost), fall back to raw count.
    const au = a.expectedUnits ?? -1
    const bu = b.expectedUnits ?? -1
    if (au !== bu) return bu - au
    return b.count - a.count
  })
}

const buildQuotaSnapshot = (state: AggState): QuotaSnapshot => {
  const raw = state.latestPremium
  const entitled = state.latestEntitled
  const remainingPercent = parsePremiumRemaining(raw ?? undefined)
  const resetAt = parsePremiumResetAt(raw ?? undefined)
  const remainingUnits =
    entitled !== null && remainingPercent !== null ?
      (entitled * remainingPercent) / 100
    : null
  const usedUnits =
    entitled !== null && remainingUnits !== null ?
      entitled - remainingUnits
    : null
  const usedPercent = remainingPercent !== null ? 100 - remainingPercent : null

  return {
    entitled,
    remainingPercent,
    remainingUnits,
    usedUnits,
    usedPercent,
    snapshotAt: state.latestPremiumTs,
    rawHeader: raw,
    resetAt,
  }
}

interface ReadTraceStatsOptions {
  days?: number
  recentLimit?: number
}

export const readTraceStats = (
  options: ReadTraceStatsOptions = {},
): TraceStats => {
  const days = Math.max(1, Math.min(31, options.days ?? 7))
  const recentLimit = Math.max(10, Math.min(500, options.recentLimit ?? 50))
  const dates = buildDateRange(days)
  const todayKey = formatLocalDate(new Date())

  const state: AggState = {
    byDay: new Map<string, TraceDayBucket>(),
    byAgentTypeCount: new Map<string, number>(),
    byAgentTypeSessions: new Map<string, Set<string>>(),
    byAgentTypeBytes: new Map<string, number>(),
    byAgentTypePremium: new Map<string, number>(),
    byModelCount: new Map<string, number>(),
    byModelSubagent: new Map<string, number>(),
    byModelBytes: new Map<string, number>(),
    recent: [],
    total: 0,
    totalSubagent: 0,
    totalPremium: 0,
    todayPremium: 0,
    latestPremium: null,
    latestPremiumTs: null,
    latestEntitled: null,
    prevPremiumGlobal: null,
  }

  // Pre-create empty day buckets so the chart is dense even on quiet days.
  for (const date of dates) ensureDayBucket(state, date)

  // Read oldest -> newest so premium-drop math respects time order.
  const sortedDates = [...dates].sort()
  for (const date of sortedDates) {
    const entries = readJsonlEntries(date)
    for (const entry of entries) {
      handleEntry(state, entry, todayKey)
      pushRecent(state, entry, recentLimit)
    }
  }

  // recent should be newest-first for the UI
  state.recent.reverse()

  const byDay = [...state.byDay.values()].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  )

  // Ensure day-level units use the *final* known entitlement. If we only
  // learned `ent` late in the window, earlier days may have zero units even
  // though they had percent drops — recompute here so the chart is coherent.
  if (state.latestEntitled !== null) {
    for (const d of byDay) {
      d.premiumConsumedUnits = percentToUnits(
        d.premiumConsumed,
        state.latestEntitled,
      )
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totalRequests: state.total,
    totalSubagent: state.totalSubagent,
    subagentRatio: state.total > 0 ? state.totalSubagent / state.total : 0,
    totalPremiumConsumed: state.totalPremium,
    todayPremiumConsumed: state.todayPremium,
    totalPremiumConsumedUnits: percentToUnits(
      state.totalPremium,
      state.latestEntitled,
    ),
    todayPremiumConsumedUnits: percentToUnits(
      state.todayPremium,
      state.latestEntitled,
    ),
    latestPremiumRemaining: state.latestPremium,
    quota: buildQuotaSnapshot(state),
    byDay,
    byAgentType: finalizeAgentTypes(state),
    byModel: finalizeModels(state),
    recent: state.recent,
  }
}
