import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ArtifactReference, JsonValue } from "@/core/contracts";

export async function createArtifactReferenceFromFile(
  filePath: string,
  kind: ArtifactReference["kind"],
  options: {
    mediaType?: string;
    metadata?: Record<string, JsonValue>;
    name?: string;
  } = {}
): Promise<ArtifactReference> {
  const content = await fs.readFile(filePath);
  return {
    byteLength: content.byteLength,
    id: `artifact.${crypto.randomUUID()}`,
    kind,
    mediaType: options.mediaType,
    metadata: options.metadata ?? {},
    name: options.name ?? path.basename(filePath),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    uri: pathToFileURL(filePath).toString()
  };
}
