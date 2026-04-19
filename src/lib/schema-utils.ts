/**
 * Recursively normalize a JSON Schema object so that every node with
 * `type: "array"` has an `items` field. Several API upstreams (Anthropic,
 * OpenAI) reject schemas that declare array properties without `items`.
 */
export function normalizeJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema }

  if (result.type === "array" && result.items === undefined) {
    result.items = {}
  }

  if (result.properties && typeof result.properties === "object") {
    const props = result.properties as Record<string, unknown>
    const fixedProps: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(props)) {
      fixedProps[key] =
        val && typeof val === "object" ?
          normalizeJsonSchema(val as Record<string, unknown>)
        : val
    }
    result.properties = fixedProps
  }

  if (result.items && typeof result.items === "object") {
    result.items = normalizeJsonSchema(result.items as Record<string, unknown>)
  }

  if (
    result.additionalProperties
    && typeof result.additionalProperties === "object"
  ) {
    result.additionalProperties = normalizeJsonSchema(
      result.additionalProperties as Record<string, unknown>,
    )
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Array<unknown>).map((entry) =>
        entry && typeof entry === "object" ?
          normalizeJsonSchema(entry as Record<string, unknown>)
        : entry,
      )
    }
  }

  return result
}
