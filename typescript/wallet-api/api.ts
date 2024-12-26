import { monero_wallet_api_wasm } from "./wasmFile";
import { TinyWASI } from "./wasi";
export type MemoryCallback = (ptr: number, len: number) => void;
export class ViewPair {
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
  public static async create(
    primary_address: string,
    secret_view_key: string
  ): Promise<ViewPair> {
    const viewPair = new ViewPair(
      primary_address,
      secret_view_key,
      new TinyWASI()
    );
    const tinywasi = viewPair.tinywasi;

    const imports = {
      env: {
        input: (ptr: number, len: number) => {
          console.log("input", ptr, len);
          viewPair.writeToWasmMemory(ptr, len);
        },
        output: (ptr: number, len: number) => {
          console.log("output", ptr, len);
          viewPair.readFromWasmMemory(ptr, len);
        },
      },
      ...tinywasi.imports,
    };

    const { module, instance } = await WebAssembly.instantiate(
      monero_wallet_api_wasm,
      imports
    );
    tinywasi.initialize(instance);
    console.log(instance.exports);
    const ffiRegister: MemoryCallback = (ptr, len) => {
      console.log("ffffiiiiiii");
      //TODO write primary address to ptr
      const view = tinywasi.getDataView();
      const encoder = new TextEncoder();
      const uint8Array = encoder.encode(primary_address);
      console.log(uint8Array);

      for (let i = 0; i < uint8Array.length; i++) {
        const offset = i + ptr;
        view.setUint8(offset, uint8Array[i]);
      }
      viewPair.writeToWasmMemory = (ptr, len) => {
        const view = tinywasi.getDataView();
        const encoder = new TextEncoder();
        const uint8Array = encoder.encode(secret_view_key);
        console.log(uint8Array);
        for (let i = 0; i < uint8Array.length; i++) {
          const offset = i + ptr;
          view.setUint8(offset, uint8Array[i]);
        }
        //TODO write secretviewkey to ptr
      };
    };
    viewPair.writeToWasmMemory = ffiRegister;
    viewPair.readFromWasmMemory = (ptr, len) => {
      const memory = tinywasi.getMemory();
      const arri = new Uint8Array(memory.buffer, ptr, len);
      console.log(arri);
      fetch("http://stagenet.community.rino.io:38081/getblocks.bin", {
        headers: {
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          Referer: "http://localhost:8080/",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        },
        body: arri,
        method: "POST",
      }).then((x) => {
        console.log(x);
        x.blob()
          .then((z) => {
            return z.arrayBuffer();
          })
          .then((y) => {
            const uint8Array = new Uint8Array(y);
            viewPair.writeToWasmMemory = (ptr, len) => {
              console.log(uint8Array);
              const view = tinywasi.getDataView();
              for (let i = 0; i < uint8Array.length; i++) {
                const offset = i + ptr;
                view.setUint8(offset, uint8Array[i]);
              }
            };
            //@ts-ignore
            instance.exports.parse_response(uint8Array.length);
          });
      });
    };
    //@ts-ignore
    instance.exports.init_viewpair(
      primary_address.length,
      secret_view_key.length
    );
    //todo attach instance to viewPair
    return viewPair;
  }

  private constructor(
    private primary_address: string,
    private secret_view_key: string,
    private tinywasi: TinyWASI
  ) {}
}

const viewpair = await ViewPair.create(
  "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9",
  "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01"
);
