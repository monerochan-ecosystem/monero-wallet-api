import * as fs from "fs";
import { TinyWASI } from "./wasi";
const source = fs.readFileSync(
  "../rust/target/wasm32-wasip1/release/monero_wallet_api.wasm"
);
const typedArray = new Uint8Array(source);
let ffiRegister = (ptr: number, len: number) => {};
export async function init() {
  const tinywasi = new TinyWASI();

  const imports = {
    env: {
      input: (ptr: number, len: number) => {
        console.log("input", ptr, len);
        ffiRegister(ptr, len);
      },
    },
    ...tinywasi.imports,
  };

  const { module, instance } = await WebAssembly.instantiate(
    typedArray,
    imports
  );
  tinywasi.initialize(instance);
  console.log(instance.exports);
  instance.exports.init_viewpair(1, 3);
}
init();
