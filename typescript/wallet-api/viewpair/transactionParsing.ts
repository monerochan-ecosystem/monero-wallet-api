import type { WasmProcessor } from "../wasm-processing/wasmProcessor";
import { ViewPair } from "./ViewPair";
import type { Output } from "../node-interaction/binaryEndpoints";

export type ScannedTransaction = {
  tx_hash: string;
  unlock_time: string;
  payment_id?: number;
  received_amount?: bigint;
  invoice_amount_matches?: boolean;
  // json keeps amounts and payment ids as strings; subaddresses include account and address indices.
  outputs: (Pick<Output, "index_in_transaction" | "stealth_address"> & {
    amount: string;
    payment_id: string | null;
    subaddress_index: [number, number] | null;
  })[];
};

// scan one supplied transaction without opening a wallet or contacting a node.
export async function scanTransaction(params: {
  tx_as_hex: string;
  primary_address: string;
  view_key: string;
  subaddresses?: [number, number][];
  allow_timelock?: boolean;
}): Promise<ScannedTransaction> {
  const view = await ViewPair.create(params.primary_address, params.view_key);
  view.registerScanSubaddresses(params.subaddresses ?? []);
  return view.scanTransaction({ tx_as_hex: params.tx_as_hex, allow_timelock: params.allow_timelock });
}

export function scanTransactionWithProcessor<T extends WasmProcessor>(
  processor: T,
  txHex: string,
  allow_timelock = false,
): ScannedTransaction {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(txHex)) {
    throw new Error("invalid transaction hex");
  }
  let result: ScannedTransaction | undefined;
  let error: string | undefined;
  processor.writeToWasmMemory = (ptr, len) => processor.writeString(ptr, len, txHex);
  processor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(processor.readString(ptr, len));
  };
  processor.readErrorFromWasmMemory = (ptr, len) => {
    error = JSON.parse(processor.readString(ptr, len)).error;
  };
  const scan = processor.tinywasi.instance!.exports.scan_transaction as CallableFunction;
  scan(txHex.length);
  if (error) throw new Error(error);
  // a timelocked output cannot be spent before unlock_time. callers must opt in.
  if (!allow_timelock && result!.unlock_time !== "0") throw new Error(`timelocked transaction: unlock_time ${result!.unlock_time}`);
  return result!;
}
