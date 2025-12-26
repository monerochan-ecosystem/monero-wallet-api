import type { Output } from "../../api";
import { WasmProcessor } from "../../wasm-processing/wasmProcessor";
export type KeyImage = string;
export async function computeKeyImage(
  output: Output,
  sender_spend_key: string
): Promise<KeyImage | undefined> {
  const wasmProcessor = await WasmProcessor.init();
  wasmProcessor.writeToWasmMemory = (ptr, len) => {
    wasmProcessor.writeString(ptr, len, output.serialized);
    wasmProcessor.writeToWasmMemory = (ptr, len) => {
      wasmProcessor.writeString(ptr, len, sender_spend_key);
    };
  };
  let result: KeyImage | undefined = undefined;
  wasmProcessor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(wasmProcessor.readString(ptr, len));
  };
  //@ts-ignore
  wasmProcessor.tinywasi.instance.exports.compute_key_image(
    output.serialized.length,
    sender_spend_key.length
  );
  if (!result) {
    throw new Error(
      "Failed to compute key image for output with global id: " +
        output.index_on_blockchain
    );
  }
  return result["key_image"] as KeyImage | undefined;
}
