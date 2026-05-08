import { coordinatorMainWorker } from "./coordinator-main";
import { handleCpuboundScan, handleCpuboundScanTry } from "./cpubound-main";

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
          console.log("[cpubound] new workitem msg received");

          handleCpuboundScan(pe.data, cpuPort);
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
function handleMessageTry(e: MessageEvent) {
  try {
    handleMessage(e);
  } catch (error) {
    console.error("[worker] error:", error);
    self.postMessage({ type: "ERROR", payload: error });
  }
}
self.onmessage = handleMessageTry;

// signal main thread that onmessage handler is installed
self.postMessage({ type: "WORKER_READY" });
