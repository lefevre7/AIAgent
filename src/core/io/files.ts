import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * `mode` applies to the file as it is created, so a secret-bearing record is
 * never readable by others, not even between the write and the rename.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { mode?: number } = {}
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(options.mode === undefined ? {} : { mode: options.mode })
  });
  await fs.rename(tempFilePath, filePath);
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
