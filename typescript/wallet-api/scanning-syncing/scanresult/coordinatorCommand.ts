import type { SendRawTransactionResult } from "../../node-interaction/jsonEndpoints";
import type { ExtensionMessageByKind } from "../../tools/globals";
import type { CreateTransactionParams, ScanCacheOpened, SignedSend } from "./scanCacheOpened";
import type { TxCacheWriteMessage } from "./scanCache";
import type { WalletConfigPlusCache } from "./scanCoordination";

/**
 * the coordinator command bus. it connects the wallets of an mco instance with the coordinator worker thread.
 * a command is a named request like makeSignSend or releaseInputs. it never carries a raw tx log write.
 *
 * wallet side: callCoordinator from createCoordinatorCommandSender posts one command with a reply port.
 * it waits for { result } or { error }. a { beforeBroadcast: true } message in between runs the broadcast callback.
 *
 * coordinator side: worker.ts puts each command into the queue (queueCoordinatorCommand). the scan loop takes it
 * between scan steps and calls the handler of createCoordinatorCommandHandler. the handler checks the wallet. for a
 * send, rebroadcast, release, renew, or a draft once it is saved, it also checks that no other of these runs on the
 * same tx log row. recordHandoverAcceptance and dismissSendPlate skip that check: 001 records the merchant
 * acceptance while its send still runs. executeCoordinatorCommand then opens a copy of the wallet
 * in the coordinator and calls the same public method. there callCoordinator returns nothing, so the method body
 * runs. its tx log writes go back into the queue, so the scan loop stays the one writer of the cache file.
 */

// a command that an outer wallet sends to the coordinator. the coordinator runs it on its own wallet instance.
export type CoordinatorCommands = {
  makeSignTransaction: CreateTransactionParams;
  makeSignSendTransaction: CreateTransactionParams;
  makeSignSend: Omit<ExtensionMessageByKind["worker.makeSignSend"], "primary_address">;
  sendSignedTransaction: { signed: SignedSend; invocationId?: string };
  sweepSignSend: Omit<ExtensionMessageByKind["worker.sweepSignSend"], "primary_address">;
  rebroadcastTx: { txLogIndex: number };
  releaseInputs: { txLogIndex: number };
  dismissSendPlate: { txLogIndex?: number };
  renewTransactionLock: { txLogIndex: number; clearFailure: boolean };
  recordHandoverAcceptance: { txLogIndex: number };
};

type SendResult = SendRawTransactionResult & { cache_error?: string };

export type CoordinatorResults = {
  makeSignTransaction: SignedSend;
  makeSignSendTransaction: SendResult;
  makeSignSend: SendResult;
  sendSignedTransaction: SendResult;
  sweepSignSend: SendResult;
  rebroadcastTx: SendResult;
  releaseInputs: void;
  dismissSendPlate: void;
  renewTransactionLock: void;
  recordHandoverAcceptance: void;
};

export type CoordinatorCommand<K extends keyof CoordinatorCommands = keyof CoordinatorCommands> = {
  [P in K]: {
    kind: P;
    params: CoordinatorCommands[P];
    primary_address: string;
    decoySampleCount: number;
    decoyRetry: boolean;
    decoyRetrySizes: number[];
    beforeBroadcast?: boolean;
  };
}[K];

export type CoordinatorCommandMessage = { type: "coordinator_command"; command: CoordinatorCommand };
type CoordinatorCommandEvent = MessageEvent<CoordinatorCommandMessage>;
// the scan loop takes these in arrival order: commands of outer wallets, and the tx log writes of running commands.
// a write goes through the scan loop, so the wallet cache and its file have one writer.
const coordinatorCommands: (CoordinatorCommandEvent | { write: MessageEvent<TxCacheWriteMessage>; onSaved?: (txLogIndex: number) => void })[] = [];
let coordinatorCommandReady = Promise.withResolvers<{ src: "coordinator_command" }>();

export function queueCoordinatorCommand(event: CoordinatorCommandEvent) {
  coordinatorCommands.push(event);
  coordinatorCommandReady.resolve({ src: "coordinator_command" });
}

export function waitForCoordinatorCommands() {
  return coordinatorCommandReady.promise;
}

export function* drainCoordinatorCommands() {
  if (coordinatorCommands.length === 0) return;
  while (coordinatorCommands.length) yield coordinatorCommands.shift()!;
  coordinatorCommandReady = Promise.withResolvers();
}

function beforeBroadcast(port: MessagePort, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const stop = () => reject(new Error("scanner stopped before broadcast"));
    signal?.addEventListener("abort", stop, { once: true });
    port.onmessage = ({ data }) => {
      signal?.removeEventListener("abort", stop);
      if ("error" in data) reject(new Error(data.error));
      else resolve();
    };
    port.postMessage({ beforeBroadcast: true });
  });
}

