import type { JsonValue } from "@/core/contracts";

type JsonObject = { [key: string]: JsonValue };

const JSON_SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const COMPOSITION_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
const DEFINITION_KEYWORDS = ["$defs", "definitions"] as const;

export type SanitizedToolSchema = { ok: true; schema: JsonObject } | { ok: false; reason: string };

/**
 * Makes an MCP tool's input schema valid for a model server, changing only
 * what is invalid (Codex's repairs):
 *
 * - a schema that is just `true` or `false` becomes `{ "type": "string" }`;
 * - `const` becomes a one-value `enum`;
 * - an unknown `type` is dropped, and a missing one is inferred from the
 *   keywords present (`properties` means object, `items` array, `minimum`
 *   number, `minLength` string, an `enum` the type of its values);
 * - an object without `properties` gets `{}`;
 * - `$defs`/`definitions` that nothing references are dropped.
 *
 * Every other keyword stays, `additionalProperties` included: unlike Codex,
 * nothing is stripped to fit a size budget, because a local model server
 * turns the schema into a grammar and a keyword dropped here is a constraint
 * lost there. A root that is not an object schema cannot describe tool
 * arguments, so the tool is skipped rather than guessed at.
 */
export function sanitizeToolInputSchema(input: unknown): SanitizedToolSchema {
  const root = isObject(input) ? input : {};
  const cleaned = sanitizeSchema(root);
  if (!isObject(cleaned)) {
    return { ok: false, reason: "the input schema is not an object schema" };
  }
  const rootType = cleaned.type;
  if (rootType === undefined) {
    cleaned.type = "object";
  } else if (rootType !== "object") {
    return {
      ok: false,
      reason: `the input schema's type is ${JSON.stringify(rootType)}; tool arguments must be an object`
    };
  }
  if (!isObject(cleaned.properties)) {
    cleaned.properties = {};
  }
  return { ok: true, schema: dropUnreferencedDefinitions(cleaned) };
}

function sanitizeSchema(value: JsonValue): JsonValue {
  if (typeof value === "boolean") {
    return { type: "string" };
  }
  if (!isObject(value)) {
    return value;
  }

  const schema: JsonObject = { ...value };

  if ("const" in schema) {
    const constant = schema.const as JsonValue;
    delete schema.const;
    if (!Array.isArray(schema.enum)) {
      schema.enum = [constant];
    }
  }

  if (typeof schema.type === "string" && !JSON_SCHEMA_TYPES.has(schema.type)) {
    delete schema.type;
  } else if (Array.isArray(schema.type)) {
    const known = schema.type.filter((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry));
    if (known.length === 0) {
      delete schema.type;
    } else {
      schema.type = known;
    }
  }
  if (schema.type === undefined && !("$ref" in schema) && !COMPOSITION_KEYWORDS.some((key) => key in schema)) {
    const inferred = inferType(schema);
    if (inferred) {
      schema.type = inferred;
    }
  }
  if (schema.type === "object" && !isObject(schema.properties)) {
    schema.properties = {};
  }

  if (isObject(schema.properties)) {
    schema.properties = mapValues(schema.properties, sanitizeSchema);
  }
  if (isObject(schema.patternProperties)) {
    schema.patternProperties = mapValues(schema.patternProperties, sanitizeSchema);
  }
  if (isObject(schema.additionalProperties)) {
    schema.additionalProperties = sanitizeSchema(schema.additionalProperties);
  }
  if (Array.isArray(schema.items)) {
    schema.items = schema.items.map(sanitizeSchema);
  } else if (schema.items !== undefined) {
    schema.items = sanitizeSchema(schema.items);
  }
  if (Array.isArray(schema.prefixItems)) {
    schema.prefixItems = schema.prefixItems.map(sanitizeSchema);
  }
  if (schema.not !== undefined && typeof schema.not !== "boolean") {
    schema.not = sanitizeSchema(schema.not);
  }
  for (const key of COMPOSITION_KEYWORDS) {
    const entries = schema[key];
    if (Array.isArray(entries)) {
      schema[key] = entries.map(sanitizeSchema);
    } else if (entries !== undefined) {
      delete schema[key];
    }
  }
  for (const key of DEFINITION_KEYWORDS) {
    const definitions = schema[key];
    if (isObject(definitions)) {
      schema[key] = mapValues(definitions, sanitizeSchema);
    } else if (definitions !== undefined) {
      delete schema[key];
    }
  }
  return schema;
}

function inferType(schema: JsonObject): string | undefined {
  if (["properties", "required", "additionalProperties", "patternProperties"].some((key) => key in schema)) {
    return "object";
  }
  if (["items", "prefixItems", "minItems", "maxItems", "uniqueItems"].some((key) => key in schema)) {
    return "array";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = new Set(schema.enum.map((entry) => (entry === null ? "null" : typeof entry)));
    if (types.size === 1) {
      const [only] = types;
      return only === "string" || only === "boolean" || only === "number" || only === "null" ? only : undefined;
    }
    return undefined;
  }
  if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in schema)) {
    return "number";
  }
  if (["minLength", "maxLength", "pattern", "format"].some((key) => key in schema)) {
    return "string";
  }
  return undefined;
}

// Keeps the definitions some `$ref` reaches, following references inside the
// definitions themselves.
function dropUnreferencedDefinitions(root: JsonObject): JsonObject {
  const present = DEFINITION_KEYWORDS.filter((key) => isObject(root[key]));
  if (present.length === 0) {
    return root;
  }
  const reachable = new Set<string>();
  const pending: JsonValue[] = [withoutDefinitions(root)];
  while (pending.length > 0) {
    for (const ref of collectRefs(pending.pop()!)) {
      const match = /^#\/(\$defs|definitions)\/([^/]+)/u.exec(ref);
      if (!match) {
        continue;
      }
      const key = `${match[1]}/${decodePointer(match[2]!)}`;
      if (reachable.has(key)) {
        continue;
      }
      reachable.add(key);
      const definitions = root[match[1] as (typeof DEFINITION_KEYWORDS)[number]];
      const target = isObject(definitions) ? definitions[decodePointer(match[2]!)] : undefined;
      if (target !== undefined) {
        pending.push(target);
      }
    }
  }
  const result: JsonObject = { ...root };
  for (const keyword of present) {
    const kept = Object.fromEntries(
      Object.entries(root[keyword] as JsonObject).filter(([name]) => reachable.has(`${keyword}/${name}`))
    );
    if (Object.keys(kept).length > 0) {
      result[keyword] = kept;
    } else {
      delete result[keyword];
    }
  }
  return result;
}

function withoutDefinitions(schema: JsonObject): JsonObject {
  const copy: JsonObject = { ...schema };
  for (const key of DEFINITION_KEYWORDS) {
    delete copy[key];
  }
  return copy;
}

function collectRefs(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectRefs);
  }
  if (!isObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "$ref" && typeof entry === "string" ? [entry] : collectRefs(entry)
  );
}

function decodePointer(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape ("%E0%A4%A"): taken as written, so the reference
    // names nothing and is dropped, instead of the URIError failing the tool
    // and, with it, the whole server.
  }
  return decoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function mapValues(record: JsonObject, map: (value: JsonValue) => JsonValue): JsonObject {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
