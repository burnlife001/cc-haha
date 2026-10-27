import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { zodToJsonSchema } from './zodToJsonSchema.js'

describe('zodToJsonSchema', () => {
  it('keeps object schemas unchanged', () => {
    const schema = zodToJsonSchema(z.strictObject({ name: z.string() }))
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
  })

  it('hoists type: object onto a top-level discriminatedUnion of objects', () => {
    const schema = zodToJsonSchema(
      z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('list') }),
        z.strictObject({ action: z.literal('view'), id: z.string() }),
      ]),
    )
    // The Anthropic API rejects tool schemas whose top-level type is missing.
    expect(schema.type).toBe('object')
    expect(Array.isArray(schema.oneOf)).toBe(true)
    expect(schema.oneOf).toHaveLength(2)
  })

  it('hoists type: object onto a top-level z.union of objects', () => {
    const schema = zodToJsonSchema(
      z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.number() })]),
    )
    expect(schema.type).toBe('object')
    expect(Array.isArray(schema.anyOf)).toBe(true)
  })

  it('does not hoist type onto unions with non-object branches', () => {
    const schema = zodToJsonSchema(z.union([z.string(), z.number()]))
    expect(schema.type).toBeUndefined()
    expect(Array.isArray(schema.anyOf)).toBe(true)
  })

  it('caches the converted schema per Zod identity', () => {
    const input = z.strictObject({ name: z.string() })
    expect(zodToJsonSchema(input)).toBe(zodToJsonSchema(input))
  })
})
