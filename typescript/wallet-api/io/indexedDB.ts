import { writeEnvLineToDotEnvRefresh } from "../keypairs-seeds/writeKeypairs";
import type { BunFile, FileSink, Bun, TypedArray } from "./BunFileInterface";

export type PossibleBunFileContent =
  | string
  | Blob
  | ArrayBuffer
  | SharedArrayBuffer
  | TypedArray
  | Response;
class IndexedDBBun implements Bun {
  stdin: BunFile = new IndexedDBFile();
  stdout: BunFile = new IndexedDBFile();
  stderr: BunFile = new IndexedDBFile();

  file(path: string | number | URL, options?: { type?: string }): BunFile {
    return new IndexedDBFile(
      getFileFromIndexedDB(path.toString()),
      path.toString()
    );
  }

  async write(
    destination: string | number | BunFile | URL,
    input: PossibleBunFileContent
  ): Promise<number> {
    return await putFileIntoIndexedDB(destination.toString(), input);
  }
  env: BunEnv = {};
}
export type BunEnv = {
  [key: string]: string | undefined;
  TZ?: string | undefined;
  NODE_ENV?: string | undefined;
};
class IndexedDBFile implements BunFile {
  readonly size: number = 0;
  readonly type: string = "";

  constructor(readonly content?: Promise<unknown>, private path?: string) {}
  async text(): Promise<string> {
    const result = (await this.content) as Promise<string | undefined>;
    if (!result)
      throw new Error(`no such file or directory, open '${this.path}'`);
    return result as Promise<string>;
  }

  stream(): ReadableStream {
    throw new Error("not implemented");
    return new ReadableStream();
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error("not implemented");
    return Promise.resolve(new ArrayBuffer(0));
  }

  json(): Promise<any> {
    throw new Error("not implemented");
    return Promise.resolve({});
  }

  writer(params: { highWaterMark?: number }): FileSink {
    throw new Error("not implemented");
    return new BunFileSink();
  }

  exists(): Promise<boolean> {
    throw new Error("not implemented");
    return Promise.resolve(false);
  }
}

class BunFileSink implements FileSink {
  write(
    chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer
  ): number {
    throw new Error("not implemented");
    return 0;
  }

  flush(): number | Promise<number> {
    throw new Error("not implemented");
    return 0;
  }

  end(error?: Error): number | Promise<number> {
    throw new Error("not implemented");
    return 0;
  }

  start(options?: { highWaterMark?: number }): void {
    throw new Error("not implemented");
  }

  ref(): void {
    throw new Error("not implemented");
  }

  unref(): void {
    throw new Error("not implemented");
  }
}
export type IndexedDBItem =
  | string
  | Blob
  | ArrayBufferLike
  | ArrayBuffer
  | SharedArrayBuffer;
export async function getItemLength(
  input: PossibleBunFileContent
): Promise<[IndexedDBItem, number]> {
  if (typeof input === "string") {
    return [input, new TextEncoder().encode(input).length];
  }
  if (input instanceof Blob) {
    return [input, input.size];
  }
  if (ArrayBuffer.isView(input)) {
    return [input.buffer, input.byteLength];
  }
  if ("arrayBuffer" in input) {
    const bytes = await input.arrayBuffer();
    return [bytes, bytes.byteLength];
  }
  // SharedArrayBuffer/ArrayBuffer fallback
  if ("byteLength" in input) {
    return [input, input.byteLength];
  }
  throw new Error(`ENOSPC: unsupported input type`);
}
export async function putFileIntoIndexedDB(
  path: string,
  content: PossibleBunFileContent
): Promise<number> {
  if (!browserGlobal.filesDb) {
    throw new Error("IndexedDB not initialized");
  }
  const [dbContent, byteLength] = await getItemLength(content);

  const tx = browserGlobal.filesDb.transaction(fileStoreName, "readwrite");
  const store = tx.objectStore(fileStoreName);
  const request = store.put(dbContent, path);

  return await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(byteLength);
    request.onerror = () => reject(request.error);
  });
}

export function getFileFromIndexedDB(path: string) {
  if (!browserGlobal.filesDb) {
    throw new Error("IndexedDB not initialized");
  } else {
    const tx = browserGlobal.filesDb.transaction(fileStoreName, "readonly");
    const store = tx.objectStore(fileStoreName);
    const request = store.get(path);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
export const fileStoreName = "files";

async function initFilesDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(fileStoreName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(fileStoreName);
  });
}

export type BrowserGlobal = {
  filesDb?: IDBDatabase;
  Bun: IndexedDBBun;
};
// In browsers: window in main thread, self in workers
const hasWindow = typeof window !== "undefined";
const hasSelf = typeof self !== "undefined";
//@ts-ignore
const browserGlobal: BrowserGlobal = hasWindow ? window : hasSelf ? self : {}; // non-browser -> no shimming
if (typeof globalThis.Bun === "undefined") {
  browserGlobal.filesDb = await initFilesDB();
  browserGlobal.Bun = new IndexedDBBun() as typeof import("bun");
  browserGlobal.Bun.env = await readEnvIndexedDB();
}

export async function refreshEnvIndexedDB() {
  browserGlobal.Bun.env = await readEnvIndexedDB();
}

// we need this to change the env at runtime from inside the Browser extension,
// or react native app. Or to persist view keys in bun web backend.

// this one is specifically for indexedDB (convention of treating .env as Bun.env)
export async function writeEnvIndexedDB(key: string, value: string) {
  // this file should be treated as ephemeral
  // private spendkeys + viewkeys are deterministically derived from seedphrase and password
  // we have to go through indexedDB just so the background worker has access to this.
  // (after waking up from an alarm or onmessage event)
  await writeEnvLineToDotEnvRefresh(key, value, ".env");
}
export async function readEnvIndexedDB() {
  const file = Bun.file(".env");
  const content = await file
    .text()
    .catch(() => {})
    .then((c) => c || "");
  const lines = content.split("\n");
  const result: { [key: string]: string } = {};
  for (const line of lines) {
    const keyValue = line.split("=");
    const key = keyValue[0];
    if (!key) continue;
    const value = keyValue[1];
    result[key.trim()] = value?.trim();
  }

  return result;
}
/**
 * useless function
 * you can just do process.env[key] instead. Look at the code above.
 * @param key
 * @returns value
 */
export async function readEnvIndexedDBLine(key: string): Promise<string> {
  const file = Bun.file(".env");
  const content = await file.text();
  const lines = content.split("\n");

  const idx = lines.findIndex((line) => line.startsWith(key.trim()));
  return lines[idx].split("=")[1].trim();
}
