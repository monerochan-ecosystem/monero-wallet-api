import { convertAmountBigInt, openTrackers, TransactionTracker, ViewPair, type TransactionTrackerState } from "@spirobel/monero-wallet-api";
import { checkoutMatches } from "../standard-checkout/payment";
import { getCheckoutSessionByPrimaryId, getOpenTrackedSessions, saveCheckoutTrackers, type CheckoutSessionRow } from "../standard-checkout/db";

export async function openCheckoutTrackers(
  merchant: { node_url: string; primary_address: string; view_key: string },
  open = openTrackers,
) {
  const view = await ViewPair.create(merchant.primary_address, merchant.view_key);
  const operations = new Map<number, Promise<unknown>>();
  let stopped = false;
  async function queue<T>(id: number, work: () => T | Promise<T>): Promise<T> {
    const pending = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    operations.set(id, pending);
    try { return await pending; }
    finally { if (operations.get(id) === pending) operations.delete(id); }
  }
  const restore = (id: number, saved: string) => {
    const data: TransactionTrackerState = JSON.parse(saved);
    if (data.primary_address !== merchant.primary_address) throw new Error("tracker belongs to another wallet");
    return new TransactionTracker({ ...data, payment_id: id });
  };
  const many = await open({
    node_url: merchant.node_url,
    transactionTrackers: (await getOpenTrackedSessions()).map(({ id, tracker_state }) => restore(id, tracker_state)),
    notify: async (changed) => {
      const states = changed.map(tracker => {
        const data = tracker.data;
        const id = data.payment_id;
        if (id === undefined) throw new Error("checkout state was not saved");
        return { id, data, tracker };
      });
      await saveCheckoutTrackers(states);
      for (const { id, data, tracker } of states) {
        if (data.state === "confirmed" && !stopped) {
          // release after any handover of this row is finished.
          void queue(id, () => release(id, tracker)).catch(error => { console.error("tracker release failed", error); });
        }
      }
    },
    onError: (error) => { console.error("payment tracking failed", error); },
  });

  function findTracker(id: number) {
    return many.transactionTrackers.find(({ data }) => data.payment_id === id);
  }

  function release(id: number, tracker: TransactionTracker) {
    if (tracker.data.state === "confirmed" && findTracker(id) === tracker) {
      many.removeTracker({ payment_id: id, primary_address: merchant.primary_address });
    }
  }

  async function submit(req: Request, id: number) {
    let tx_as_hex: string | undefined;
    try {
      const text = await req.text();
      if (text.length > 2_010_000) throw new Error("request too large");
      const body = JSON.parse(text) as { tx_as_hex?: unknown };
      if (typeof body?.tx_as_hex !== "string") throw new Error("transaction required");
      const row = (await getCheckoutSessionByPrimaryId(id))[0];
      if (!row?.address) return Response.json({ ok: false, error: "unknown checkout" }, { status: 404 });
      tx_as_hex = body.tx_as_hex;

      const active = findTracker(id);
      const existing = active ?? (row.tracker_state ? restore(id, row.tracker_state) : undefined);
      if (existing && (existing.data.tx_as_hex?.toLowerCase() !== tx_as_hex.toLowerCase() ||
          (row.tx_hash && row.tx_hash !== existing.data.tx_hash))) {
        throw new Error("checkout already tracks another transaction");
      }
      if (row.paid_status) {
        if (existing) return Response.json({ ok: true, tx_hash: existing.data.tx_hash });
        // the wallet scanner can mark a checkout paid without a tracker.
        const scan = view.scanTransaction({ tx_as_hex, payment_id: id });
        if (!checkoutMatches(scan, row)) {
          return Response.json({ ok: false, tx_hash: scan.tx_hash, error: "payment rejected" });
        }
        return Response.json({ ok: true, tx_hash: scan.tx_hash });
      }

      const tracker = await many.new(existing ? active ?? many.addTracker(existing) : {
        tx_as_hex,
        view_pair: view,
        payment_id: id,
        invoice_amount: convertAmountBigInt(row.amount),
        merchant_confirmations: row.required_confirmations,
        created_at: Date.parse(row.timestamp.replace(" ", "T") + "Z") || undefined,
      });
      if ("error" in tracker) return Response.json({ ok: false, error: tracker.error });
      release(id, tracker);
      return Response.json({ ok: true, tx_hash: tracker.data.tx_hash });
    } catch (error) {
      const data = findTracker(id)?.data;
      const tx_hash = data?.tx_as_hex !== undefined && data.tx_as_hex.toLowerCase() === tx_as_hex?.toLowerCase()
        ? data.tx_hash : undefined;
      return Response.json({ ok: false, tx_hash, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    makeIntegratedAddress: (paymentId: number) => view.makeIntegratedAddress(paymentId),
    // the full scan and send sequence is one operation for each checkout
    async handoverRequest(req: Request, row: CheckoutSessionRow | undefined): Promise<Response> {
      if (!row?.address) return Response.json({ ok: false, error: "unknown checkout" }, { status: 404 });
      if (req.method !== "POST") return Response.json({ ok: false, error: "POST required" }, { status: 405 });
      return queue(row.id, () => submit(req, row.id));
    },
    async refresh(row: CheckoutSessionRow): Promise<CheckoutSessionRow> {
      if (!row.tracker_state || row.paid_status) return row;
      try { await many.track(); }
      catch (error) { console.error("payment tracking failed", error); }
      return (await getCheckoutSessionByPrimaryId(row.id))[0] ?? row;
    },
    status(row: CheckoutSessionRow): string {
      if (!row.tx_hash) return `Waiting for payment... (0/${row.required_confirmations} confirmations)`;
      if (row.paid_status) return "Payment received";
      const data = row.tracker_state ? JSON.parse(row.tracker_state) as TransactionTrackerState : undefined;
      if (data?.state === "accepted") return `Transaction accepted by node. Waiting for a block (0/${row.required_confirmations} confirmations)`;
      if (data?.state === "in_block") return `Transaction confirming (${row.tx_confirmations}/${row.required_confirmations})`;
      return "Transaction is valid & amount correct.";
    },
    stop: () => { stopped = true; return many.stop(); },
  };
}
