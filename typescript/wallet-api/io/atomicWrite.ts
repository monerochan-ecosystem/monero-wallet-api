import type { BunFile } from "bun";
import type { TypedArray } from "./BunFileInterface";
declare global {
  var areWeInTheBrowser: boolean;
}
export async function atomicWrite(
  targetPath: string,
  data: string | Blob | ArrayBuffer | SharedArrayBuffer | TypedArray | Response
): Promise<number> {
  // in the browser we don't have rename + indexedDB writes are atomic in any case
  if (areWeInTheBrowser) return await Bun.write(targetPath, data as BunFile);
  const { rename } = await import("node:fs/promises");

  const tempPath = targetPath + ".tmp";
  const bytesWritten = await Bun.write(tempPath, data as BunFile);
  await rename(tempPath, targetPath);

  return bytesWritten;
}
