import { describe, test, expect } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import {
  sanitizeAnthropicPayload,
  stripServerToolsForNonMessagesApi,
} from "~/routes/messages/sanitize"

const basePayload = (tools: Array<unknown>): AnthropicMessagesPayload =>
  ({
    model: "claude-sonnet-4",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    tools,
  }) as unknown as AnthropicMessagesPayload

describe("sanitizeAnthropicPayload: server-side tools", () => {
  test("preserves web_search_20250305 tool verbatim", () => {
    const payload = basePayload([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
        allowed_domains: ["npmjs.com"],
        blocked_domains: ["spam.com"],
        user_location: { type: "approximate", country: "US" },
      },
    ])

    sanitizeAnthropicPayload(payload)

    expect(payload.tools).toEqual([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
        allowed_domains: ["npmjs.com"],
        blocked_domains: ["spam.com"],
        user_location: { type: "approximate", country: "US" },
      },
    ] as unknown as AnthropicMessagesPayload["tools"])
  })

  test("still strips unknown fields from custom tools", () => {
    const payload = basePayload([
      {
        name: "get_weather",
        description: "Look up the weather",
        input_schema: { type: "object" },
        extra_junk: "should be removed",
      },
    ])

    sanitizeAnthropicPayload(payload)

    expect(payload.tools).toEqual([
      {
        name: "get_weather",
        description: "Look up the weather",
        input_schema: { type: "object" },
      },
    ] as unknown as AnthropicMessagesPayload["tools"])
  })

  test("is idempotent (safe to run twice)", () => {
    const payload = basePayload([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
      },
      {
        name: "get_weather",
        description: "w",
        input_schema: { type: "object" },
      },
    ])

    sanitizeAnthropicPayload(payload)
    const first = JSON.stringify(payload.tools)
    sanitizeAnthropicPayload(payload)
    const second = JSON.stringify(payload.tools)

    expect(second).toBe(first)
  })
})

describe("stripServerToolsForNonMessagesApi", () => {
  test("removes server-side tools, keeps custom tools", () => {
    const payload = basePayload([
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      {
        name: "get_weather",
        description: "w",
        input_schema: { type: "object" },
      },
    ])

    stripServerToolsForNonMessagesApi(payload)

    expect(payload.tools).toHaveLength(1)
    expect((payload.tools as Array<{ name: string }>)[0].name).toBe(
      "get_weather",
    )
  })

  test("no-op when there are no tools", () => {
    const payload = basePayload([])
    stripServerToolsForNonMessagesApi(payload)
    expect(payload.tools).toEqual(
      [] as unknown as AnthropicMessagesPayload["tools"],
    )
  })
})
