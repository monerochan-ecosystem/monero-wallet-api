import { atomicWrite, type Output } from "../../api";
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
      amount: 0n,
      primary_address: params.primary_address,
      subaddresses: {},
    };

  await params.writeCallback(stats);
  await atomicWrite(
    statsFileDefaultLocation(stats.primary_address, params.pathPrefix),
    JSON.stringify(
      stats,
      (key, value) =>
        typeof value === "bigint" ? value.toString() + "n" : value,
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
  scan_stats.amount = amount;
  return amount;
}
export type SubaddressMinorIndex = string;
export type Amount = bigint;
export type ScanStats = {
  height: number;
  amount: bigint;
  primary_address: string;
  subaddresses: Record<SubaddressMinorIndex, Subaddress>;
};
