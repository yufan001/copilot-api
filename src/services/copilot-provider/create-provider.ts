import type { FetchFunction } from "@ai-sdk/provider-utils"

import consola from "consola"

import type { SubagentMarker } from "~/routes/messages/subagent-marker"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareSubagentHeaders,
} from "~/lib/api-config"
import { ContextOverflowError, isContextOverflow } from "~/lib/copilot-error"
import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { HTTPError } from "~/lib/error"
import {
  extractInterestingHeaders,
  recordUpstream,
  type UpstreamTraceEntry,
} from "~/lib/request-trace"
import { state } from "~/lib/state"

/**
 * Create a custom fetch that handles Copilot token refresh on 401/403.
 * When the initial request fails with 401/403, it clears the token,
 * gets a fresh one, and retries with the updated Authorization header.
 */
function createCopilotFetch(): FetchFunction {
  const RETRYABLE_STATUSES = new Set([401, 403])

  const copilotFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    await copilotTokenManager.getToken()

    const response = await globalThis.fetch(input, init)

    if (RETRYABLE_STATUSES.has(response.status)) {
      copilotTokenManager.clear()
      await copilotTokenManager.getToken()

      // Replace Authorization header with new token
      const currentHeaders = new Headers(init?.headers)
      currentHeaders.set("Authorization", `Bearer ${state.copilotToken}`)
      return globalThis.fetch(input, {
        ...init,
        headers: Object.fromEntries(currentHeaders.entries()),
      })
    }

    return response
  }

  return copilotFetch as FetchFunction
}

// ─── Low-level request function ──────────────────────────────────────────────

export interface CopilotRequestOptions {
  /** API path, e.g. "/chat/completions", "/responses", "/v1/messages" */
  path: string
  /** Request body (will be JSON.stringify'd). Omit for GET requests. */
  body?: unknown
  /** HTTP method, defaults to "POST" */
  method?: "GET" | "POST"
  /** Enable vision headers */
  vision?: boolean
  /** Request initiator: "agent" or "user" */
  initiator?: "agent" | "user"
  /** Subagent marker for conversation-subagent headers */
  subagentMarker?: SubagentMarker | null
  /** Session ID for x-interaction-id header */
  sessionId?: string
  /** Additional headers to merge (e.g. anthropic-beta) */
  extraHeaders?: Record<string, string>
  /** Client-facing route that triggered this upstream call (diagnostic only). */
  sourceRoute?: string
}

/**
 * Applies subagent/interaction/initiator headers to the outbound request.
 *
 * NOTE — `x-interaction-type: conversation-user` is intentionally NOT set
 * here, even though Copilot CLI sets it. CLI's PremiumRequestProcessor
 * only stamps it on the *first* request of a fresh user turn (it tracks
 * processed user messages in a client-side state machine). A stateless
 * proxy like ours can't reproduce that — every request sees the full
 * `messages[]` and Claude Code's tool-use loop sends `tool_result` as
 * role=user, which would cause us to stamp `conversation-user` on every
 * tool round. Empirically this caused Copilot to bill ~0.5 premium per
 * tool round (2.5 premium in 6 minutes on 2026-04-23). See trace
 * upstream-trace-2026-04-23.jsonl 02:11:35 → 02:16:29 for evidence.
 *
 * Until we have a reliable per-session "unprocessed user message"
 * tracker, leave `x-interaction-type` unset on main-conversation calls
 * (Copilot's default `Openai-Intent: conversation-agent` applies).
 * Subagent requests still get `conversation-subagent` via
 * `prepareSubagentHeaders` — that's safe because the marker correctly
 * identifies the spawn boundary.
 */
const applyInteractionHeaders = (
  headers: Record<string, string>,
  options: CopilotRequestOptions,
): void => {
  prepareSubagentHeaders(
    options.sessionId,
    options.subagentMarker ?? null,
    headers,
  )

  // When a SubagentMarker is present, prepareSubagentHeaders has already set
  // x-initiator: agent. We must NOT let the message-role-inferred initiator
  // (computed from the last user message in the Anthropic payload) overwrite
  // it back to "user" — the combination
  //   x-interaction-type: conversation-subagent + x-initiator: user
  // is exactly what causes Copilot to bill ~0.5 premium per subagent round
  // (same root cause as the main-conversation conversation-user issue
  // documented above, just on the subagent path).
  // Subagent tool calls are by definition not user-initiated, so force agent.
  if (options.initiator && !options.subagentMarker) {
    headers["x-initiator"] = options.initiator
  }

  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }
}

