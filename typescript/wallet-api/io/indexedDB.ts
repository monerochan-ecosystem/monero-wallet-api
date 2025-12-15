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
    return new IndexedDBFile(getFileFromIndexedDB(path.toString()));
  }

  async write(
    destination: string | number | BunFile | URL,
    input: PossibleBunFileContent
  ): Promise<number> {
    return await putFileIntoIndexedDB(destination.toString(), input);
  }
}

class IndexedDBFile implements BunFile {
  readonly size: number = 0;
  readonly type: string = "";

  constructor(readonly content?: Promise<unknown>) {}
  text(): Promise<string> {
    return (this.content as Promise<string>) || Promise.resolve("");
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
  if (!window.filesDb) {
    throw new Error("IndexedDB not initialized");
  }
  const [dbContent, byteLength] = await getItemLength(content);

  const tx = window.filesDb.transaction(fileStoreName, "readwrite");
  const store = tx.objectStore(fileStoreName);
  const request = store.put(dbContent, path);

  return await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(byteLength);
    request.onerror = () => reject(request.error);
  });
}

export function getFileFromIndexedDB(path: string) {
  if (!window.filesDb) {
    throw new Error("IndexedDB not initialized");
  } else {
    const tx = window.filesDb.transaction(fileStoreName, "readonly");
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

if (typeof globalThis.Bun === "undefined" && typeof window !== "undefined") {
  window.filesDb = await initFilesDB();
  window.Bun = new IndexedDBBun() as typeof import("bun");
}
declare global {
  interface Window {
    filesDb?: IDBDatabase;
  }
}
