import { z } from "zod";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// Zod keeps an optional key that was handed an explicit `undefined` (for
// example `{ lastConnectedAt: status.lastConnectedAt }` where the status has
// no such field), and a record of JsonValue has no branch that accepts one.
// Rejecting the whole payload over it is the wrong trade: JSON.stringify drops
// those keys silently a moment later, so the same object parses fine once it
// has been through disk and only ever fails for in-memory consumers. Drop them
// here instead, and keep every other value untouched.
function stripUndefinedEntries(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).includes(undefined)
  ) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    // The cast re-narrows the input type that z.preprocess widens to unknown;
    // the parsed output is still a Record<string, JsonValue>.
    z.preprocess(stripUndefinedEntries, z.record(z.string(), jsonValueSchema)) as unknown as z.ZodType<
      Record<string, JsonValue>
    >
  ])
);

// Canonical JSON object schema. Everything that stores a free-form object
// (metadata, tool results, JSON Schema documents) goes through this so the
// undefined-key tolerance above applies at the top level too, not only to
// nested objects reached through jsonValueSchema.
export const jsonRecordSchema: z.ZodType<Record<string, JsonValue>> = z.preprocess(
  stripUndefinedEntries,
  z.record(z.string(), jsonValueSchema)
) as unknown as z.ZodType<Record<string, JsonValue>>;

// Normalizes an arbitrary runtime value into something jsonValueSchema will
// accept, with the same semantics JSON.stringify applies on the way to disk:
// undefined-valued object keys are dropped, undefined array entries and
// non-finite numbers become null, and anything with a toJSON() is asked for
// its JSON form first. Returns undefined for values JSON has no
// representation for (undefined, functions, symbols, bigints) so callers can
// drop the key rather than store a broken value.
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "object":
      break;
    default:
      return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry) ?? null);
  }

  const source = value as { toJSON?: () => unknown };
  if (typeof source.toJSON === "function") {
    return toJsonValue(source.toJSON());
  }

  const normalized: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedEntry = toJsonValue(entry);
    if (normalizedEntry !== undefined) {
      normalized[key] = normalizedEntry;
    }
  }

  return normalized;
}

// toJsonValue for values that must end up as an object (metadata bags, merged
// tool metadata). Non-object input collapses to an empty record rather than
// corrupting the field.
export function toJsonRecord(value: unknown): Record<string, JsonValue> {
  const normalized = toJsonValue(value);
  return typeof normalized === "object" && normalized !== null && !Array.isArray(normalized) ? normalized : {};
}

export const metadataSchema = jsonRecordSchema;
export const tagsSchema = z.array(z.string().min(1).max(128)).max(64);
export const entityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const uriSchema = z.string().min(1).max(4096);
export const jsonSchemaDocumentSchema = jsonRecordSchema;

export const artifactKindSchema = z.enum([
  "audio",
  "document",
  "image",
  "json",
  "log",
  "patch",
  "screenshot",
  "text",
  "transcript",
  "video",
  "webpage"
]);

export const artifactReferenceSchema = z
  .object({
    byteLength: z.number().int().nonnegative().optional(),
    id: entityIdSchema,
    kind: artifactKindSchema,
    mediaType: z.string().min(1).max(256).optional(),
    metadata: metadataSchema.default({}),
    name: z.string().min(1).max(256).optional(),
    sha256: z.string().length(64).optional(),
    uri: uriSchema
  })
  .strict();

export const structuredErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    details: metadataSchema.default({}),
    message: z.string().min(1),
    retriable: z.boolean().default(false)
  })
  .strict();

export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type EntityId = z.infer<typeof entityIdSchema>;
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;
export type JsonSchemaDocument = z.infer<typeof jsonSchemaDocumentSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type StructuredError = z.infer<typeof structuredErrorSchema>;
