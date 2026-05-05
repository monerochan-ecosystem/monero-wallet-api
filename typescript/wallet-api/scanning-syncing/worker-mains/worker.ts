import { coordinatorMainWorker } from "./coordinator-main";
import { handleCpuboundScan } from "./cpubound-main";

self.onerror = (e) => self.postMessage({ type: "ERROR", payload: e });
self.addEventListener("unhandledrejection", (e) =>
  self.postMessage({ type: "ERROR", payload: e.reason }),
);

let SCAN_SETTINGS_PATH: string | undefined;
let PATH_PREFIX: string | undefined;
let cpuPort: MessagePort | undefined;

const handleMessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "setup") {
    SCAN_SETTINGS_PATH = msg.scan_settings_path;
    PATH_PREFIX = msg.pathPrefix;
    if (msg.role === "cpubound") {
      cpuPort = e.ports[0];
      if (cpuPort) {
        cpuPort.onmessage = (pe: MessageEvent) => {
          if (pe.data.type === "scan") {
            handleCpuboundScan(pe.data, cpuPort);
          }
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
