import { z } from "zod";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const metadataSchema = z.record(z.string(), jsonValueSchema);
export const tagsSchema = z.array(z.string().min(1).max(128)).max(64);
export const entityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const uriSchema = z.string().min(1).max(4096);
export const jsonSchemaDocumentSchema = z.record(z.string(), jsonValueSchema);

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
