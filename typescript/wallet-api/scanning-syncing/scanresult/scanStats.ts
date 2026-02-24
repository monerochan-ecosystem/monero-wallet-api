import { atomicWrite, ViewPair } from "../../api";
import type { OutputsCache, Subaddress } from "./scanCache";

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

export async function readStatsFile(
  cacheFilePath: string,
): Promise<ScanStats | undefined> {
  const jsonString = await Bun.file(cacheFilePath)
    .text()
    .catch(() => undefined);
  return jsonString ? (JSON.parse(jsonString) as ScanStats) : undefined;
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
): Amount {
  let amount = 0n;
  for (const output of Object.values(outputs)) {
    amount += output.amount;
    if (!output.subaddress_index) continue;
    const statsSubaddress =
      scan_stats.subaddresses[output.subaddress_index.toString()];
    if (!statsSubaddress) continue;
    if (!statsSubaddress.amount) {
      statsSubaddress.amount = output.amount;
    } else {
      statsSubaddress.amount += output.amount;
    }
  }
  scan_stats.total_amount = amount;
  return amount;
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
    };
    stats.subaddresses[minor.toString()] = new_subaddress;
    minor++;
  }
}