async function executeCoordinatorCommand(
  event: CoordinatorCommandEvent,
  wallet: WalletConfigPlusCache,
  onDraftSaved: (txLogIndex: number) => void,
  createWallet: typeof ScanCacheOpened.create,
  scanSettingsPath?: string,
  pathPrefix?: string,
  signal?: AbortSignal,
) {
  const { command } = event.data;
  const port = event.ports[0]!;
  const opened = await createWallet({
    primary_address: wallet.primary_address,
    scan_settings_path: scanSettingsPath,
    pathPrefix,
    no_worker: true,
    no_stats: true,
    cacheWriter: {
      write: async (message) => {
        signal?.throwIfAborted();
        const index = await new Promise<number>((resolve, reject) => {
          const { port1, port2 } = new MessageChannel();
          const close = () => {
            signal?.removeEventListener("abort", stop);
            port1.close();
          };
          const stop = () => {
            close();
            reject(new Error("scanner stopped before the cache write completed"));
          };
          port1.onmessage = ({ data }) => {
            close();
            if ("error" in data) reject(new Error(data.error));
            else resolve(data.txLogIndex);
          };
          signal?.addEventListener("abort", stop, { once: true });
          coordinatorCommands.push({
            write: new MessageEvent("message", { data: message, ports: [port2] }),
            onSaved: message.txLogIndex === undefined && message.txLog ? onDraftSaved : undefined,
          });
          coordinatorCommandReady.resolve({ src: "coordinator_command" });
        });
        await opened.feed({ newCache: wallet.cache, changed_outputs: [] });
        return index;
      },
    },
  });
  await opened.feed({ newCache: wallet.cache, changed_outputs: [] });
  opened.decoySampleCount = command.decoySampleCount;
  opened.decoyRetry = command.decoyRetry;
  opened.decoyRetrySizes.splice(0, opened.decoyRetrySizes.length, ...command.decoyRetrySizes);
  signal?.throwIfAborted();
  switch (command.kind) {
    case "makeSignTransaction": return opened.makeSignTransaction(command.params);
    case "makeSignSendTransaction": return opened.makeSignSendTransaction(command.params);
    case "makeSignSend": return opened.makeSignSend(command.params);
    case "sendSignedTransaction": return opened.sendSignedTransaction(
      command.params.signed,
      command.params.invocationId,
      command.beforeBroadcast ? () => beforeBroadcast(port, signal) : undefined,
    );
    case "sweepSignSend": return opened.sweepSignSend(command.params);
    case "rebroadcastTx": return opened.rebroadcastTx(command.params.txLogIndex);
    case "releaseInputs": return opened.releaseInputs(command.params.txLogIndex);
    case "dismissSendPlate": return opened.dismissSendPlate(command.params.txLogIndex);
    case "renewTransactionLock": return opened.renewTransactionLock(command.params.txLogIndex, command.params.clearFailure);
    case "recordHandoverAcceptance": return opened.recordHandoverAcceptance(command.params.txLogIndex);
  }
}

export function createCoordinatorCommandHandler({
  wallets,
  createWallet,
  scanSettingsPath,
  pathPrefix,
  signal,
}: {
  wallets: WalletConfigPlusCache[];
  createWallet: typeof ScanCacheOpened.create;
  scanSettingsPath?: string;
  pathPrefix?: string;
  signal?: AbortSignal;
}) {
  const activeCommands = new Map<string, CoordinatorCommandEvent>();

  return (event: CoordinatorCommandEvent) => {
    const { command } = event.data;
    const replyPort = event.ports[0]!;
    const wallet = wallets.find((wallet) => wallet.primary_address === command.primary_address);
    const index = command.kind === "sendSignedTransaction" ? command.params.signed.txLogIndex
      : command.kind === "rebroadcastTx" || command.kind === "releaseInputs" || command.kind === "renewTransactionLock" ? command.params.txLogIndex
      : undefined;
    let key = index === undefined ? undefined : `${command.primary_address}:${index}`;
    if (!wallet || (key !== undefined && activeCommands.has(key))) {
      replyPort.postMessage({ error: wallet ? "coordinator command already active" : "wallet not found" });
      replyPort.close();
      return;
    }
    if (key !== undefined) activeCommands.set(key, event);
    const onDraftSaved = (txLogIndex: number) => {
      key = `${command.primary_address}:${txLogIndex}`;
      activeCommands.set(key, event);
    };
    // the command waits for its saves while the scan loop keeps running
    executeCoordinatorCommand(event, wallet, onDraftSaved, createWallet, scanSettingsPath, pathPrefix, signal)
      .then(
        (result) => replyPort.postMessage({ result }),
        (error) => replyPort.postMessage({ error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        if (key !== undefined) activeCommands.delete(key);
        replyPort.close();
      });
  };
}

export function createCoordinatorCommandSender(
  postCommand: (message: CoordinatorCommandMessage, port: MessagePort) => void,
  isStopping: () => boolean,
) {
  const pending = new Set<() => void>();

  function callCoordinator<K extends keyof CoordinatorCommands>(
    command: CoordinatorCommand<K>,
    beforeBroadcast?: () => void,
  ): Promise<CoordinatorResults[K]> {
    if (isStopping()) return Promise.reject(new Error("scanner is stopping"));
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      const close = () => {
        pending.delete(cancel);
        port1.close();
        port2.close();
      };
      const cancel = () => {
        close();
        reject(new Error("scanner stopped before the coordinator command completed"));
      };
      pending.add(cancel);
      port1.onmessage = async ({ data }) => {
        if (data.beforeBroadcast === true) {
          try {
            if (!beforeBroadcast) throw new Error("missing broadcast callback");
            await beforeBroadcast();
            port1.postMessage({ ok: true });
          } catch (error) {
            port1.postMessage({ error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        close();
        if ("error" in data) reject(new Error(data.error));
        else resolve(data.result);
      };
      try {
        postCommand({
          type: "coordinator_command",
          command: { ...command, beforeBroadcast: beforeBroadcast !== undefined } as CoordinatorCommand,
        }, port2);
      } catch (error) {
        close();
        reject(error);
      }
    });
  }

  return {
    callCoordinator,
    cancelPending() {
      for (const cancel of pending) cancel();
    },
  };
}
