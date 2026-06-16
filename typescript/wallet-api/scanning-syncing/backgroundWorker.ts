import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import { type CacheChangedCallbackParameters } from "./scanresult/scanCache";
import { openScanSettingsFile, SCAN_SETTINGS_STORE_NAME_DEFAULT } from "../api";
import { log, setupLoggingPath } from "../io/logging";
import { workerMainCode } from "./worker-entrypoints/worker";
export const CPU_POOL_SIZE = 4;

export type WorkerSet = {
  fetchWorker: Worker;
  cpuWorkers: Worker[];
  terminate: () => void;
};

export async function createWebworker(
  handle_result?: (result: CacheChangedCallbackParameters) => void,
  scan_settings_path?: string,
  pathPrefix?: string,
  handle_error?: (error: unknown) => void,
): Promise<WorkerSet | undefined> {
  try {
    const resolvedPath = scan_settings_path || SCAN_SETTINGS_STORE_NAME_DEFAULT;
    const scanSettings = await openScanSettingsFile(resolvedPath);
    if (scanSettings?.logs !== "off" && scanSettings?.logs)
      await setupLoggingPath(resolvedPath, pathPrefix ?? "", "mainthread");

    const node_url = scanSettings?.node_url || LOCAL_NODE_DEFAULT_URL;
    const cpu_worker_count =
      typeof scanSettings?.cpu_worker_count !== "undefined"
        ? scanSettings?.cpu_worker_count || 1
        : CPU_POOL_SIZE;

    // spawn CPU workers
    const cpuWorkers: Worker[] = [];
    const cpuPorts: MessagePort[] = [];
    for (let i = 0; i < cpu_worker_count; i++) {
      const channel = new MessageChannel();
      const cpuWorker = await startWebworkerReady();
      cpuWorker.postMessage(
        {
          type: "setup",
          role: "cpubound",
          cpu_worker_id: i,
          scan_settings_path: resolvedPath,
          pathPrefix,
        },
        [channel.port1],
      );
      cpuWorker.onerror = (e) => {
        if (handle_error)
          handle_error(
            "cpu worker " + i + " error: " + (e.message ?? String(e)),
          );
      };
      cpuWorkers.push(cpuWorker);
      cpuPorts.push(channel.port2);
    }

    const coordinationWorker = await startWebworkerReady();
    coordinationWorker.postMessage(
      {
        type: "setup",
        scan_settings_path: resolvedPath,
        pathPrefix,
        role: "coordinator",
        node_url,
        start_height: 0,
      },
      cpuPorts,
    ); // transfer CPU port2s to coordination worker
    log("createWebworker", [
      "coordinator worker started, node_url=" + node_url,
      ", cpuPorts=" + cpuPorts.length,
    ]);

    coordinationWorker.onmessage = (event) => {
      if (event.data.type === "ERROR") {
        if (handle_error) handle_error(event.data.payload);
      } else if (event.data.type === "SCAN_RESULT") {
        if (handle_result) handle_result(event.data.payload);
      }
    };

    return {
      fetchWorker: coordinationWorker,
      cpuWorkers,
      terminate: () => {
        for (const p of cpuPorts) {
          p.close();
        }
        coordinationWorker.onmessage = null;
        coordinationWorker.onerror = null;
        for (const w of cpuWorkers) {
          w.onerror = null;
          w.onmessage = null;
        }
        coordinationWorker.terminate();

        for (const w of cpuWorkers) w.terminate();
      },
    };
  } catch (error) {
    handle_error?.(error);
  }
}

export function makeWebworkerScript(): string {
  return workerMainCode;
}
const blob = new Blob([workerMainCode], {
  type: "text/javascript",
});
const url = URL.createObjectURL(blob);

// creates a worker via startWebworker, then waits for it to signal
// WORKER_READY (meaning self.onmessage = handleMessage has executed).
// after that, postMessage is safe, no race between worker startup
// and message delivery.
export function startWebworkerReady(): Promise<Worker> {
  const worker = new Worker(url, { type: "module" });
  return new Promise<Worker>((resolve) => {
    const onReady = (e: MessageEvent) => {
      if (e.data?.type === "WORKER_READY") {
        worker.removeEventListener("message", onReady);
        resolve(worker);
      }
    };
    worker.addEventListener("message", onReady);
  });
}
