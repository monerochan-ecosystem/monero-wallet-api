import type { BunFile } from "bun";
import { rename } from "node:fs/promises";
import type { TypedArray } from "./BunFileInterface";

export async function atomicWrite(
  targetPath: string,
  data: string | Blob | ArrayBuffer | SharedArrayBuffer | TypedArray | Response
): Promise<number> {
  const tempPath = targetPath + ".tmp";

  const bytesWritten = await Bun.write(tempPath, data as BunFile);
  await rename(tempPath, targetPath);

  return bytesWritten;
}
