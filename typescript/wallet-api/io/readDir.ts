import { readdir } from "node:fs/promises";
import { readdir as indexedDBreaddir } from "./indexedDB";

export async function readDir(path: string) {
  if (!readdir) {
    return await indexedDBreaddir(path);
  }
  return await readdir(path);
}
