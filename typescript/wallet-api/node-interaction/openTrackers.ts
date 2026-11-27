import { LOCAL_NODE_DEFAULT_URL, NodeUrl } from "./nodeUrl";
import type { GetBlock } from "./jsonEndpoints";
import type { ViewPair } from "../viewpair/ViewPair";
import type { ScannedTransaction } from "../viewpair/transactionParsing";

export type TransactionTrackerState = {
  primary_address?: string;
  payment_id?: number;
  merchant_confirmations: number;
  state: "scanned" | "sending" | "accepted" | "in_block" | "confirmed";
  confirmations: number;
  timestamp: number; // state time in unix milliseconds
  tx_hash: string;
  tx_as_hex?: string;
  received_amount?: string;
  search_from_height: number;
  position?: { height: number; hash: string; timestamp?: number };
};

export type TrackedTransaction = {
  tx_hash: string;
  payment_id?: number;
  amount?: bigint;
  confirmations: number;
  state: TransactionTrackerState["state"];
  block_height?: number;
  block_timestamp?: number;
};

export class TransactionTracker {
  constructor(public data: TransactionTrackerState) {}

  public get transaction(): TrackedTransaction {
    const { tx_hash, payment_id, received_amount, confirmations, state, position } = this.data;
    const block = confirmations > 0 ? position : undefined;
    return {
      tx_hash, payment_id, confirmations, state,
      amount: received_amount === undefined ? undefined : BigInt(received_amount),
      block_height: block?.height,
      block_timestamp: block?.timestamp,
    };
  }

  /** apply the blocks checked by the manager. */
  public track(tip: GetBlock, blocks: ReadonlyMap<number, GetBlock>, previousBlock?: GetBlock): void {
    const data = this.data;
    if (data.state === "confirmed") return;
    const top = tip.block_header.height;
    const start = Math.min(top, data.search_from_height);
    const txHash = data.tx_hash.toLowerCase();
    if (!txHash) throw new Error("the tracker has no transaction hash");

    let payment = data.state === "in_block" ? previousBlock : undefined;
    const from = previousBlock ? previousBlock.block_header.height + 1 : start;
    for (let height = from; !payment && height <= top; height++) {
      const block = blocks.get(height);
      if (!block) throw new Error("missing block in tracker range");
      if (block.tx_hashes?.includes(txHash)) payment = block;
    }

    const { height, hash } = (payment ?? tip).block_header;
    const blockTimestamp = payment?.block_header.timestamp;
    const confirmations = payment ? top - height + 1 : 0;
    const state = payment
      ? confirmations >= data.merchant_confirmations ? "confirmed" : "in_block"
      : data.state === "in_block" ? "accepted" : data.state;
    if (data.position?.hash === hash && data.position.height === height && data.position.timestamp === blockTimestamp &&
        data.confirmations === confirmations && data.state === state && data.search_from_height === start) return;
    this.data = {
      ...data, state, confirmations, timestamp: Date.now(), search_from_height: start,
      position: { height, hash, timestamp: blockTimestamp },
    };
  }
}

export type OpenTrackersOptions = {
  node_url?: string;
  transactionTrackers?: (TransactionTracker | TransactionTrackerState)[];
  interval?: number;
  notify?: (trackers: readonly TransactionTracker[]) => void | Promise<void>;
  onError?: (error: Error) => void;
};

type NewTrackerOptions = {
  tx_as_hex: string;
  view_pair: ViewPair;
  payment_id: number;
  invoice_amount: bigint;
  merchant_confirmations: number;
  // when the invoice was created (unix milliseconds). a payment cannot be older than its invoice.
  created_at?: number;
};

export type NewTrackerResult = TransactionTracker | { error: string };

type TrackerStatus = {
  saved: TransactionTrackerState;
  sending?: Promise<TransactionTracker>;
  ready: boolean;
};

export async function openTrackers(options: OpenTrackersOptions = {}) {
  return new Trackers(options);
}

// a new search starts this many blocks below the tip. the payment can already be in one of them,
// or a reorg can move it there.
const SEARCH_BELOW_TIP = 20;
// a block takes two minutes on mainnet. one block per minute is a safe margin when an invoice age becomes a height.
const MS_PER_BLOCK_FOR_AGE = 60_000;

export class Trackers {
  private readonly lifetime = new AbortController();
  private readonly node: NodeUrl;
  private readonly tracker_instances = new Map<TransactionTracker, TrackerStatus>();
  /// prevent an older poll from overwriting a newer result.
  private latestPoll = -Infinity;
  private lastNotifyDone = Promise.resolve();

