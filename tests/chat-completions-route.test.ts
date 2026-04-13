import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { copilotTokenManager } from "~/lib/copilot-token-manager"
import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalToken = state.copilotToken
const originalVSCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType
const originalRateLimitSeconds = state.rateLimitSeconds
const originalRateLimitWait = state.rateLimitWait
const originalLastRequestTimestamp = state.lastRequestTimestamp
const tokenManager = copilotTokenManager as unknown as {
  tokenExpiresAt: number
}
const originalTokenExpiresAt = tokenManager.tokenExpiresAt

const buildModel = (id: string, supportedEndpoints?: Array<string>): Model => ({
  id,
  name: id,
  object: "model",
  vendor: "OpenAI",
  version: id,
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: supportedEndpoints,
  capabilities: {
    family: id,
    limits: {},
    object: "model_capabilities",
    supports: {
      streaming: true,
      tool_calls: true,
    },
    tokenizer: "o200k_base",
    type: "chat",
  },
})

const createChatRequest = (model: string): Request =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hello" }],
    }),
  })

beforeEach(() => {
  state.models = { data: [], object: "list" } as ModelsResponse
  state.copilotToken = "copilot-token-test"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  tokenManager.tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
})

afterEach(() => {
  state.models = originalModels
  state.copilotToken = originalToken
  state.vsCodeVersion = originalVSCodeVersion
  state.accountType = originalAccountType
  state.rateLimitSeconds = originalRateLimitSeconds
  state.rateLimitWait = originalRateLimitWait
  state.lastRequestTimestamp = originalLastRequestTimestamp
  tokenManager.tokenExpiresAt = originalTokenExpiresAt
  globalThis.fetch = originalFetch
})

describe("/v1/chat/completions route", () => {
  test("rejects models that do not support chat completions before calling upstream", async () => {
    state.models = {
      object: "list",
      data: [buildModel("gpt-5.3-codex", ["/responses", "ws:/responses"])],
    }

    const fetchMock = mock(() =>
      Promise.resolve(new Response("unexpected upstream call")),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.fetch(createChatRequest("gpt-5.3-codex"))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "This model does not support the chat completions endpoint. Please choose a different model or use /v1/responses.",
        type: "invalid_request_error",
        code: "model_not_supported",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("flattens upstream JSON errors instead of nesting them as strings", async () => {
    state.models = {
      object: "list",
      data: [buildModel("gpt-4.1")],
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              message: "The requested model is not supported.",
              code: "model_not_supported",
              param: "model",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        ),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.fetch(createChatRequest("gpt-4.1"))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "The requested model is not supported.",
        type: "invalid_request_error",
        code: "model_not_supported",
        param: "model",
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
