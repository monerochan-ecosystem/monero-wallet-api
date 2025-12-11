import type { GetFeeEstimateResult, Output } from "../api";
import { WasmProcessor } from "../wasm-processing/wasmProcessor";
export type Input = string;
export type UnsignedTransaction = string;
export type SignedTransaction = string;
export function makeInput<T extends WasmProcessor>(
  processor: T,
  outputToBeSpent: Output,
  candidates: number[],
  get_outs_Response: Uint8Array
): Input {
  const makeInputArgs = JSON.stringify({
    serialized_input: outputToBeSpent.serialized,
    candidates,
  });
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeString(ptr, len, makeInputArgs);
    processor.writeToWasmMemory = (ptr, len) => {
      processor.writeArray(ptr, len, get_outs_Response);
    };
  };
  let result: { input: number[] } | null = null;
  processor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(processor.readString(ptr, len));
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.make_input(
    makeInputArgs.length,
    get_outs_Response.length
  );
  if (!result) {
    throw new Error(
      "Failed to make Input (combine output with sampled and verified unlocked decoys)"
    );
  }
  return result["input"] as Input;
}
export type SampledDecoys = {
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

export type MakeTransactionParams = {
  inputs: Input[];
  payments: {
    address: string;
    amount: string;
  }[];
  fee_response: GetFeeEstimateResult;
  fee_priority: string;
  outgoing_view_key?: string;
  data?: number[][];
};

export function makeTransaction<T extends WasmProcessor>(
  processor: T,
  params: MakeTransactionParams
) {
  const jsonParams = JSON.stringify(params);
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeString(ptr, len, jsonParams);
  };
  let result: { transaction: number[] } | null = null;
  processor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(processor.readString(ptr, len));
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.make_transaction(jsonParams.length);
  if (!result) {
    throw new Error("Failed to make transaction");
  }
  return result["signable_transaction"] as UnsignedTransaction;
}

export async function signTransaction(
  tx: UnsignedTransaction,
  sender_spend_key: string
): Promise<SignedTransaction> {
  const wasmProcessor = await WasmProcessor.init();
  wasmProcessor.writeToWasmMemory = (ptr, len) => {
    wasmProcessor.writeString(ptr, len, tx);
    wasmProcessor.writeToWasmMemory = (ptr, len) => {
      wasmProcessor.writeString(ptr, len, sender_spend_key);
    };
  };
  let result: { signed_transaction: string } | null = null;
  wasmProcessor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(wasmProcessor.readString(ptr, len));
  };
  //@ts-ignore
  wasmProcessor.tinywasi.instance.exports.sign_transaction(
    tx.length,
    sender_spend_key.length
  );
  if (!result) {
    throw new Error("Failed to sign transaction");
  }
  return result["signed_transaction"];
}
