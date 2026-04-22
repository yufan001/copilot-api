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

  // prepareSubagentHeaders sets x-initiator: agent when subagentMarker is set.
  // options.initiator is applied AFTER so it can override that value
  // (e.g. forcing "user" for models that reject x-initiator: agent).
  prepareSubagentHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )

  if (options.initiator) {
    headers["x-initiator"] = options.initiator
  }

  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }

  const copilotFetch = createCopilotFetch()
  const url = `${copilotBaseUrl(state)}${options.path}`
  const method = options.method ?? "POST"

  consola.debug(
    `[copilotRequest] ${method} ${options.path} | x-initiator=${headers["x-initiator"] ?? "none"} | x-interaction-type=${headers["x-interaction-type"] ?? "none"}`,
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
