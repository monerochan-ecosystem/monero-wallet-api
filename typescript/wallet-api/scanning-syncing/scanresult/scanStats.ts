import { atomicWrite, ViewPair, type Output } from "../../api";
import type {
  ChangedOutput,
  OutputsCache,
  ScanCache,
  Subaddress,
} from "./scanCache";
import { outputStatus } from "./scanResult";

type WriteStatsFileParams = {
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
      total_amount: 0n,
      total_pending_amount: 0n,
      primary_address: params.primary_address,
      pending_amounts: [],
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
          key === "total_pending_amount"
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
export function sumOutputs(
  outputs: OutputsCache,
  scan_stats: ScanStats,
  current_scan_tip_height: number = 0,
) {
  scan_stats.total_amount = 0n;
  for (const output of Object.values(outputs)) {
    const status = outputStatus(output, current_scan_tip_height);
    if (status.status === "spendable") addSpendableAmount(scan_stats, output);
    else if (status.status === "pending") addPendingAmount(scan_stats, output);
  }
}
export function addSpendableAmount(scan_stats: ScanStats, output: Output) {
  scan_stats.total_amount += output.amount;
  if (!output.subaddress_index) return;
  const statsSubaddress =
    scan_stats.subaddresses[output.subaddress_index.toString()];
  if (!statsSubaddress) return;
  if (typeof statsSubaddress.amount === "undefined")
    statsSubaddress.amount = 0n;

  statsSubaddress.amount += output.amount;
}
export function addPendingAmount(scan_stats: ScanStats, output: Output) {
  scan_stats.total_pending_amount += output.amount;
  if (!output.subaddress_index) return;
  const statsSubaddress =
    scan_stats.subaddresses[output.subaddress_index.toString()];
  if (!statsSubaddress) return;
  if (typeof statsSubaddress.pending_amount === "undefined")
    statsSubaddress.pending_amount = 0n;

  statsSubaddress.pending_amount += output.amount;
}
export type SubaddressMinorIndex = string;
export type Amount = bigint;
export type PendingAmount = {
  amount: bigint;
  subaddress_index: number | null;
  becomes_spendable_at_height: number;
  output_index: number;
  tx_hash: string;
  block_height: number;
};
export type ScanStats = {
  height: number;
  total_amount: bigint;
  total_pending_amount: bigint;
  pending_amounts: PendingAmount[];
  primary_address: string;
  subaddresses: Record<SubaddressMinorIndex, Subaddress>;
};
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
      amount: 0n,
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
      amount: 0n,
      pending_amount: 0n,
    };
    stats.subaddresses[minor.toString()] = new_subaddress;
    minor++;
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

      sumOutputs(cache.outputs, stats, current_scan_tip_height);
      stats.height = current_scan_tip_height;
      //}
    },
  });
}