/**
 * Low-level Copilot API request function.
 *
 * Combines the provider's auth/retry infrastructure with the project's
 * existing header construction. Returns a raw Response object that can
 * be consumed directly via `events(response)` for SSE or `.json()` for
 * non-streaming.
 *
 * This replaces `fetchCopilotWithRetry()` as the single entry point
 * for all Copilot API calls.
 */
export async function copilotRequest(
  options: CopilotRequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...copilotHeaders(state, options.vision),
  }

  applyInteractionHeaders(headers, options)

  const copilotFetch = createCopilotFetch()
  const url = `${copilotBaseUrl(state)}${options.path}`
  const method = options.method ?? "POST"

  const taskIdHead = headers["x-agent-task-id"]
  const taskIdPreview = taskIdHead ? taskIdHead.slice(0, 8) : "none"
  consola.debug(
    `[copilotRequest] ${method} ${options.path} | x-initiator=${headers["x-initiator"] ?? "none"} | x-interaction-type=${headers["x-interaction-type"] ?? "none"} | x-agent-task-id=${taskIdPreview}`,
  )

  const baseEntry = buildTraceBase(method, headers, options)
  const startedAt = Date.now()

  let response: Response
  try {
    response = await copilotFetch(url, {
      method,
      headers,
      ...(options.body !== undefined && {
        body: JSON.stringify(options.body),
      }),
    })
  } catch (err) {
    recordUpstream({
      ...baseEntry,
      duration_ms: Date.now() - startedAt,
      status: null,
      response_headers: null,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  recordUpstream({
    ...baseEntry,
    duration_ms: Date.now() - startedAt,
    status: response.status,
    response_headers: extractInterestingHeaders(response.headers),
    error: response.ok ? null : `HTTP ${response.status}`,
  })

  if (!response.ok) {
    const errorText = await response
      .clone()
      .text()
      .catch(() => "")
    if (isContextOverflow(errorText)) {
      throw new ContextOverflowError(errorText, response.status, errorText)
    }
    consola.error(`Failed to request ${options.path}`, response)
    throw new HTTPError(`Failed to request ${options.path}`, response)
  }

  return response
}

const extractModel = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null
  const model = (body as { model?: unknown }).model
  return typeof model === "string" ? model : null
}

type TraceBase = Omit<
  UpstreamTraceEntry,
  "duration_ms" | "status" | "response_headers" | "error"
>

const buildTraceBase = (
  method: string,
  headers: Record<string, string>,
  options: CopilotRequestOptions,
): TraceBase => {
  const bodyJson =
    options.body === undefined ? "" : JSON.stringify(options.body)

  return {
    ts: new Date().toISOString(),
    source_route: options.sourceRoute ?? null,
    upstream_path: options.path,
    method,
    model: extractModel(options.body),
    x_request_id: headers["x-request-id"] ?? null,
    x_interaction_id: headers["x-interaction-id"] ?? null,
    x_initiator: headers["x-initiator"] ?? null,
    x_interaction_type: headers["x-interaction-type"] ?? null,
    x_agent_task_id: headers["x-agent-task-id"] ?? null,
    has_vision: Boolean(options.vision),
    anthropic_beta: headers["anthropic-beta"] ?? null,
    subagent_marker_present: Boolean(options.subagentMarker),
    subagent_agent_id: options.subagentMarker?.agent_id ?? null,
    subagent_agent_type: options.subagentMarker?.agent_type ?? null,
    subagent_session_id: options.subagentMarker?.session_id ?? null,
    marker_in_body: bodyJson.includes("__SUBAGENT_MARKER__"),
    body_size: bodyJson.length,
  }
}
