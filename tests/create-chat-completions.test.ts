import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { copilotTokenManager } from "../src/lib/copilot-token-manager"
import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const tokenManager = copilotTokenManager as unknown as {
  tokenExpiresAt: number
}
tokenManager.tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      status: 200,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      // copilotRequest records upstream response headers via
      // `extractInterestingHeaders(response.headers)` which calls `.entries()`,
      // so we expose a real Headers instance (the echoed request headers are
      // good enough for these assertions).
      headers: new Headers(opts.headers),
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("sets x-initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("agent")
  // We never stamp `conversation-user` from the proxy layer
  // (would over-bill on tool-use loops). See create-provider.ts notes.
  expect(headers["x-interaction-type"]).toBeUndefined()
})

test("sets x-initiator to user when only user messages present (no conversation-user stamp)", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("user")
  // Stateless proxy cannot safely stamp `conversation-user`
  // (Copilot CLI's PremiumRequestProcessor needs client-side state).
  expect(headers["x-interaction-type"]).toBeUndefined()
})

test("subagent call stamps x-agent-task-id, x-interaction-id, and conversation-subagent", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "subagent body" }],
    model: "gpt-test",
  }
  await createChatCompletions(payload, {
    subagentMarker: {
      session_id: "sess-abc-123",
      agent_id: "agent-task-xyz-789",
      agent_type: "Explore",
    },
    sessionId: "sess-abc-123",
  })
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[2][1] as { headers: Record<string, string> }
  ).headers

  // Subagent headers from Copilot CLI's buildContextHeaders:
  expect(headers["x-interaction-type"]).toBe("conversation-subagent")
  expect(headers["x-agent-task-id"]).toBe("agent-task-xyz-789")
  expect(headers["x-interaction-id"]).toBe("sess-abc-123")
  // Subagent must NOT get the conversation-user flag even if last message role=user:
  expect(headers["x-interaction-type"]).not.toBe("conversation-user")
})

test("subagent call keeps x-initiator=agent even when caller passes initiator=user (regression)", async () => {
  // Reproduces the bug where applyInteractionHeaders unconditionally
  // overwrote prepareSubagentHeaders' "agent" stamp with the message-role
  // -inferred initiator. For superpowers:code-reviewer style subagents the
  // inferred value is "user" on every round, which combined with
  // x-interaction-type: conversation-subagent caused Copilot to bill ~0.5
  // premium per round.
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "subagent prompt only" }],
    model: "gpt-test",
  }
  await createChatCompletions(payload, {
    initiator: "user",
    subagentMarker: {
      session_id: "sess-cr-1",
      agent_id: "agent-cr-1",
      agent_type: "superpowers:code-reviewer",
    },
    sessionId: "sess-cr-1",
  })
  expect(fetchMock).toHaveBeenCalled()
  const lastCallA = fetchMock.mock.calls.at(-1)
  if (!lastCallA) throw new Error("expected at least one fetch call")
  const headers = (lastCallA[1] as { headers: Record<string, string> }).headers

  expect(headers["x-initiator"]).toBe("agent")
  expect(headers["x-interaction-type"]).toBe("conversation-subagent")
  expect(headers["x-agent-task-id"]).toBe("agent-cr-1")
})

test("non-subagent call still honors caller-provided initiator=user", async () => {
  // Guards the inverse direction: we only suppress the override when a
  // subagentMarker is present. Main-conversation routing must keep working.
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "plain user turn" }],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { initiator: "user" })
  const lastCallB = fetchMock.mock.calls.at(-1)
  if (!lastCallB) throw new Error("expected at least one fetch call")
  const headers = (lastCallB[1] as { headers: Record<string, string> }).headers

  expect(headers["x-initiator"]).toBe("user")
  expect(headers["x-interaction-type"]).toBeUndefined()
  expect(headers["x-agent-task-id"]).toBeUndefined()
})
