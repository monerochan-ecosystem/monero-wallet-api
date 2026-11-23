import type { BunFile } from "bun";
import type { TypedArray } from "./BunFileInterface";
import { log } from "./logging";

export async function atomicWrite(
  targetPath: string,
  data: string | Blob | ArrayBuffer | SharedArrayBuffer | TypedArray | Response,
): Promise<number> {
  log("atomicWrite", ["writing to", targetPath]);
  // in the browser we don't have rename + indexedDB writes are atomic in any case
  if (areWeInTheBrowser) return await Bun.write(targetPath, data as BunFile);
  const { rename, unlink } = await import("node:fs/promises");

  const tempPath = targetPath + ".tmp." + Date.now() + "." + Math.random();
  try {
    const bytesWritten = await Bun.write(tempPath, data as BunFile);
    await rename(tempPath, targetPath);
    return bytesWritten;
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}
