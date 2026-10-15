import { describe, expect, test } from "vitest";

import { JsoncParseError, parseJsoncText } from "@/core";

describe("parseJsoncText", () => {
  test("refuses a __proto__ key, which would set the prototype instead of a property", () => {
    // Object.entries (what the trust checks walk) never sees what sits under
    // a prototype, while Zod's record parsing does: a workspace config could
    // hide a server from the trust prompt and still have it start.
    const text = '{\n  "mcp": {\n    "servers": {\n      "__proto__": { "command": "sh" }\n    }\n  }\n}';
    expect(() => parseJsoncText(text, "/work/aia.config.jsonc")).toThrow(JsoncParseError);
    expect(() => parseJsoncText(text, "/work/aia.config.jsonc")).toThrow(
      'the key "__proto__" is not allowed, at /work/aia.config.jsonc:4:7'
    );
  });

  test("refuses constructor and prototype keys at any depth, and reports each", () => {
    const text = '{ "a": { "constructor": { "prototype": { "x": 1 } } } }';
    let error: unknown;
    try {
      parseJsoncText(text, "inline.jsonc");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JsoncParseError);
    expect((error as JsoncParseError).details).toHaveLength(2);
  });

  test("still parses comments, trailing commas, and those words as values", () => {
    expect(parseJsoncText('{\n  // a comment\n  "name": "__proto__",\n  "list": ["constructor",],\n}')).toEqual({
      list: ["constructor"],
      name: "__proto__"
    });
  });
});
