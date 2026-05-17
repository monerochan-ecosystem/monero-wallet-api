import { fileToBase64 } from "../inlineMacro" with { type: "macro" };
const libsource = fileToBase64(
  "../rust/target/wasm32-wasip1/release/monero_wallet_api.wasm",
);
export const monero_wallet_api_wasm = new Uint8Array(
  atob(libsource)
    .split("")
    .map(function (c) {
      return c.charCodeAt(0);
    }),
);

const dkg_source = fileToBase64(
  "../frost-dkg/target/wasm32-wasip1/release/frost_dkg.wasm",
);
export const frost_dkg_wasm = new Uint8Array(
  atob(dkg_source)
    .split("")
    .map(function (c) {
      return c.charCodeAt(0);
    }),
);
