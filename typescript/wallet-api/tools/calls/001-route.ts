import { ViewPair } from "../../viewpair/ViewPair";
import type { ScannedTransaction } from "../../viewpair/transactionParsing";

type PaymentRouteOptions = {
  node_url: string;
  primary_address: string;
  view_key: string;
  subaddresses?: [number, number][];
  checkPayment: (scan: ScannedTransaction, req: Request) => boolean | Promise<boolean>;
  // the node has the transaction
  onAccepted?: (scan: ScannedTransaction, req: Request) => void | Promise<void>;
};

export function execute_route(options: PaymentRouteOptions): (req: Request) => Promise<Response> {
  let scanner: Promise<ViewPair> | undefined;
  return async (req) => {
    if (req.method !== "POST") return Response.json({ ok: false, error: "POST required" }, { status: 405 });
    const node = options.node_url.replace(/\/$/, "");
    let tx_hash: string | undefined;
    let tx_as_hex = "";
    let submissionUnknown = false;
    try {
      const text = await req.text();
      if (text.length > 2_010_000) throw new Error("request too large");
      const body = JSON.parse(text) as { tx_as_hex?: unknown };
      if (typeof body.tx_as_hex !== "string") throw new Error("transaction required");
      tx_as_hex = body.tx_as_hex;
      scanner ??= (async () => {
        const view = await ViewPair.create(options.primary_address, options.view_key);
        view.registerScanSubaddresses(options.subaddresses ?? []);
        return view;
      })().catch((error) => {
        scanner = undefined;
        throw error;
      });
      const scan = (await scanner).scanTransaction({ tx_as_hex });
      tx_hash = scan.tx_hash;
      if (!(await options.checkPayment(scan, req))) return Response.json({ ok: false, tx_hash, error: "payment rejected" });
      // the node answers OK for a new transaction, and also for one that it has already in its pool or in a block.
      // so the OK is the acceptance. a lookup would name the transaction to the node,
      // and a restricted node does not show a pool transaction that it did not relay yet.
      submissionUnknown = true;
      const response = await fetch(`${node}/send_raw_transaction`, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
        body: JSON.stringify({ tx_as_hex }), signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`node returned ${response.status}`);
      const result = await response.json() as { status?: string; reason?: string; double_spend?: boolean };
      if (typeof result.status !== "string") throw new Error("invalid node submission response");
      if (result.status !== "OK") {
        submissionUnknown = false;
        throw new Error(result.double_spend ? "transaction double spend" : result.reason || "transaction not accepted by node");
      }
      await options.onAccepted?.(scan, req);
      return Response.json({ ok: true, tx_hash });
    } catch (e) {
      // the hash is reported once the scan succeeded, so the payer can retry the same transaction.
      return Response.json({ ok: false, tx_hash, error: e instanceof Error ? e.message : String(e),
        ...(submissionUnknown ? { submission_unknown: true } : {}) });
    }
  };
}

