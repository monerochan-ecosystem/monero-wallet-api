import * as fs from "fs";
import { TinyWASI } from "./wasi";
const source = fs.readFileSync(
  "../rust/target/wasm32-wasip1/release/monero_wallet_api.wasm"
);
export const monero_wallet_api_wasm = new Uint8Array(source);
