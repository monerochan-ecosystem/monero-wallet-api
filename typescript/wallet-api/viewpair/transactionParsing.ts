import type { WasmProcessor } from "../wasm-processing/wasmProcessor";

export type TransactionScan = {
  tx_hash: string;
  unlock_time: string;
  outputs: { amount: string; index_in_transaction: number; stealth_address: string; payment_id: string | null; subaddress_index: [number, number] | null }[];
};

// scan one supplied transaction without opening a wallet or contacting a node.
export async function scanTransaction(params: {
  tx_as_hex: string;
  primary_address: string;
  view_key: string;
  subaddresses?: [number, number][];
}): Promise<TransactionScan> {
  const { ViewPair } = await import("./ViewPair");
  const view = await ViewPair.create(params.primary_address, params.view_key);
  view.registerScanSubaddresses(params.subaddresses ?? []);
  return view.scanTransaction(params.tx_as_hex);
}

export function scanTransactionWithProcessor<T extends WasmProcessor>(
  processor: T,
  txHex: string,
): TransactionScan {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(txHex)) {
    throw new Error("invalid transaction hex");
  }
  let result: TransactionScan | undefined;
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
  return result!;
}
