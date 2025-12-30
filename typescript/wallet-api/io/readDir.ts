import { readdir } from "node:fs/promises";

export async function readDir(path: string) {
  return await readdir(path);
}
