import { log } from "../io/logging";
import { startWebworkerReady } from "../scanning-syncing/backgroundWorker";
import type {
  DkgErrorResponse,
  DkgParticipateParams,
  DkgParticipateResult,
  DkgVerifyParams,
  DkgVerifyResult,
  DkgVerifyValidResult,
} from "./DistributedKeyGenerator";

export class MultiSig {
  private worker?: Worker = undefined;

  /**
   * set up a distributed key generator with t threshold and n total participants
   * @param t  - total number of multisig participants
   * @param n  - threshold to sign a transaction
   * @returns  - Promise<DistributedKeyGenerator>
   */
  public static async createAndSetupGenerators(
    t: number,
    n: number,
  ): Promise<MultiSig> {
    const dkg = new MultiSig();
    await dkg.startWorker(t, n);
    return dkg;
  }

  public stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }
  }
  public async startWorker(t: number, n: number): Promise<void> {
    if (!this.worker) {
      this.worker = await startWebworkerReady();
      const that = this;
      const result_promise = new Promise<void>((resolve) => {
        if (!that.worker) {
          resolve();
          return;
        }
        that.worker.onmessage = (e: MessageEvent) => {
          const msg = e.data;
          if (msg.type === "multisig-ready") {
            resolve();
          } else {
            handleUnknownMessage(msg, "startWorker");
          }
        };
        that.worker.postMessage({
          type: "setup",
          t,
          n,
          role: "multisig",
        });
      });
      return await result_promise;
    } else {
      this.stopWorker();
      this.startWorker(t, n);
    }
  }

  /**
   * participate in a DKG round (nothrow).
   *
   * @param params dkg_secret_key as 64-byte hex string, context, dkg_public_keys array (length is n implicitly), t (threshold)
   * @returns The participation message as hex, or an error object
   */
  public participateNoThrow(
    params: DkgParticipateParams,
  ): Promise<DkgParticipateResult | DkgErrorResponse> {
    const msg = { type: "multisig-call", functionName: "participate", params };
    const that = this;
    const result_promise = new Promise<DkgParticipateResult | DkgErrorResponse>(
      (resolve) => {
        if (!that.worker) {
          handleNoWorkerButMethodCalled("participate");
          return;
        }
        that.worker.onmessage = (e: MessageEvent) => {
          const msg = e.data;
          if (msg.type === "multisig-call-result") {
            resolve(msg.result);
          } else {
            handleUnknownMessage(msg, "participate");
          }
        };
        that.worker.postMessage(msg);
      },
    );
    return result_promise;
  }

  /**
   * verify DKG participations and extract the group key (nothrow).
   *
   * @param params dkg_secret_key as 64-byte hex string, context, t (threshold), dkg_public_keys array (length is n implicitly),
   *  participations [ paricipant index -> hex participation message ]
   * @returns The group key and params, faulty participants, not-enough message, or error
   */
  public verifyNoThrow(
    params: DkgVerifyParams,
  ): Promise<DkgVerifyResult | DkgErrorResponse> {
    const msg = { type: "multisig-call", functionName: "verify", params };
    const that = this;
    const result_promise = new Promise<DkgVerifyResult | DkgErrorResponse>(
      (resolve) => {
        if (!that.worker) {
          handleNoWorkerButMethodCalled("participate");
          return;
        }
        that.worker.onmessage = (e: MessageEvent) => {
          const msg = e.data;
          if (msg.type === "multisig-call-result") {
            resolve(msg.result);
          } else {
            handleUnknownMessage(msg, "participate");
          }
        };
        that.worker.postMessage(msg);
      },
    );
    return result_promise;
  }

  /**
   * participate in a DKG round (throws on error).
   */
  public async participate(
    params: DkgParticipateParams,
  ): Promise<DkgParticipateResult> {
    const result = await this.participateNoThrow(params);
    if ("message" in result) {
      throw new Error(`participate failed: ${result.message}`);
    }
    return result;
  }

  /**
   * verify DKG participations and extract the group key (throws on error).
   */
  public async verify(params: DkgVerifyParams): Promise<DkgVerifyValidResult> {
    const result = await this.verifyNoThrow(params);
    if ("message" in result) {
      throw new Error(`verify failed: ${result.message}`);
    }
    if ("faulty_participants" in result) {
      throw new Error(`verify failed: ${result.faulty_participants}`);
    }
    return result;
  }
}

function handleUnknownMessage(msg: any, functionName: string) {
  log("multisig", [`${functionName}(): unknown message type:  ${msg.type}`]);
  throw new Error(
    `[multisig] ${functionName}(): unknown message type:  ${msg.type}`,
  );
}

function handleNoWorkerButMethodCalled(functionName: string) {
  log("multisig", [`${functionName}(): no worker`]);
  throw new Error(`[multisig] ${functionName}(): no worker`);
}
