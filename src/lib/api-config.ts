import { randomUUID } from "node:crypto"

import type { SubagentMarker } from "~/routes/messages/subagent-marker"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.35.0"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

const API_VERSION = "2025-10-01"

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (state: State, vision: boolean = false) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

/**
 * Writes Copilot CAPI subagent/interaction headers onto the given mutable
 * headers map.
 *
 * Header semantics follow the reverse-engineered Copilot CLI SDK
 * (@github/copilot 1.0.34, `sdk/index.js:buildContextHeaders`):
 *
 * - `x-interaction-id`      — session-level, subagents inherit from parent.
 * - `x-agent-task-id`       — unique per agent *instance*; for our proxy we
 *                              reuse the marker's `agent_id` (assigned by the
 *                              Claude Code `SubagentStart` hook) so multiple
 *                              upstream calls from the same subagent share the
 *                              same task id.
 * - `x-initiator`           — "agent" for subagent calls (the agent, not the
 *                              user, initiated this request). Main-conversation
 *                              `x-initiator` is decided elsewhere by message
 *                              role.
 * - `x-interaction-type`    — "conversation-subagent" for subagents.
 *
 * Parent tracking (`x-parent-agent-id`) is intentionally NOT set here: the
 * `SubagentMarker` injected by Claude Code does not carry a parent id today.
 * We leave it unset rather than guess.
 */
export const prepareSubagentHeaders = (
  sessionId: string | undefined,
  subagentMarker: SubagentMarker | null | undefined,
  headers: Record<string, string>,
): void => {
  if (subagentMarker) {
    headers["x-initiator"] = "agent"
    headers["x-interaction-type"] = "conversation-subagent"
    headers["x-agent-task-id"] = subagentMarker.agent_id
  }

  if (sessionId) {
    headers["x-interaction-id"] = sessionId
  }
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
