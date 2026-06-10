import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempFilePath, filePath);
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
