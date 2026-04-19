import consola from "consola"

import { normalizeJsonSchema } from "~/lib/schema-utils"

import type { AnthropicMessagesPayload } from "./anthropic-types"

interface AnthropicToolLike {
  type?: unknown
  name?: unknown
  description?: unknown
  input_schema?: unknown
}

const isServerTool = (tool: AnthropicToolLike): boolean =>
  typeof tool.type === "string" && tool.type !== "custom"

const sanitizeAnthropicTool = (
  tool: AnthropicToolLike,
): Record<string, unknown> => {
  if (isServerTool(tool)) {
    return { ...(tool as Record<string, unknown>) }
  }

  const sanitized: Record<string, unknown> = {}

  if (typeof tool.name === "string") {
    sanitized.name = tool.name
  }

  if (typeof tool.description === "string") {
    sanitized.description = tool.description
  }

  if (tool.input_schema && typeof tool.input_schema === "object") {
    sanitized.input_schema = normalizeJsonSchema(
      tool.input_schema as Record<string, unknown>,
    )
  }

  return sanitized
}

export function sanitizeAnthropicPayload(
  payload: AnthropicMessagesPayload,
): void {
  // Remove unsupported fields that Copilot API rejects.
  // biome-ignore lint/performance/noDelete: cleaning up unsupported fields
  delete (payload as unknown as Record<string, unknown>).context_management

  if (!Array.isArray(payload.tools)) {
    return
  }

  // Idempotent: running this twice (handler.ts + create-messages.ts) yields
  // the same payload.
  payload.tools = payload.tools.map((tool) => {
    const next = sanitizeAnthropicTool(tool as AnthropicToolLike)
    if (isServerTool(tool as AnthropicToolLike)) {
      consola.debug(
        `Forwarding Anthropic server-side tool '${(tool as { type?: string }).type}' unchanged; upstream must support it.`,
      )
    }
    return next
  }) as unknown as AnthropicMessagesPayload["tools"]
}

// Drop Anthropic server-side tools from the payload. Only the native
// Anthropic /v1/messages upstream can execute them — when routing through
// Chat Completions or the Responses API, forwarding them would produce a
// function-tool with only a `name` and confuse the backend. Returns the
// removed tools for diagnostics.
export function stripServerToolsForNonMessagesApi(
  payload: AnthropicMessagesPayload,
): void {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return
  }

  const kept: Array<unknown> = []
  const dropped: Array<string> = []
  for (const tool of payload.tools) {
    if (isServerTool(tool as AnthropicToolLike)) {
      dropped.push(String((tool as { type?: unknown }).type))
      continue
    }
    kept.push(tool)
  }

  if (dropped.length > 0) {
    consola.warn(
      `Dropping Anthropic server-side tool(s) [${dropped.join(", ")}] — not supported on this upstream path.`,
    )
  }

  payload.tools = kept as AnthropicMessagesPayload["tools"]
}
