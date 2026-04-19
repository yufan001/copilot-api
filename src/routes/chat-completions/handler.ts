import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { getMappedModel, resolveAutoModel } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug(`[Request] model: ${payload.model}`)
  logger.debug("Request payload:", JSON.stringify(payload).slice(-400))

  const requestedModel = payload.model
  payload.model = getMappedModel(payload.model)

  const autoInModels = state.models?.data.some((m) => m.id === "auto")
  if (payload.model === "auto") {
    if (autoInModels) {
      consola.info("[Auto] Native → upstream will choose the model")
    } else {
      payload.model = resolveAutoModel(state.models?.data)
      consola.info(`[Auto] Resolved to: ${payload.model}`)
    }
  } else if (requestedModel !== payload.model) {
    consola.info(`[Model] Mapped: ${requestedModel} → ${payload.model}`)
  }

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const validationError = getChatCompletionsModelValidationError(
    payload.model,
    selectedModel,
  )

  if (validationError) {
    return c.json({ error: validationError }, 400)
  }

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      logger.info("Current token count:", tokenCount)
    } else {
      logger.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    logger.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const isAutoRequest = payload.model === "auto"
  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    response.created = getEpochSec()
    if (isAutoRequest)
      consola.info(`[Auto] Backend selected: ${response.model}`)
    logger.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let autoModelLogged = false
    for await (const chunk of response) {
      if (chunk.data) {
        try {
          const parsed = JSON.parse(chunk.data) as Record<string, unknown>
          parsed.created = getEpochSec()
          if (
            isAutoRequest
            && !autoModelLogged
            && typeof parsed.model === "string"
          ) {
            consola.info(`[Auto] Backend selected: ${parsed.model}`)
            autoModelLogged = true
          }
          chunk.data = JSON.stringify(parsed)
        } catch {
          // Keep original data if not valid JSON (e.g. "[DONE]")
        }
      }
      logger.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const getEpochSec = () => Math.round(Date.now() / 1000)

const getChatCompletionsModelValidationError = (
  modelId: string,
  selectedModel: Model | undefined,
): {
  code: string
  message: string
  type: "invalid_request_error"
} | null => {
  if (!state.models?.data) {
    return null
  }

  // "auto" is a native backend model — skip local validation
  if (modelId === "auto") {
    return null
  }

  if (!selectedModel) {
    return {
      message: `Model '${modelId}' is not available for this account. Check /v1/models or update your model mapping.`,
      type: "invalid_request_error",
      code: "model_not_found",
    }
  }

  if (
    Array.isArray(selectedModel.supported_endpoints)
    && !selectedModel.supported_endpoints.includes(CHAT_COMPLETIONS_ENDPOINT)
  ) {
    const canUseResponses =
      selectedModel.supported_endpoints.includes("/responses")

    return {
      message:
        canUseResponses ?
          "This model does not support the chat completions endpoint. Please choose a different model or use /v1/responses."
        : "This model does not support the chat completions endpoint. Please choose a different model.",
      type: "invalid_request_error",
      code: "model_not_supported",
    }
  }

  return null
}
