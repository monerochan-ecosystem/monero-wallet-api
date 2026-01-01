import { fileToBase64 } from '../inlineMacro' with { type: 'macro' };
const source = fileToBase64("../rust/target/wasm32-wasip1/release/monero_wallet_api.wasm")
export const monero_wallet_api_wasm = new Uint8Array(atob(source).split("").map(function(c) {
    return c.charCodeAt(0); }));