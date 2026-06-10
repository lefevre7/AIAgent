import { isUtf8 } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_MEDIA_TYPES = new Map<string, string>([
  [".c", "text/x-c"],
  [".cc", "text/x-c++"],
  [".cpp", "text/x-c++"],
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".go", "text/x-go"],
  [".h", "text/x-c"],
  [".html", "text/html"],
  [".java", "text/x-java-source"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".jsx", "text/jsx"],
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".py", "text/x-python"],
  [".rb", "text/x-ruby"],
  [".rs", "text/x-rust"],
  [".sh", "text/x-shellscript"],
  [".sql", "application/sql"],
  [".svg", "image/svg+xml"],
  [".toml", "application/toml"],
  [".ts", "text/typescript"],
  [".tsx", "text/tsx"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"]
]);

const BINARY_MEDIA_TYPES = new Map<string, string>([
  [".bin", "application/octet-stream"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"]
]);

export function resolveLocalPath(inputPath: string, baseDirectory: string): string {
  if (/^file:\/\//iu.test(inputPath)) {
    return path.resolve(fileURLToPath(inputPath));
  }

  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }

  return path.resolve(baseDirectory, inputPath);
}

export function displayLocalPath(baseDirectory: string, absolutePath: string): string {
  const relativePath = path.relative(baseDirectory, absolutePath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return normalizeSlashes(relativePath.length === 0 ? "." : relativePath);
  }

  return normalizeSlashes(path.resolve(absolutePath));
}

export function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

export function looksLikeTextFile(content: Buffer): boolean {
  return !content.includes(0) && isUtf8(content);
}

export function inferMediaType(filePath: string, isBinary: boolean): string {
  const extension = path.extname(filePath).toLowerCase();
  return (isBinary ? BINARY_MEDIA_TYPES.get(extension) : TEXT_MEDIA_TYPES.get(extension)) ??
    (isBinary ? "application/octet-stream" : "text/plain");
}

export function decodeBase64Content(value: string): Buffer {
  return Buffer.from(value, "base64");
}

export function encodeBase64Content(value: Buffer): string {
  return value.toString("base64");
}