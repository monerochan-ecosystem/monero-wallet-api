import { TinyWASI } from "./wasi";
import { monero_wallet_api_wasm } from "./wasmFile";
export type FunctionCallMeta = {
  function: string;
};
export type MemoryCallback = (ptr: number, len: number) => void;
export class WasmProcessor {
  /**
   * This method is invoked whenever a Rust function expects an array or string parameter.
   * You should use `writeArray` or `writeString` within the function assigned to this callback
   * to write the data into WebAssembly (Wasm) memory before calling the corresponding Wasm method.
   *
   * @param ptr - The WebAssembly memory address where the data should be written.
   * @param len - The number of bytes to write starting from the specified `ptr`.
   */
  public writeToWasmMemory: MemoryCallback = (ptr: number, len: number) => {};
  /**
   * This method is invoked whenever a Rust function wants to return an array or string.
   * You should use `readArray` or `readString` within the function assigned to this callback
   * to read the data from WebAssembly (Wasm) memory after the corresponding Wasm method has written it.
   *
   * @param ptr - The WebAssembly memory address from which the data should be read.
   * @param len - The number of bytes to read starting from the specified `ptr`.
   */
  public readFromWasmMemory: MemoryCallback = (ptr: number, len: number) => {};
  /**
   * Writes an array of bytes to a specified offset in WebAssembly memory.
   *
   * This method is typically used within `writeToWasmMemory` to write data into Wasm memory.
   * For more details, see {@link writeToWasmMemory}.
   *
   * @param ptr - The WebAssembly memory address where the data should be written.
   * @param len - The number of bytes to write starting from the specified `ptr`.
   * @param arr - The array of bytes to write into WebAssembly memory.
   *
   * @see {@link writeToWasmMemory}
   */
  public writeArray = (ptr: number, len: number, arr: Uint8Array) => {
    const view = this.tinywasi.getDataView();

    for (let i = 0; i < arr.length; i++) {
      const offset = i + ptr;
      view.setUint8(offset, arr[i]);
    }
  };
  /**
   * Writes a string to a specified offset in WebAssembly memory.
   *
   * This method is typically used within `writeToWasmMemory` to write string data into Wasm memory.
   * For more details, see {@link writeToWasmMemory}.
   *
   * @param ptr - The WebAssembly memory address where the data should be written.
   * @param len - The number of bytes to write starting from the specified `ptr`.
   * @param str - The string to write into WebAssembly memory.
   *
   * @see {@link writeToWasmMemory}
   */
  public writeString = (ptr: number, len: number, str: string) => {
    const encoder = new TextEncoder();
    const arr = encoder.encode(str);
    this.writeArray(ptr, len, arr);
  };
  /**
   * Reads an array of bytes from a specified offset in WebAssembly memory.
   *
   * This method is typically used within the function assigned to `readFromWasmMemory`
   * callback to read data written by Rust functions into Wasm memory.
   *
   * @param ptr - The WebAssembly memory address from which the data should be read.
   * @param len - The number of bytes to read starting from the specified `ptr`.
   * @returns A Uint8Array containing the bytes read from WebAssembly memory.
   *
   * @see {@link readFromWasmMemory}
   */
  public readArray = (ptr: number, len: number) => {
    const memory = this.tinywasi.getMemory();
    return new Uint8Array(memory.buffer, ptr, len);
  };
  /**
   * Reads a string from a specified offset in WebAssembly memory.
   *
   * This method is typically used within `readFromWasmMemory` to read string data from Wasm memory.
   * For more details, see {@link readFromWasmMemory}.
   *
   * @param ptr - The WebAssembly memory address where the data should be read from.
   * @param len - The number of bytes to read starting from the specified `ptr`.
   * @param str - The string to read from WebAssembly memory.
   *
   * @see {@link readFromWasmMemory}
   */
  public readString = (ptr: number, len: number) => {
    const array = this.readArray(ptr, len);
    const decoder = new TextDecoder();
    const str = decoder.decode(array);
    return str;
  };
  public tinywasi!: TinyWASI;
  protected constructor(public node_url: string) {}
  public async initWasmModule() {
    const tinywasi = new TinyWASI();
    this.tinywasi = tinywasi;
    const imports = {
      env: {
        input: (ptr: number, len: number) => {
          this.writeToWasmMemory(ptr, len);
        },
        output: (ptr: number, len: number) => {
          this.readFromWasmMemory(ptr, len);
        },
      },
      ...tinywasi.imports,
    };

    const { module, instance } = await WebAssembly.instantiate(
      monero_wallet_api_wasm,
      imports
    );
    tinywasi.initialize(instance);
    return tinywasi;
  }
}
