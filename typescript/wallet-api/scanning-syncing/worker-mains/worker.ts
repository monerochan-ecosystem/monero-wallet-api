import { coordinatorMainWorker } from "./coordinator-main";
import { handleCpuboundScanTry, sendFromCpuWorker } from "./cpubound-main";
import { log, setupLoggingPath } from "../../io/logging";
import { SCAN_SETTINGS_STORE_NAME_DEFAULT } from "../scanSettings";
import { multisigMainWorkerCall } from "./multisig-main";
import { DistributedKeyGenerator } from "../../api";

self.onerror = (e) => self.postMessage({ type: "ERROR", payload: e });
self.addEventListener("unhandledrejection", (e) =>
  self.postMessage({ type: "ERROR", payload: e.reason }),
);

let SCAN_SETTINGS_PATH: string | undefined;
let PATH_PREFIX: string | undefined;
let cpuPort: MessagePort | undefined;
let multisig_dkg: DistributedKeyGenerator | undefined;
export function CPU_PORT_HANDLER(pe: MessageEvent) {
  if (!cpuPort)
    throw new Error("[cpubound] cpuPort is undefined in port.onmessage");
  log("CPU_PORT_HANDLER", "new workitem msg received");
  cpuPort.postMessage({
    type: "WORKSTART",
    work_uuid: pe.data.work_uuid,
  });
  handleCpuboundScanTry(pe.data, cpuPort).then((result) => {
    log("CPU_PORT_HANDLER", "work finished, sending result");
    if (!cpuPort)
      throw new Error("[cpubound] cpuPort is undefined in port.onmessage");
    cpuPort.onmessage = CPU_PORT_HANDLER;
    sendFromCpuWorker(cpuPort, result);
  });
}
const handleMessage = async (e: MessageEvent) => {
  const msg = e.data;
  log("handleMessage", ["msg received", msg]);

  if (msg.type === "setup") {
    const settingsPath =
      msg.scan_settings_path || SCAN_SETTINGS_STORE_NAME_DEFAULT;
    SCAN_SETTINGS_PATH = settingsPath;
    PATH_PREFIX = msg.pathPrefix;
    await setupLoggingPath(
      settingsPath,
      msg.pathPrefix ?? "",
      msg.role,
      msg.cpu_worker_id,
    );
    if (msg.role === "cpubound") {
      cpuPort = e.ports[0];
      if (cpuPort) {
        cpuPort.onmessage = CPU_PORT_HANDLER;
        cpuPort.addEventListener("message", (e) => {
          log("handleMessage", ["message received", e]);
        });
        cpuPort.addEventListener("messageerror", (e) => {
          log("handleMessage", ["messageerror received", e]);
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
    } else if (msg.role === "multisig") {
      DistributedKeyGenerator.createAndSetupGenerators(msg.t, msg.n).then(
        (dkg) => {
          multisig_dkg = dkg;
          self.postMessage({ type: "multisig-ready" });
        },
      );
    }
  } else if (msg.type === "multisig-call") {
    multisigMainWorkerCall(msg, multisig_dkg);
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
