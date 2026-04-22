#!/usr/bin/env bun
import { readTraceStats } from "../src/lib/request-trace"

const stats = readTraceStats({ days: 7, recentLimit: 10 })

console.log("=== TraceStats summary ===")
console.log({
  generatedAt: stats.generatedAt,
  windowDays: stats.windowDays,
  totalRequests: stats.totalRequests,
  totalSubagent: stats.totalSubagent,
  subagentRatio: stats.subagentRatio,
  totalPremiumConsumed: stats.totalPremiumConsumed,
  todayPremiumConsumed: stats.todayPremiumConsumed,
  latestPremiumRemaining: stats.latestPremiumRemaining,
})

console.log("\n=== byDay ===")
for (const d of stats.byDay) {
  console.log(
    `${d.date}  total=${d.total.toString().padStart(4)}  subagent=${d.subagent.toString().padStart(3)}  main=${d.mainConversation.toString().padStart(3)}  premium=${d.premiumConsumed.toFixed(2).padStart(5)}  bytes=${(d.totalBytes / 1024).toFixed(0)}KB`,
  )
}

console.log("\n=== byAgentType ===")
for (const a of stats.byAgentType) {
  console.log(
    `${a.agentType.padEnd(28)}  count=${a.count.toString().padStart(3)}  sessions=${a.distinctSessions.toString().padStart(2)}  avgKB=${a.avgBodyKb.toFixed(1).padStart(5)}  premium=${a.premiumConsumed.toFixed(2)}`,
  )
}

console.log("\n=== byModel ===")
for (const m of stats.byModel) {
  console.log(
    `${m.model.padEnd(28)}  count=${m.count.toString().padStart(3)}  subagent=${m.subagentCount.toString().padStart(3)}  bytesMB=${(m.totalBytes / 1024 / 1024).toFixed(2)}`,
  )
}

console.log(`\n=== recent (newest ${stats.recent.length}) ===`)
for (const r of stats.recent) {
  console.log(
    `${r.ts}  ${r.sourceRoute ?? "-"}  model=${r.model ?? "-"}  agent_type=${r.subagentAgentType ?? "-"}  body=${(r.bodySize / 1024).toFixed(1)}KB  status=${r.status ?? "err"}`,
  )
}

// logger.ts schedules a setInterval that keeps the process alive; force exit.
process.exit(0)
