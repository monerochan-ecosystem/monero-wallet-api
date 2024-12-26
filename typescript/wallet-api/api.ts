import { monero_wallet_api_wasm } from "./wasmFile";
import { TinyWASI } from "./wasi";
export type MemoryCallback = (ptr: number, len: number) => void;
export class ViewPair {
  public writeToWasmMemory = (ptr: number, len: number) => {};
  public readFromWasmMemory = (ptr: number, len: number) => {};
  public static async create(
    primary_address: string,
    secret_view_key: string
  ): Promise<ViewPair> {
    const viewPair = new ViewPair(primary_address, secret_view_key);
    const tinywasi = new TinyWASI();

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
    private secret_view_key: string
  ) {}
}

const viewpair = await ViewPair.create(
  "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9",
  "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01"
);
