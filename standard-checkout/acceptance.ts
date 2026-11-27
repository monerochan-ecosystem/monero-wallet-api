import { convertAmountBigInt, tools, type FoundTransaction, type TransactionStatus } from "@spirobel/monero-wallet-api";
import { releaseTxHash, updateTransactionStatus, updateTxHash, type CheckoutSessionRow } from "./db";

import { checkoutMatches } from "./payment";
export { checkoutMatches, validateAddressRequest } from "./payment";

type Merchant = Omit<Parameters<typeof tools["001"]["counterparty"]["execute_route"]>[0], "checkPayment">;
const handovers = new Map<number, { active: number; retain: boolean }>();

// an unanswered submission can still be found by the wallet scan.
export async function handoverRequest(req: Request, row: CheckoutSessionRow | undefined, merchant: Merchant): Promise<Response> {
  if (!row?.address) return Response.json({ ok: false, error: "unknown checkout" }, { status: 404 });
  let txHash: string | undefined;
  let pending: { active: number; retain: boolean } | undefined;
  try {
    const response = await tools["001"].counterparty.execute_route({
      ...merchant,
      checkPayment: async (scan) => {
        if (!checkoutMatches(scan, row)) return false;
        if (!(await updateTxHash(row.id, scan.tx_hash)).length) return false;
        txHash = scan.tx_hash;
        pending = handovers.get(row.id) ?? { active: 0, retain: !!row.tx_hash };
        pending.active++;
        handovers.set(row.id, pending);
        return true;
      },
    })(req);
    const result = await response.clone().json() as { ok?: boolean; submission_unknown?: boolean };
    if (pending && (result.ok || result.submission_unknown)) pending.retain = true;
    return response;
  } catch (error) {
    if (pending) pending.retain = true;
    throw error;
  } finally {
    if (pending && --pending.active === 0) {
      handovers.delete(row.id);
      if (!pending.retain && txHash) await releaseTxHash(row.id, txHash);
    }
  }
}

export async function syncWalletPayments(rows: CheckoutSessionRow[], transactions: FoundTransaction[]) {
  const incoming = new Map<number, FoundTransaction[]>();
  for (const tx of transactions) {
    if (tx.confirmations < 1 || tx.amount <= 0n) continue;
    for (const id of new Set(tx.outputs.map(output => output.payment_id))) {
      const group = incoming.get(id);
      if (group) group.push(tx);
      else incoming.set(id, [tx]);
    }
  }
  for (const row of rows) {
    if (!row.address) continue;
    const payment = incoming.get(row.id)?.find(tx => {
      if (row.tx_hash && row.tx_hash !== tx.tx_hash) return false;
      const received = tx.outputs.filter(output => output.payment_id === row.id && output.burned === undefined)
        .reduce((sum, output) => sum + output.amount, 0n);
      return received >= convertAmountBigInt(row.amount);
    });
    if (!payment) {
      if (row.tx_hash && row.tx_block_height !== null) await updateTransactionStatus(row.id, row.tx_hash, null);
      continue;
    }
    const height = payment.outputs[0]!.block_height;
    if (row.tx_hash === payment.tx_hash && row.tx_confirmations === payment.confirmations && row.tx_block_height === height) continue;
    if (!row.tx_hash && !(await updateTxHash(row.id, payment.tx_hash)).length) continue;
    await updateTransactionStatus(row.id, payment.tx_hash, {
      in_pool: false, confirmations: payment.confirmations, block_height: height,
    });
  }
}

export function storedStatus(row: CheckoutSessionRow): TransactionStatus | null {
  if (!row.tx_hash || row.tx_block_height === null) return null;
  return { in_pool: false, confirmations: row.tx_confirmations, block_height: row.tx_block_height };
}

export function statusMessage(row: CheckoutSessionRow, status: TransactionStatus | null): string {
  if (row.paid_status) return "Payment received";
  if (!row.tx_hash) return `Waiting for payment... (0/${row.required_confirmations} confirmations)`;
  if (!status) return "Transaction is valid & amount correct.";
  if (status.in_pool) return "Transaction is valid & amount correct.";
  if (status.confirmations >= row.required_confirmations) return "Payment received";
  return `Transaction confirming (${status.confirmations}/${row.required_confirmations})`;
}
