import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import { type CacheChangedCallbackParameters } from "./scanresult/scanCache";
import {
  openScanSettingsFile,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  sleep,
} from "../api";
import { log, setupLoggingPath } from "../io/logging";
import { workerMainCode } from "./worker-entrypoints/worker";
export const CPU_POOL_SIZE = 4;

export type WorkerSet = {
  fetchWorker: Worker;
  cpuWorkers: Worker[];
  // ask coordinator to drain, then kill. timeout falls back to terminate.
  shutdown: (timeoutMs?: number) => Promise<void>;
  terminate: () => void;
  // debug: ask coordinator + each cpu worker to write a heap snapshot
  // in browser: use inspector directly, this is only useful for bun
  dumpHeaps: (dir?: string) => Promise<string[]>;
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
      await sleep(50);
    }

    const coordinationWorker = await startWebworkerReady();
    coordinationWorker.postMessage(
      {
        type: "setup",
        scan_settings_path: resolvedPath,
        pathPrefix,
        role: "coordinator",
      },
      cpuPorts,
    ); // transfer CPU ports to coordination worker
    log("createWebworker", [
      "coordinator worker started, node_url=" + node_url,
      ", cpuPorts=" + cpuPorts.length,
    ]);

    let shutdownResolve: (() => void) | undefined;
    let shuttingDown = false;

    const hardTerminate = () => {
      for (const p of cpuPorts) {
        try {
          p.close();
        } catch {
          // port may already be closed
        }
      }
      coordinationWorker.onmessage = null;
      coordinationWorker.onerror = null;
      for (const w of cpuWorkers) {
        w.onerror = null;
        w.onmessage = null;
        try {
          w.terminate();
        } catch {
          // already dead
        }
      }
      try {
        coordinationWorker.terminate();
      } catch {
        // already dead
      }
    };

    coordinationWorker.onmessage = (event) => {
      if (event.data.type === "ERROR") {
        if (handle_error) handle_error(event.data.payload);
      } else if (event.data.type === "SCAN_RESULT") {
        if (handle_result) handle_result(event.data.payload);
      } else if (event.data.type === "SHUTDOWN_DONE") {
        log("createWebworker", ["SHUTDOWN_DONE received"]);
        shutdownResolve?.();
        shutdownResolve = undefined;
      }
    };

    // wait for one HEAP_SNAPSHOT_DONE / ERROR from a worker
    const waitHeap = (w: Worker, path: string, timeoutMs = 15000) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => {
          w.removeEventListener("message", onMsg);
          reject(new Error("heap snapshot timeout: " + path));
        }, timeoutMs);
        const onMsg = (event: MessageEvent) => {
          if (event.data?.type === "HEAP_SNAPSHOT_DONE") {
            clearTimeout(t);
            w.removeEventListener("message", onMsg);
            resolve(event.data.path || path);
          } else if (event.data?.type === "HEAP_SNAPSHOT_ERROR") {
            clearTimeout(t);
            w.removeEventListener("message", onMsg);
            reject(new Error(String(event.data.error || "heap snapshot failed")));
          }
        };
        w.addEventListener("message", onMsg);
        try {
          w.postMessage({ type: "heap_snapshot", path });
        } catch (err) {
          clearTimeout(t);
          w.removeEventListener("message", onMsg);
          reject(err);
        }
      });

    return {
      fetchWorker: coordinationWorker,
      cpuWorkers,
      // graceful only: abort fetch, cancel cpus, wait. does not terminate.
      shutdown: async (timeoutMs = 5000) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log("createWebworker", ["shutdown start, timeoutMs=", timeoutMs]);
        const done = new Promise<void>((resolve) => {
          shutdownResolve = resolve;
        });
        try {
          coordinationWorker.postMessage({ type: "shutdown" });
        } catch (err) {
          log("createWebworker", ["post shutdown failed", String(err)]);
          return;
        }
        await Promise.race([done, sleep(timeoutMs)]);
      },
      terminate: () => {
        hardTerminate();
      },
      dumpHeaps: async (dir = ".") => {
        const stamp = Date.now();
        const paths: string[] = [];
        const coordPath = `${dir}/coordinator-${stamp}.heapsnapshot`;
        paths.push(await waitHeap(coordinationWorker, coordPath));
        for (let i = 0; i < cpuWorkers.length; i++) {
          const p = `${dir}/cpubound-${i}-${stamp}.heapsnapshot`;
          paths.push(await waitHeap(cpuWorkers[i], p));
        }
        return paths;
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