  constructor(private readonly options: OpenTrackersOptions) {
    this.node = new NodeUrl(options.node_url ?? LOCAL_NODE_DEFAULT_URL);
    const latest = new Map<string | number, { tracker: TransactionTracker | TransactionTrackerState; timestamp: number }>();
    for (const [index, tracker] of (options.transactionTrackers ?? []).entries()) {
      const { primary_address, payment_id, timestamp } = tracker instanceof TransactionTracker ? tracker.data : tracker;
      const key = primary_address === undefined || payment_id === undefined ? index : `${primary_address}:${payment_id}`;
      if ((latest.get(key)?.timestamp ?? -Infinity) > (timestamp ?? -Infinity)) continue;
      latest.set(key, { tracker, timestamp });
    }
    for (const { tracker } of latest.values()) this.addTracker(tracker);
    const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
    // with nothing to follow, the poll makes no node call
    void this.node.pollTip((tip, _signal, startedAt) => this.trackAll(tip, startedAt),
      this.lifetime.signal, options.interval, report,
      () => [...this.tracker_instances].some(([tracker, status]) => this.follows(status, tracker.data))).catch(report);
  }

  public get transactionTrackers(): TransactionTracker[] { return [...this.tracker_instances.keys()]; }

  public addTracker(saved: TransactionTracker | TransactionTrackerState): TransactionTracker {
    this.lifetime.signal.throwIfAborted();
    const tracker = saved instanceof TransactionTracker ? saved : new TransactionTracker(saved);
    if (!this.tracker_instances.has(tracker)) this.tracker_instances.set(tracker, { saved: tracker.data, ready: true });
    return tracker;
  }

  public removeTracker({ payment_id, primary_address }: { payment_id: number; primary_address: string }): void {
    const tracker = this.transactionTrackers.find(({ data }) =>
      data.payment_id === payment_id && data.primary_address === primary_address);
    if (tracker) this.tracker_instances.delete(tracker);
  }

  public async new(payment: NewTrackerOptions | TransactionTracker): Promise<NewTrackerResult> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    let tracker = payment;
    if (!(tracker instanceof TransactionTracker)) {
      const { tx_as_hex, view_pair, payment_id, invoice_amount, merchant_confirmations, created_at } = tracker;
      // an old invoice makes the search start lower
      const ageBlocks = Number.isFinite(created_at) ? Math.max(0, Math.ceil((Date.now() - (created_at ?? 0)) / MS_PER_BLOCK_FOR_AGE)) : 0;
      if (!Number.isSafeInteger(merchant_confirmations) || merchant_confirmations < 0) {
        throw new Error("required merchant confirmations must be zero or a positive safe integer");
      }
      if (!Number.isSafeInteger(payment_id) || payment_id < 0) {
        throw new Error("payment ID must be a non-negative safe integer");
      }
      if (typeof invoice_amount !== "bigint" || invoice_amount <= 0n) {
        throw new Error("invoice amount must be a positive bigint");
      }
      let scan: ScannedTransaction;
      try {
        scan = view_pair.scanTransaction({ tx_as_hex, payment_id });
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      const { tx_hash, received_amount, outputs } = scan;
      if (!outputs.length) return { error: "transaction does not pay the expected payment ID" };
      if (received_amount === undefined || received_amount < invoice_amount) {
        return { error: "payment is below the invoice amount" };
      }
      const { height } = await this.node.getInfo(signal);
      signal.throwIfAborted();
      tracker = new TransactionTracker({
        tx_as_hex, tx_hash: tx_hash.toLowerCase(), primary_address: view_pair.primary_address,
        payment_id, merchant_confirmations, received_amount: received_amount.toString(),
        state: "scanned", confirmations: 0, timestamp: Date.now(), search_from_height: Math.max(0, height - 1 - Math.max(SEARCH_BELOW_TIP, ageBlocks)),
      });
      this.tracker_instances.set(tracker, { saved: tracker.data, ready: false });
    }

    const status = this.tracker_instances.get(tracker);
    if (!status) throw new Error("tracker is not open");
    if (status.sending) return status.sending;
    const { tx_as_hex, state } = tracker.data;
    if (state !== "scanned" && state !== "sending") return tracker;
    status.sending = (async () => {
      if (!tx_as_hex) throw new Error("the tracker has no signed transaction");
      tracker.data = { ...tracker.data, state: "sending", timestamp: Date.now() };
      await this.notifyChanges([tracker]);
      if (this.tracker_instances.get(tracker) !== status) throw new Error("tracker was removed before broadcast");
      signal.throwIfAborted();
      status.ready = true;

      const result = await this.node.sendRawTransaction(tx_as_hex, false, signal);
      if (tracker.data.state === "sending") {
        if (result.status === "OK") {
          const confirmed = tracker.data.merchant_confirmations === 0;
          tracker.data = {
            ...tracker.data, state: confirmed ? "confirmed" : "accepted", timestamp: Date.now(),
            position: confirmed ? undefined : tracker.data.position,
          };
        } else if (state === "scanned") tracker.data = { ...tracker.data, state, timestamp: Date.now() };
      }
      await this.notifyChanges([tracker]);
      if (result.status !== "OK") throw new Error(result.double_spend ? "transaction double spend" : result.reason || "transaction not accepted by node");
      return tracker;
    })().finally(() => {
      status.sending = undefined;
      if (!status.ready && this.tracker_instances.get(tracker) === status) this.tracker_instances.delete(tracker);
    });
    return status.sending;
  }

