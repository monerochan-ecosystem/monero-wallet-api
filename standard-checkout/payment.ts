import { convertAmountBigInt, tools, type ScannedTransaction } from "@spirobel/monero-wallet-api";
import type { CheckoutSessionRow } from "./db";

export function checkoutMatches(scan: ScannedTransaction, row: CheckoutSessionRow): boolean {
  if (scan.unlock_time !== "0" || (row.tx_hash && row.tx_hash !== scan.tx_hash)) return false;
  let need: bigint;
  try { need = convertAmountBigInt(row.amount); } catch { return false; }
  const paid = scan.outputs.filter((output) => output.payment_id === String(row.id))
    .reduce((sum, output) => sum + BigInt(output.amount), 0n);
  return need > 0n && paid >= need;
}

export function validateAddressRequest(req: Request, row: CheckoutSessionRow | undefined): Promise<Response> {
  return tools["001"].counterparty.validate_route({
    isPayAddressKnown: (address) => !!row?.address && row.address === address,
    getUrls: () => {
      if (!row) return {};
      const { origin, pathname } = new URL(req.url);
      return {
        successUrl: `${origin}/return?checkoutId=${encodeURIComponent(row.session_id)}`,
        handoverUrl: `${origin}${pathname}`,
      };
    },
  })(req);
}
