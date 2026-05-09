import { coordinatorMainWorker } from "./coordinator-main";
import {
  handleCpuboundScan,
  handleCpuboundScanTry,
  sendFromCpuWorker,
} from "./cpubound-main";

self.onerror = (e) => self.postMessage({ type: "ERROR", payload: e });
self.addEventListener("unhandledrejection", (e) =>
  self.postMessage({ type: "ERROR", payload: e.reason }),
);

let SCAN_SETTINGS_PATH: string | undefined;
let PATH_PREFIX: string | undefined;
let cpuPort: MessagePort | undefined;
export function CPU_PORT_HANDLER(pe: MessageEvent) {
  if (!cpuPort)
    throw new Error("[cpubound] cpuPort is undefined in port.onmessage");
  console.log("[cpubound] new workitem msg received");
  cpuPort.postMessage({
    type: "WORKSTART",
    work_uuid: pe.data.work_uuid,
  });
  handleCpuboundScanTry(pe.data, cpuPort).then((result) => {
    console.log("[cpubound] work finished, sending result");
    if (!cpuPort)
      throw new Error("[cpubound] cpuPort is undefined in port.onmessage");
    cpuPort.onmessage = CPU_PORT_HANDLER;
    sendFromCpuWorker(cpuPort, result);
  });
}
const handleMessage = async (e: MessageEvent) => {
  const msg = e.data;
  console.log("[worker] msg received", msg);

  if (msg.type === "setup") {
    SCAN_SETTINGS_PATH = msg.scan_settings_path;
    PATH_PREFIX = msg.pathPrefix;
    if (msg.role === "cpubound") {
      cpuPort = e.ports[0];
      if (cpuPort) {
        cpuPort.onmessage = CPU_PORT_HANDLER;
        cpuPort.addEventListener("message", (e) => {
          console.log("[cpubound] message received", e);
        });
        cpuPort.addEventListener("messageerror", (e) => {
          console.log("[cpubound] messageerror received", e);
        });
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
