import {
  DistributedKeyGenerator,
  type DkgParticipateParams,
  type DkgVerifyParams,
} from "../../api";
import { log } from "../../io/logging";
export type MultiSigParticipateCall = {
  type: "multisig-call";
  functionName: "participate";
  params: DkgParticipateParams;
};
export type MultiSigVerifyCallMsg = {
  type: "multisig-call";
  functionName: "verify";
  params: DkgVerifyParams;
};
export type MultiSigWorkerCallMsg =
  | MultiSigParticipateCall
  | MultiSigVerifyCallMsg;

export function multisigMainWorkerCall(
  msg: MultiSigWorkerCallMsg,
  dkg?: DistributedKeyGenerator,
) {
  if (!dkg) {
    const error = new Error(
      "multisigMainWorkerCall called without setup DistributedKeyGenerator first",
    );
    console.error("[multisigMainWorkerCall] error:", error);
    log("multisigMainWorkerCall", ["error:", error]);

    self.postMessage({ type: "ERROR", payload: error });
  } else if (msg.type === "multisig-call") {
    const functionName = msg.functionName;
    const params = msg.params;
    log("multisigMainWorkerCall", [
      `received call to ${functionName}() with params:`,
      params,
    ]);

    let result;
    if (functionName === "participate") {
      result = dkg.participateNoThrow(params as DkgParticipateParams);
    } else if (functionName === "verify") {
      result = dkg.verifyNoThrow(params as DkgVerifyParams);
    }
    log("multisigMainWorkerCall", [
      `received call to ${functionName}() with params, got result`,
      params,
      result,
    ]);
    self.postMessage({ type: "multisig-call-result", result });
  }
}