  public async track(): Promise<void> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    if (!this.tracker_instances.size) return;
    const startedAt = performance.now();
    const { height, top_block_hash } = await this.node.getInfo(signal);
    const tip = await this.node.getCachedBlock({ height: height - 1, expected_hash: top_block_hash.toLowerCase() }, signal);
    if (!tip) throw new Error("the chain changed during the read");
    await this.trackAll(tip, startedAt);
  }

  public async stop(): Promise<void> {
    this.lifetime.abort(new Error("transaction trackers are stopped"));
  }

  // a tracker follows the chain once its send started, until it is confirmed
  private follows(status: TrackerStatus, data: TransactionTrackerState): boolean {
    return status.ready && data.state !== "scanned" && data.state !== "confirmed";
  }

  private async trackAll(tip: GetBlock, startedAt = performance.now()): Promise<void> {
    if (startedAt < this.latestPoll) return;
    this.latestPoll = startedAt;
    const top = tip.block_header.height;
    const active: { tracker: TransactionTracker; data: TransactionTrackerState; previousBlock?: GetBlock }[] = [];
    let lowest = top;
    for (const [tracker, status] of this.tracker_instances) {
      const data = tracker.data;
      if (!this.follows(status, data)) continue;
      lowest = Math.min(lowest, data.position?.height ?? data.search_from_height);
      active.push({ tracker, data });
    }

    const blocks = new Map([[top, tip]]);
    let first = tip;
    // extend the shared block range back to this height and check each parent link.
    const readBlocksBackTo = async (height: number) => {
      while (first.block_header.height > height) {
        const { height: childHeight, prev_hash } = first.block_header;
        const hash = prev_hash.toLowerCase();
        const parent = await this.node.getCachedBlock({ height: childHeight - 1, expected_hash: hash }, this.lifetime.signal);
        if (!parent || parent.block_header.hash !== hash) throw new Error("the chain changed during the read");
        blocks.set(parent.block_header.height, parent);
        first = parent;
      }
    };
    await readBlocksBackTo(lowest);

    for (const current of active) {
      const { position, search_from_height } = current.data;
      const block = position && blocks.get(position.height);
      if (block && block.block_header.hash === position?.hash.toLowerCase()) {
        current.previousBlock = block;
      } else {
        lowest = Math.min(lowest, search_from_height);
      }
    }
    await readBlocksBackTo(lowest);

    this.lifetime.signal.throwIfAborted();
    if (startedAt !== this.latestPoll) return;
    for (const { tracker, data, previousBlock } of active) {
      if (this.tracker_instances.has(tracker) && tracker.data === data) tracker.track(tip, blocks, previousBlock);
    }
    await this.notifyChanges([...this.tracker_instances].filter(([, status]) => status.ready).map(([tracker]) => tracker));
  }

  private notifyChanges(trackers: readonly TransactionTracker[]): Promise<void> {
    const newNotifyPromise = this.lastNotifyDone.then(async () => {
      const changed = trackers.flatMap(tracker => {
        const status = this.tracker_instances.get(tracker);
        return status && status.saved !== tracker.data ? [{ tracker, status, data: tracker.data }] : [];
      });
      if (!changed.length) return;
      await this.options.notify?.(changed.map(({ tracker }) => tracker));
      for (const { status, data } of changed) status.saved = data;
    });
    this.lastNotifyDone = newNotifyPromise.catch(() => {});
    return newNotifyPromise;
  }
}
