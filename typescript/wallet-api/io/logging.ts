import { getPathPrefix, openScanSettingsFile } from "../api";
import { atomicWrite } from "./atomicWrite";

/**
 * logging function names registry.
 *
 * useful filter combinations for `scanSettings.json`:
 *
 *   "logs": "console",
 *   "logs_include": ["handleCpuboundScan", "logBufStatus"]
 *     -> cpu worker progress + buffer/work status.
 *
 *   "logs_include": ["coordinatorMainMultithreaded", "scheduleWorkOnCpuPorts", "workToBeDoneForBatch"]
 *     -> coordinator events: race count, work dispatch, batch decisions.
 *
 *   "logs_include": ["blocksBufferFetchLoop", "makeWorkItemsFromBlocksBuffer", "logBufStatus"]
 *     -> block fetching, reconciliation, buffer state.
 *
 *   "logs_include": ["processScanResult", "processWorkItem"]
 *     -> result processing, cache updates, reorg detection.
 *
 *   "logs_include": ["handleConnectionStatusChanges", "handleScanError"]
 *     -> connection events and scan errors.
 *
 *   "logs": "off"   disables all logging.
 *   "logs": "file"  writes to `<coordinator|cpubound|mainthread>-<id>-<timestamp>.log`.
 *   "logs": "console-and-file"  writes to file and console.
 */
export const LOGGING_FUNCTIONS = [
  // scanCoordination.ts
  "findWorkToBeDone",
  "workToBeDoneForBatch",
  "makeWorkItemsFromBlocksBuffer",
  "reconcileWorkItemDone",
  "processWorkItem",
  "logBufStatus",
  "coordinatorMain",
  "coordinatorMainMultithreaded",
  "scheduleWorkOnCpuPorts",

  // scanResult.ts
  "processScanResult",

  // scanCache.ts
  "handleScanError",

  // backgroundWorker.ts
  "createWebworker",
  "startWebworker",

  // blocksBufferFetchLoop.ts
  "blocksBufferFetchLoop",
  "reduceStartHeightToTip",

  // blocksbufferCoordination.ts
  "handleConnectionStatusChanges",

  // cpubound-main.ts
  "handleCpuboundScan",

  // coordinator-main.ts
  "coordinatorMainWorker",

  // worker.ts
  "CPU_PORT_HANDLER",

  // io/atomicWrite.ts
  "atomicWrite",
  // multisig-main.ts
  "multisigMainWorkerCall",
] as const;
export type PossibleLogs = (typeof LOGGING_FUNCTIONS)[number];
export type LogSetting = "console" | "file" | "console-and-file" | "off";
export type FileLogMessage = {
  timestamp: string;
  message: any;
};
export async function setupLoggingPath(
  scan_settings_path: string,
  path_prefix: string,
  role: "coordinator" | "cpubound" | "mainthread" | "multisig",
  cpu_worker_id?: number,
) {
  const scanSettings = await openScanSettingsFile(scan_settings_path);
  const logs = scanSettings?.logs;
  if (logs === "off" || typeof logs === "undefined") return;

  const logs_include = scanSettings?.logs_include;
  const logs_exclude = scanSettings?.logs_exclude;
  const file_logbuffer: FileLogMessage[] = [];
  const logging_path_prefix = getPathPrefix(scan_settings_path, path_prefix);
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const global_logging_path = `${logging_path_prefix}${role}-${cpu_worker_id ?? ""}-${timestamp}.log`;
  const global_log_setup = {
    logs,
    logs_include,
    logs_exclude,
    file_logbuffer,
    global_logging_path,
  };
  (globalThis as any).__global_log_setup = global_log_setup;

  startLogFlusher(global_log_setup);

  return global_log_setup;
}
function safeStringify(value: any): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "function") return `fn ${v.name || "anon"}`;
      if (v !== null && typeof v === "object") {
        // promise or thenable
        if (typeof (v as any).then === "function") {
          try {
            return typeof Bun !== "undefined" && (Bun as any).inspect
              ? (Bun as any).inspect(v)
              : "Promise";
          } catch {
            return "Promise";
          }
        }
        // message port
        const ctor = (v as any).constructor;
        if (ctor?.name === "MessagePort") return "MessagePort";
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

const flusherRef = new WeakMap<object, ReturnType<typeof setInterval>>();

function startLogFlusher(setup: {
  logs?: LogSetting;
  file_logbuffer: FileLogMessage[];
  global_logging_path: string;
}): void {
  if (setup.logs !== "file" && setup.logs !== "console-and-file") return;
  if (flusherRef.has(setup)) return; // already running

  let writtenIndex = 0;

  const id = setInterval(async () => {
    const buffer = setup.file_logbuffer;
    if (buffer.length <= writtenIndex) return; // nothing new

    const newEntries = buffer.slice(writtenIndex);
    writtenIndex = buffer.length;

    if (newEntries.length === 0) return;

    const lines = newEntries
      .map((e) => `[${e.timestamp}] ${safeStringify(e.message)}`)
      .join("\n");

    try {
      const existing = await Bun.file(setup.global_logging_path)
        .text()
        .catch(() => "");
      const newContent = existing ? existing + "\n" + lines : lines;
      await atomicWrite(setup.global_logging_path, newContent);
    } catch (err) {
      console.error("[logFlusher] write failed:", err);
    }
  }, 2000);

  flusherRef.set(setup, id);
}

export function log(fnname: string, message: any) {
  const setup = (globalThis as any).__global_log_setup;
  if (!setup) return;

  const { logs, logs_include, logs_exclude, file_logbuffer } = setup;

  if (logs === "off" || typeof logs === "undefined") return;

  // Apply include/exclude filters
  if (logs_include && logs_include.length > 0 && !logs_include.includes(fnname))
    return;
  if (logs_exclude && logs_exclude.includes(fnname)) return;

  // skip messages that are about writing to the log file itself
  // (prevents atomicWrite calls inside the flusher from feeding back)
  const logPath = setup.global_logging_path;
  if (logPath) {
    const msg = message;
    if (
      (typeof msg === "string" && msg.includes(logPath)) ||
      (Array.isArray(msg) &&
        msg.some((m) => typeof m === "string" && m.includes(logPath)))
    )
      return;
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  if (logs === "console" || logs === "console-and-file") {
    console.log(
      `[${fnname}]`,
      ...(Array.isArray(message) ? message : [message]),
    );
  }

  if (logs === "file" || logs === "console-and-file") {
    file_logbuffer.push({ timestamp, message });
  }
}
