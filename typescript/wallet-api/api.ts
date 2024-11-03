import { monero_wallet_api_wasm } from "./wasmFile";
import { TinyWASI } from "./wasi";
export type FFiRegister = (ptr: number, len: number) => void;
class ViewPair {
  public ffiRegister = (ptr: number, len: number) => {};
  public outputRegister = (ptr: number, len: number) => {};
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
          viewPair.ffiRegister(ptr, len);
        },
        output: (ptr: number, len: number) => {
          console.log("output", ptr, len);
          viewPair.outputRegister(ptr, len);
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
    const ffiRegister: FFiRegister = (ptr, len) => {
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
      viewPair.ffiRegister = (ptr, len) => {
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
    viewPair.ffiRegister = ffiRegister;
    viewPair.outputRegister = (ptr, len) => {
      const memory = tinywasi.getMemory();
      const arri = new Uint8Array(memory.buffer, ptr, len);
      console.log(arri);
      fetch("http://localhost:48081/getblocks.bin", {
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
            viewPair.ffiRegister = (ptr, len) => {
              console.log(uint8Array);
              const view = tinywasi.getDataView();
              for (let i = 0; i < uint8Array.length; i++) {
                const offset = i + ptr;
                view.setUint8(offset, uint8Array[i]);
              }
            };
            instance.exports.parse_response(uint8Array.length);
          });
      });
    };
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
  "55Py9fSwyEeQX1CydtFfPk96uHEFxSxvD9AYBy7dwnYt9cXqKDjix9rS9AWZ5GnH4B1Z7yHr3B2UH2updNw5ZNJEEnv87H1",
  "1195868d30373aa9d92c1a21514de97670bcd360c209a409ea3234174892770e"
);
