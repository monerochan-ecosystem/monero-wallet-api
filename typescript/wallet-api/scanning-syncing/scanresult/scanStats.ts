import { stat } from "fs";
import { atomicWrite, ViewPair, type Output } from "../../api";
import type { ScanCache, Subaddress, TxLog } from "./scanCache";
import { outputStatus, type OutputStatus } from "./scanResult";

export type WriteStatsFileParams = {
  primary_address: string;
  pathPrefix?: string | undefined;
  writeCallback: (stats: ScanStats) => void | Promise<void>;
};
export async function writeStatsFileDefaultLocation(
  params: WriteStatsFileParams,
) {
  let stats = await readStatsFileDefaultLocation(
    params.primary_address,
    params.pathPrefix,
  );
  if (!stats)
    stats = {
      height: 0,
      total_spendable_amount: 0n,
      total_pending_amount: 0n,
      primary_address: params.primary_address,
      found_transactions: {},
      ordered_transactions: [],
      subaddresses: {},
    };

  await params.writeCallback(stats);
  await atomicWrite(
    statsFileDefaultLocation(stats.primary_address, params.pathPrefix),
    JSON.stringify(
      stats,
      (key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
  return stats;
}
export function statsFileDefaultLocation(
  primary_address: string,
  pathPrefix?: string,
) {
  return `${pathPrefix ?? ""}${primary_address}_stats.json`;
}

// amount | total_amount | total_pending_amount | pending_amount  :->  all bigint keys
export async function readStatsFile(
  cacheFilePath: string,
): Promise<ScanStats | undefined> {
  const jsonString = await Bun.file(cacheFilePath)
    .text()
    .catch(() => undefined);
  return jsonString
    ? (JSON.parse(jsonString, (key, value) => {
        if (
          key === "amount" ||
          key === "pending_amount" ||
          key === "total_amount" ||
          key === "total_pending_amount" ||
          key === "primary_address_received_amount" ||
          key === "primary_address_pending_amount"
        )
          return BigInt(value);
        return value;
      }) as ScanStats)
    : undefined;
}

export async function readStatsFileDefaultLocation(
  primary_address: string,
  pathPrefix?: string,
): Promise<ScanStats | undefined> {
  return await readStatsFile(
    statsFileDefaultLocation(primary_address, pathPrefix),
  );
}
export function addSpentAmount(scan_stats: ScanStats, output: Output) {
  if (!output.subaddress_index) {
    if (!scan_stats.primary_address_received_amount)
      scan_stats.primary_address_received_amount = 0n;
    scan_stats.primary_address_received_amount += output.amount;
    return;
  }
  const statsSubaddress =
    scan_stats.subaddresses[output.subaddress_index.toString()];
  if (!statsSubaddress) return;
  if (typeof statsSubaddress.received_amount === "undefined")
    statsSubaddress.received_amount = 0n;

  statsSubaddress.received_amount += output.amount;
}
export function addSpendableAmount(scan_stats: ScanStats, output: Output) {
  scan_stats.total_spendable_amount += output.amount;
  if (!output.subaddress_index) {
    if (!scan_stats.primary_address_received_amount)
      scan_stats.primary_address_received_amount = 0n;
    scan_stats.primary_address_received_amount += output.amount;
    return;
  }
  const statsSubaddress =
    scan_stats.subaddresses[output.subaddress_index.toString()];
  if (!statsSubaddress) return;
  if (typeof statsSubaddress.received_amount === "undefined")
    statsSubaddress.received_amount = 0n;

  statsSubaddress.received_amount += output.amount;
}
export function addPendingAmount(scan_stats: ScanStats, output: Output) {
  scan_stats.total_pending_amount += output.amount;
  if (!output.subaddress_index) {
    if (!scan_stats.primary_address_pending_amount)
      scan_stats.primary_address_pending_amount = 0n;
    scan_stats.primary_address_pending_amount += output.amount;
    return;
  }
  const statsSubaddress =
    scan_stats.subaddresses[output.subaddress_index.toString()];
  if (!statsSubaddress) return;
  if (typeof statsSubaddress.pending_amount === "undefined")
    statsSubaddress.pending_amount = 0n;

  statsSubaddress.pending_amount += output.amount;
}
export type SubaddressMinorIndex = string;
export type Amount = bigint;
// every tx has an output, get more info from outputs[0]
export type FoundTransaction = {
  amount: bigint;
  inputs: Output[];
  outputs: Output[];
  tx_hash: string;
  status: OutputStatus;
  txlog?: TxLog;
};
export type TxHash = string;

export type ScanStats = {
  height: number;
  total_spendable_amount: bigint;
  total_pending_amount: bigint;
  primary_address: string;
  primary_address_received_amount?: bigint;
  primary_address_pending_amount?: bigint;
  subaddresses: Record<SubaddressMinorIndex, Subaddress>;
  found_transactions: Record<TxHash, FoundTransaction>;
  ordered_transactions: TxHash[];
};
export function processFoundTransactions(
  cache: ScanCache,
  stats: ScanStats,
  current_height: number,
) {
  stats.found_transactions = {};
  stats.ordered_transactions = [];
  Object.entries(cache.outputs).forEach(([_, output]) => {
    const status = outputStatus(output, cache, current_height || 0);

    const in_ordered_transactions = stats.ordered_transactions.includes(
      output.tx_hash,
    );
    if (!in_ordered_transactions)
      stats.ordered_transactions.push(output.tx_hash);
    const receivedTx = stats.found_transactions[output.tx_hash];
    if (receivedTx) {
      receivedTx.outputs.push(output);
      receivedTx.amount += output.amount;
      // we possibly first added the tx_hash when we found a spent output
      // placehodler pending status that we added in "handle spent case"
      // needs to be updated
      receivedTx.status = status;
    } else {
      stats.found_transactions[output.tx_hash] = {
        status,
        inputs: [],
        amount: output.amount,
        outputs: [output],
        tx_hash: output.tx_hash,
      };
    }
    // handle spent case
    if (output.spent_in_tx_hash) {
      const spent_utxo_value = cache.pending_spent_utxos
        ? cache.pending_spent_utxos[output.index_on_blockchain]
        : null;
      const txlog =
        cache.tx_logs && spent_utxo_value
          ? cache.tx_logs[spent_utxo_value]
          : undefined;
      const spentTx = stats.found_transactions[output.spent_in_tx_hash];
      if (spentTx) {
        spentTx.amount -= output.amount;
        spentTx.inputs.push(output);
      } else {
        stats.found_transactions[output.spent_in_tx_hash] = {
          status: { status: "pending", unlock_height: 0 },
          inputs: [output],
          amount: -output.amount,
          outputs: [],
          tx_hash: output.spent_in_tx_hash,
          txlog,
        };
      }
    }
    if (status.status === "spendable") addSpendableAmount(stats, output);
    else if (status.status === "pending") addPendingAmount(stats, output);
    else if (status.status === "spent") addSpentAmount(stats, output);
  });
}
export function removeChangeFromPrimaddressAmounts(stats: ScanStats) {}
export function addSubAddressesFromCacheToScanStats(
  cache: ScanCache,
  stats: ScanStats,
) {
  // add cache subaddresses to statsfile
  for (const cacheSub of cache.subaddresses || []) {
    //if (!stats.subaddresses[cacheSub.minor.toString()]) <-- uncommented to overwrite existing
    stats.subaddresses[cacheSub.minor.toString()] = {
      minor: cacheSub.minor,
      address: cacheSub.address,
      created_at_height: cacheSub.created_at_height,
      created_at_timestamp: cacheSub.created_at_timestamp,
      received_amount: 0n,
      pending_amount: 0n,
    };
  }
}
export function addMissingSubAddressesToScanStats(
  stats: ScanStats,
  view_pair: ViewPair,
  highestSubaddressMinor: number = 1,
  created_at_height: number = 0,
) {
  // add subaddresses to statsfile that are not in the cache
  let minor = 1;
  //const highestSubaddressMinor = walletSettings.subaddress_index || 1;
  while (minor <= highestSubaddressMinor) {
    if (stats.subaddresses[minor.toString()]) {
      minor++;
      continue;
    }
    const subaddress = view_pair.makeSubaddress(minor);
    //const created_at_height =
    //   lastRange(scanCacheOpen._cache.scanned_ranges)?.end || 0;
    const created_at_timestamp = new Date().getTime();
    const new_subaddress: Subaddress = {
      minor,
      address: subaddress,
      created_at_height,
      created_at_timestamp,
      not_yet_included: true,
      received_amount: 0n,
      pending_amount: 0n,
    };
    stats.subaddresses[minor.toString()] = new_subaddress;
    minor++;
  }
}
export function isSelfSpent(address: string, cache: ScanCache) {
  if (address === cache.primary_address) return true;
  for (const subaddress of cache.subaddresses || []) {
    if (subaddress.address === address) return true;
  }
  return false;
}
export function removeChangeFromPrimAddressReceivedAmounts(stats: ScanStats) {
  if (!stats.primary_address_pending_amount)
    stats.primary_address_pending_amount = 0n;
  if (!stats.primary_address_received_amount)
    stats.primary_address_received_amount = 0n;

  for (const tx of stats.ordered_transactions) {
    const transaction = stats.found_transactions[tx];
    if (
      transaction.status.status === "pending" ||
      transaction.status.status === "prepending"
    )
      stats.primary_address_pending_amount -= transaction.amount;
    else if (
      transaction.status.status === "spendable" ||
      transaction.status.status === "spent"
    )
      stats.primary_address_received_amount -= transaction.amount;
  }
}
export type PrePendingTx = {
  amount: bigint;
  inputs: Output[];
  txlog: TxLog;
  inputSum: bigint;
  outWardPaymentSum: bigint;
  self_spent: boolean;
  destination_address: string;
};
export function processTxlogPayments(txlog: TxLog, cache: ScanCache) {
  let outWardPaymentSum = 0n;
  for (const payment of txlog.payments) {
    if (!isSelfSpent(payment.address, cache)) {
      outWardPaymentSum += BigInt(payment.amount);
    }
  }
  return outWardPaymentSum;
}
export function processTxlogInputs(txlog: TxLog, cache: ScanCache) {
  let alreadyRecognizedAsSpend = false;
  let inputSum = 0n;
  for (const inputId of txlog.inputs_index) {
    const input = cache.outputs[inputId];
    if (typeof input.spent_in_tx_hash === "string") {
      alreadyRecognizedAsSpend = true;
      continue;
    }
    inputSum += input.amount;
  }
  return { inputSum, alreadyRecognizedAsSpend };
}
export function processTxlogs(cache: ScanCache, stats: ScanStats) {
  for (const txlog of cache.tx_logs || []) {
    if (
      !txlog ||
      !txlog.sendResult ||
      (txlog.sendResult && txlog.sendResult.status !== "OK")
    )
      continue;
    const { inputSum, alreadyRecognizedAsSpend } = processTxlogInputs(
      txlog,
      cache,
    );
    if (alreadyRecognizedAsSpend) continue;
    const outWardPaymentSum = processTxlogPayments(txlog, cache);
    stats.total_spendable_amount -= inputSum;
    const newPending = inputSum - outWardPaymentSum;
    stats.total_pending_amount += newPending;
  }
}
export async function alignScanStatsWithCache(
  cache: ScanCache,
  view_pair: ViewPair,
  primary_address: string,
  pathPrefix?: string,
  highestSubaddressMinor: number = 1,
  current_scan_tip_height: number = 0,
) {
  return await writeStatsFileDefaultLocation({
    primary_address,
    pathPrefix,
    writeCallback: async (stats) => {
      resetStats(stats);
      // this condition misses reorgs
      // it seems wasteful to re read the cache on every wallet open
      // not doing it is premature optimization.
      // This is not computationally expensive + memory bandwith is tens of gb per second
      //if (!current_scan_tip_height || current_scan_tip_height > stats.height) {
      addSubAddressesFromCacheToScanStats(cache, stats);
      addMissingSubAddressesToScanStats(
        stats,
        view_pair,
        highestSubaddressMinor,
        current_scan_tip_height,
      );

      processFoundTransactions(cache, stats, current_scan_tip_height);
      processTxlogs(cache, stats);
      stats.height = current_scan_tip_height;
      //}
    },
  });
}
export function resetStats(stats: ScanStats) {
  stats.height = 0;
  stats.total_spendable_amount = 0n;
  stats.total_pending_amount = 0n;
  stats.found_transactions = {};
  stats.ordered_transactions = [];
  stats.subaddresses = {};
}
