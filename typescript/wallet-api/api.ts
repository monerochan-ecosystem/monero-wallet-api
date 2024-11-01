import { monero_wallet_api_wasm } from "./wasmFile";
import { TinyWASI } from "./wasi";
export type FFiRegister = (ptr: number, len: number) => void;
class ViewPair {
  public ffiRegister = (ptr: number, len: number) => {};
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
      //TODO write primary address to ptr
      const view = tinywasi.getDataView();
      const encoder = new TextEncoder();
      const uint8Array = encoder.encode(primary_address);
      for (let i = ptr; i < uint8Array.length; i++) {
        view.setUint8(i, uint8Array[i]);
      }
      viewPair.ffiRegister = (ptr, len) => {
        const view = tinywasi.getDataView();
        const encoder = new TextEncoder();
        const uint8Array = encoder.encode(secret_view_key);
        for (let i = ptr; i < uint8Array.length; i++) {
          view.setUint8(i, uint8Array[i]);
        }
        //TODO write secretviewkey to ptr
      };
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
