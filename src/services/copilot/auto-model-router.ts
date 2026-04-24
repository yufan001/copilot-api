import consola from "consola"

import { state } from "~/lib/state"
import { copilotRequest } from "~/services/copilot-provider/create-provider"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutoModelSession {
  session_token: string
  available_models: Array<string>
  discounted_costs?: Record<string, number>
}

interface RouterDecision {
  candidate_models: Array<string>
  fallback: boolean
  fallback_reason?: string
  routing_method?: string
}

// ---------------------------------------------------------------------------
// Session cache — keyed by copilot token, avoids redundant /models/session
// calls within the same token lifetime.
// ---------------------------------------------------------------------------

interface SessionCacheEntry {
  copilotToken: string
  session: AutoModelSession
}

let sessionCache: SessionCacheEntry | null = null

async function getAutoModelSession(): Promise<AutoModelSession> {
  const currentToken = state.copilotToken ?? ""

  if (sessionCache && sessionCache.copilotToken === currentToken) {
    return sessionCache.session
  }

  const response = await copilotRequest({
    path: "/models/session",
    method: "POST",
    body: {
      auto_mode: {
        model_hints: ["auto"],
      },
    },
  })

  if (!response.ok) {
    throw new Error(
      `[AutoRouter] POST /models/session failed: ${response.status}`,
    )
  }

  const session = (await response.json()) as AutoModelSession

  if (!session.session_token) {
    throw new Error(
      "[AutoRouter] Invalid session response: missing session_token",
    )
  }

  if (session.available_models.length === 0) {
    throw new Error(
      "[AutoRouter] Invalid session response: available_models is empty",
    )
  }

  const newEntry = { copilotToken: currentToken, session }
  // eslint-disable-next-line require-atomic-updates
  sessionCache = newEntry

  consola.debug(
    `[AutoRouter] Session fetched, available_models=[${session.available_models.join(", ")}]`,
  )

  return session
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask the GitHub Copilot router to pick the best model for the given prompt.
 *
 * Mirrors what VS Code Copilot Chat's AutomodeService does:
 * 1. POST /models/session → session token + available_models
 * 2. POST /models/session/intent → candidate model
 *
 * Returns the selected model id, or `null` if the router signals fallback or
 * an error occurs (callers should use their own fallback in that case).
 */
export async function resolveAutoModelViaRouter(
  prompt: string,
  previousModel?: string,
  turnNumber?: number,
): Promise<string | null> {
  try {
    const session = await getAutoModelSession()

    // Prefer intersection with known model ids, but do not hard-fail when
    // local model cache is empty/out-of-sync. In that case we trust router
    // session's available_models to avoid always falling back.
    const knownIds = new Set(state.models?.data.map((m) => m.id) ?? [])
    const intersectedModels = session.available_models.filter((m) =>
      knownIds.has(m),
    )
    const filteredModels =
      intersectedModels.length > 0 ?
        intersectedModels
      : session.available_models

    if (intersectedModels.length === 0 && knownIds.size > 0) {
      consola.warn(
        "[AutoRouter] Model intersection is empty, using session available_models directly",
      )
    }

    if (filteredModels.length === 0) {
      consola.warn("[AutoRouter] Session has no available_models, falling back")
      return null
    }

    const body: Record<string, unknown> = {
      prompt,
      available_models: filteredModels,
      prompt_char_count: prompt.length,
      turn_number: turnNumber ?? 1,
    }

    if (previousModel) {
      body.previous_model = previousModel
    }

    const response = await copilotRequest({
      path: "/models/session/intent",
      method: "POST",
      body,
      extraHeaders: {
        "Copilot-Session-Token": session.session_token,
      },
    })

    if (!response.ok) {
      consola.warn(
        `[AutoRouter] POST /models/session/intent failed: ${response.status}, falling back`,
      )
      return null
    }

    const decision = (await response.json()) as RouterDecision

    if (decision.fallback || decision.candidate_models.length === 0) {
      consola.info(
        `[AutoRouter] Router signaled fallback: ${decision.fallback_reason ?? "unknown"}`,
      )
      return null
    }

    const selected = decision.candidate_models[0]
    consola.info(`[AutoRouter] Router selected model: ${selected}`)
    return selected
  } catch (err) {
    consola.warn("[AutoRouter] Error during routing, falling back:", err)
    return null
  }
}

/**
 * Invalidate the session cache (e.g. after a token refresh).
 */
export function invalidateAutoModelSessionCache(): void {
  sessionCache = null
}
