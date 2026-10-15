import { describe, expect, test } from "vitest";

import { sanitizeToolInputSchema } from "@/core/mcp";

function sanitized(schema: unknown) {
  const result = sanitizeToolInputSchema(schema);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.schema;
}

describe("sanitizeToolInputSchema", () => {
  test("leaves a valid schema exactly as it was, every keyword included", () => {
    const schema = {
      additionalProperties: true,
      properties: {
        count: { default: 1, maximum: 10, minimum: 1, type: "integer" },
        email: { format: "email", pattern: "^.+@.+$", title: "Email", type: "string" }
      },
      required: ["email"],
      type: "object"
    };
    expect(sanitized(schema)).toEqual(schema);
  });

  test("gives a missing root an empty object schema, and a root without properties an empty map", () => {
    expect(sanitized(undefined)).toEqual({ properties: {}, type: "object" });
    expect(sanitized({ type: "object" })).toEqual({ properties: {}, type: "object" });
  });

  test("refuses a root that cannot describe arguments", () => {
    expect(sanitizeToolInputSchema({ type: "string" })).toEqual({
      ok: false,
      reason: 'the input schema\'s type is "string"; tool arguments must be an object'
    });
  });

  test("turns boolean schemas into strings and const into a one-value enum", () => {
    expect(
      sanitized({
        properties: { anything: true, mode: { const: "fast" }, nothing: false },
        type: "object"
      }).properties
    ).toEqual({
      anything: { type: "string" },
      mode: { enum: ["fast"], type: "string" },
      nothing: { type: "string" }
    });
  });

  test("drops unknown types and infers missing ones from the keywords present", () => {
    expect(
      sanitized({
        properties: {
          count: { minimum: 0 },
          flags: { enum: [true, false] },
          list: { items: { type: "string" } },
          mixed: { enum: ["a", 1] },
          nested: { properties: { inner: { maxLength: 4 } } },
          weird: { type: "datetime" }
        },
        type: "object"
      }).properties
    ).toEqual({
      count: { minimum: 0, type: "number" },
      flags: { enum: [true, false], type: "boolean" },
      list: { items: { type: "string" }, type: "array" },
      mixed: { enum: ["a", 1] },
      nested: { properties: { inner: { maxLength: 4, type: "string" } }, type: "object" },
      weird: {}
    });
  });

  test("does not guess a type where a reference or a composition decides it", () => {
    expect(
      sanitized({
        $defs: { thing: { type: "string" } },
        properties: { choice: { anyOf: [{ type: "string" }, { type: "number" }] }, ref: { $ref: "#/$defs/thing" } },
        type: "object"
      }).properties
    ).toEqual({ choice: { anyOf: [{ type: "string" }, { type: "number" }] }, ref: { $ref: "#/$defs/thing" } });
  });

  test("keeps the definitions something references, following references between them", () => {
    const schema = sanitized({
      $defs: {
        address: { properties: { city: { $ref: "#/$defs/city" } }, type: "object" },
        city: { type: "string" },
        unused: { type: "number" }
      },
      definitions: { alsoUnused: { type: "string" } },
      properties: { home: { $ref: "#/$defs/address" } },
      type: "object"
    });
    expect(Object.keys(schema.$defs as object)).toEqual(["address", "city"]);
    expect(schema.definitions).toBeUndefined();
  });

  test("drops malformed definition tables and composition lists", () => {
    const schema = sanitized({ $defs: "nope", allOf: "nope", properties: {}, type: "object" });
    expect(schema).toEqual({ properties: {}, type: "object" });
  });
});
