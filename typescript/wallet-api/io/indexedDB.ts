import type { BunFile, FileSink, Bun, TypedArray } from "./BunFileInterface";

class IndexedDBBun implements Bun {
  stdin: BunFile = new IndexedDBFile();
  stdout: BunFile = new IndexedDBFile();
  stderr: BunFile = new IndexedDBFile();

  file(path: string | number | URL, options?: { type?: string }): BunFile {
    throw new Error("not implemented");
    return new IndexedDBFile();
  }

  async write(
    destination: string | number | BunFile | URL,
    input:
      | string
      | Blob
      | ArrayBuffer
      | SharedArrayBuffer
      | TypedArray
      | Response
  ): Promise<number> {
    throw new Error("not implemented");
    return 0;
  }
}

class IndexedDBFile implements BunFile {
  readonly size: number = 0;
  readonly type: string = "";

  text(): Promise<string> {
    throw new Error("not implemented");
    return Promise.resolve("");
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

if (typeof globalThis.Bun === "undefined" && typeof window !== "undefined") {
  window.Bun = new IndexedDBBun() as typeof import("bun");
}
