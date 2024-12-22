import * as fs from "fs";
export function wasmFileToBase64(): string {
  const source = fs.readFileSync(
    "../rust/target/wasm32-wasip1/release/monero_wallet_api.wasm"
  );
  return source.toString("base64");
}
