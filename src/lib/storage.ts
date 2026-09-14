import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(process.cwd(), "uploads");

export async function putObject(params: {
  key: string;
  body: Buffer;
  mimeType: string;
}) {
  const full = path.join(ROOT, params.key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, params.body);
  return { key: params.key, mimeType: params.mimeType };
}

export async function getObject(key: string) {
  const full = path.join(ROOT, key);
  return readFile(full);
}

export function safeKey(parts: string[]) {
  return parts.map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_")).join("/");
}
