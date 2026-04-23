#!/usr/bin/env bun
import { readTraceStats } from "../src/lib/request-trace"

const stats = readTraceStats({ days: 7, recentLimit: 10 })

const fmtUnits = (u: number | null | undefined): string => {
  if (u === null || u === undefined) return "n/a"
  if (u >= 100) return u.toFixed(0)
  if (u >= 10) return u.toFixed(1)
  return u.toFixed(2)
}
const fmtPct = (p: number | null | undefined): string =>
  p === null || p === undefined ? "n/a" : `${p.toFixed(2)}%`

console.log("=== TraceStats summary ===")
console.log({
  generatedAt: stats.generatedAt,
  windowDays: stats.windowDays,
  totalRequests: stats.totalRequests,
  totalSubagent: stats.totalSubagent,
  subagentRatio: stats.subagentRatio,
})

const q = stats.quota
console.log("\n=== Quota snapshot (monthly) ===")
if (q.entitled === null) {
  console.log(
    "  no premium header seen yet — make one real upstream call and retry",
  )
} else {
  const usedLine = `${fmtUnits(q.usedUnits)} / ${q.entitled} units  (${fmtPct(q.usedPercent)} used)`
  const remainLine = `${fmtUnits(q.remainingUnits)} units remaining  (${fmtPct(q.remainingPercent)})`
  console.log(`  used:       ${usedLine}`)
  console.log(`  remaining:  ${remainLine}`)
  if (q.remainingUnits !== null) {
    const opus = Math.floor(q.remainingUnits / 7.5)
    const gpt5 = Math.floor(q.remainingUnits / 1)
    console.log(
      `  budget for: ~${gpt5} gpt-5.4 calls  |  ~${opus} opus-4.7 calls`,
    )
  }
  if (q.resetAt) console.log(`  resets:     ${q.resetAt.slice(0, 10)}`)
  if (q.snapshotAt) console.log(`  snapshotAt: ${q.snapshotAt}`)
}

console.log("\n=== Consumed in window ===")
console.log(
  `  window (${stats.windowDays}d): ${fmtUnits(stats.totalPremiumConsumedUnits)} units  (${stats.totalPremiumConsumed.toFixed(2)}% of month)`,
)
console.log(
  `  today:         ${fmtUnits(stats.todayPremiumConsumedUnits)} units  (${stats.todayPremiumConsumed.toFixed(2)}% of month)`,
)

console.log("\n=== byDay ===")
console.log(
  `  ${"date".padEnd(10)}  ${"total".padStart(5)}  ${"suba".padStart(4)}  ${"main".padStart(4)}  ${"units".padStart(6)}  ${"% mo".padStart(5)}  bytes`,
)
for (const d of stats.byDay) {
  console.log(
    `  ${d.date.padEnd(10)}  ${d.total.toString().padStart(5)}  ${d.subagent.toString().padStart(4)}  ${d.mainConversation.toString().padStart(4)}  ${fmtUnits(d.premiumConsumedUnits).padStart(6)}  ${d.premiumConsumed.toFixed(2).padStart(5)}  ${(d.totalBytes / 1024).toFixed(0)}KB`,
  )
}

console.log("\n=== byAgentType (sorted by cost) ===")
console.log(
  `  ${"agent_type".padEnd(28)}  ${"count".padStart(5)}  ${"sess".padStart(4)}  ${"avgKB".padStart(5)}  ${"units".padStart(6)}  ${"% mo".padStart(5)}`,
)
for (const a of stats.byAgentType) {
  console.log(
    `  ${a.agentType.padEnd(28)}  ${a.count.toString().padStart(5)}  ${a.distinctSessions.toString().padStart(4)}  ${a.avgBodyKb.toFixed(1).padStart(5)}  ${fmtUnits(a.premiumConsumedUnits).padStart(6)}  ${a.premiumConsumed.toFixed(2).padStart(5)}`,
  )
}

console.log("\n=== byModel (sorted by est. units) ===")
console.log(
  `  ${"model".padEnd(32)}  ${"rate".padStart(5)}  ${"count".padStart(5)}  ${"suba".padStart(4)}  ${"est.units".padStart(9)}  bytesMB`,
)
for (const m of stats.byModel) {
  let rate: string
  if (m.multiplier === null) rate = " ?  "
  else if (m.multiplier === 0) rate = "FREE"
  else rate = `×${m.multiplier}`
  const expected = m.expectedUnits === null ? "  -" : fmtUnits(m.expectedUnits)
  console.log(
    `  ${m.model.padEnd(32)}  ${rate.padStart(5)}  ${m.count.toString().padStart(5)}  ${m.subagentCount.toString().padStart(4)}  ${expected.padStart(9)}  ${(m.totalBytes / 1024 / 1024).toFixed(2)}`,
  )
}

console.log(`\n=== recent (newest ${stats.recent.length}) ===`)
for (const r of stats.recent) {
  console.log(
    `  ${r.ts}  ${r.sourceRoute ?? "-"}  model=${r.model ?? "-"}  agent_type=${r.subagentAgentType ?? "-"}  body=${(r.bodySize / 1024).toFixed(1)}KB  status=${r.status ?? "err"}`,
  )
}

// logger.ts schedules a setInterval that keeps the process alive; force exit.
process.exit(0)
