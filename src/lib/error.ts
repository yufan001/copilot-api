import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import { APICallError } from "@ai-sdk/provider"
import consola from "consola"

import { ContextOverflowError, parseAPICallError } from "~/lib/copilot-error"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof ContextOverflowError) {
    return c.json(
      {
        error: {
          message: error.message,
          type: "context_overflow",
          code: "context_length_exceeded",
        },
      },
      error.statusCode as ContentfulStatusCode,
    )
  }

  if (error instanceof APICallError) {
    const parsed = parseAPICallError(error)
    const statusCode = (parsed.statusCode ?? 500) as ContentfulStatusCode
    return c.json(
      {
        error: {
          message: parsed.message,
          type: parsed.type,
          code:
            parsed.type === "context_overflow" ?
              "context_length_exceeded"
            : undefined,
        },
      },
      statusCode,
    )
  }

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    const normalizedError = normalizeHTTPError(errorText)
    consola.error("HTTP error:", normalizedError ?? errorText)
    return c.json(
      {
        error: normalizedError ?? {
          message: errorText || error.message,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

type NormalizedHTTPError = {
  code?: string
  message: string
  param?: string
  type: string
}

function normalizeHTTPError(errorText: string): NormalizedHTTPError | null {
  return extractNormalizedHTTPError(parseJsonSafely(errorText))
}

function extractNormalizedHTTPError(
  value: unknown,
): NormalizedHTTPError | null {
  if (typeof value === "string") {
    return normalizeHTTPErrorString(value)
  }

  if (!isRecord(value)) {
    return null
  }

  return normalizeHTTPErrorObject(value)
}

function normalizeHTTPErrorString(value: string): NormalizedHTTPError | null {
  const message = value.trim()
  if (!message) {
    return null
  }

  const nestedParsed = parseJsonSafely(message)
  if (nestedParsed !== message) {
    const nestedError = extractNormalizedHTTPError(nestedParsed)
    if (nestedError) {
      return nestedError
    }
  }

  return {
    message,
    type: "error",
  }
}

function normalizeHTTPErrorObject(
  value: Record<string, unknown>,
): NormalizedHTTPError | null {
  const container = getErrorContainer(value)
  const messageValue = container.message

  if (typeof messageValue !== "string") {
    return null
  }

  const nestedMessage = normalizeHTTPErrorString(messageValue)
  if (nestedMessage && nestedMessage.message !== messageValue) {
    return mergeHTTPErrorFields(container, nestedMessage)
  }

  return mergeHTTPErrorFields(container, {
    message: messageValue,
    type: "error",
  })
}

function mergeHTTPErrorFields(
  container: Record<string, unknown>,
  normalized: NormalizedHTTPError,
): NormalizedHTTPError {
  return {
    ...normalized,
    type: getStringField(container, "type") ?? normalized.type,
    code: getStringField(container, "code") ?? normalized.code,
    param: getStringField(container, "param") ?? normalized.param,
  }
}

function getErrorContainer(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const errorValue = value.error
  return isRecord(errorValue) ? errorValue : value
}

function getStringField(value: object, key: string): string | null {
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object"
}

function parseJsonSafely(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}
