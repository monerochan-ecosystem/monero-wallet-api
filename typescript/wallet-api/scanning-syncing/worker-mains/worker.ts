import { coordinatorMainWorker } from "./coordinator-main";
import { handleCpuboundScan } from "./cpubound-main";

self.onerror = (e) => self.postMessage({ type: "ERROR", payload: e });
self.addEventListener("unhandledrejection", (e) =>
  self.postMessage({ type: "ERROR", payload: e.reason }),
);

let SCAN_SETTINGS_PATH: string | undefined;
let PATH_PREFIX: string | undefined;
let cpuPort: MessagePort | undefined;
let current_cpu_work_uuid: string | undefined;

const handleMessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "setup") {
    SCAN_SETTINGS_PATH = msg.scan_settings_path;
    PATH_PREFIX = msg.pathPrefix;
    if (msg.role === "cpubound") {
      cpuPort = e.ports[0];
      if (cpuPort) {
        cpuPort.onmessage = async (pe: MessageEvent) => {
          if (current_cpu_work_uuid)
            throw new Error(
              "[cpubound] cpu busy, contract says you need to wait for result, this is a bug.",
            );
          current_cpu_work_uuid = pe.data.work_uuid;
          await handleCpuboundScan(pe.data, cpuPort);
          current_cpu_work_uuid = undefined;
        };
      }
    } else if (msg.role === "coordinator") {
      const cpuPorts = [...e.ports];
      coordinatorMainWorker(SCAN_SETTINGS_PATH, PATH_PREFIX, cpuPorts).catch(
        (err: any) => {
          self.postMessage({
            type: "ERROR",
            payload: err?.message ?? String(err),
          });
        },
      );
    }
  }
};
self.onmessage = handleMessage;

// signal main thread that onmessage handler is installed
self.postMessage({ type: "WORKER_READY" });
