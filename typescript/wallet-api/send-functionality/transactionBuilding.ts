import type { Output } from "../api";
import type { WasmProcessor } from "../wasm-processing/wasmProcessor";

export function makeInput<T extends WasmProcessor>(
  processor: T,
  outputToBeSpent: Output,
  candidates: number[],
  get_outs_Response: Uint8Array
) {
  const makeInputArgs = JSON.stringify({
    outputToBeSpent,
    candidates,
    get_outs_Response,
  });
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeString(ptr, len, makeInputArgs);
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.make_input(makeInputArgs.length);
  //todo:  read result
}
type SampledDecoys = {
  candidates: number[];
};
export function sampleDecoys<T extends WasmProcessor>(
  processor: T,
  outputToBeSpentIndex: number,
  distribution: number[],
  candidatesLength: number // how many decoy candidates to sample
) {
  const sampleDecoyArgs = JSON.stringify({
    output_being_spent_index: outputToBeSpentIndex,
    distribution,
    candidates_len: candidatesLength,
  });
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeString(ptr, len, sampleDecoyArgs);
  };
  let result;
  processor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(processor.readString(ptr, len));
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.sample_decoys(sampleDecoyArgs.length);
  if (!result) {
    throw new Error("Failed to sample decoys");
  }
  return result as SampledDecoys;
}
