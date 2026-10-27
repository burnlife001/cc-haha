/**
 * Converts Zod v4 schemas to JSON Schema using native toJSONSchema.
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

/**
 * The Anthropic API requires tool input_schema to declare `type: "object"` at
 * the top level. A Zod discriminatedUnion converts to a bare oneOf/anyOf with
 * no type, which the API rejects ("schema must be a JSON Schema of
 * 'type: "object"'"). Hoist type: "object" when every branch is an object;
 * the intersection is semantically identical to the bare union.
 */
function hoistObjectTypeForUnionBranches(schema: JsonSchema7Type): JsonSchema7Type {
  if (schema.type) return schema
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = schema[key]
    if (
      Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every(
        branch =>
          branch !== null &&
          typeof branch === 'object' &&
          (branch as JsonSchema7Type).type === 'object',
      )
    ) {
      return { type: 'object', ...schema }
    }
  }
  return schema
}

// toolToAPISchema() runs this for every tool on every API request (~60-250
// times/turn). Tool schemas are wrapped with lazySchema() which guarantees the
// same ZodTypeAny reference per session, so we can cache by identity.
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

/**
 * Converts a Zod v4 schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const result = hoistObjectTypeForUnionBranches(toJSONSchema(schema) as JsonSchema7Type)
  cache.set(schema, result)
  return result
}
