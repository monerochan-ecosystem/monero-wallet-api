import { openWallets, tools } from "@spirobel/monero-wallet-api";
import { checkoutPage, instanceInfo, paymentStatusPage, skeleton, styledNotice, walletInfoPage } from "./page";
import { createCheckoutSession, getCheckoutSessionByAddress, getAllCheckoutSessions, getCheckoutSessionBySessionId, updateCheckoutSessionAddress } from "./db";
import { handoverRequest, statusMessage, storedStatus, syncWalletPayments, validateAddressRequest } from "./acceptance";

export const WALLET_CACHES_DIR = "wallet-caches";
export const SCAN_SETTINGS_PATH = WALLET_CACHES_DIR + "/ScanSettings.json";
let ready = false;
let scanFailed = false;
let syncFailed = false;
let paymentSync = Promise.resolve();
const wallets = await openWallets({
  scan_settings_path: SCAN_SETTINGS_PATH,
  notifyMasterChanged: async () => {
    scanFailed = false;
    if (ready) await syncPaymentStatus();
  },
  workerError: () => { scanFailed = true; },
  autoRetry: true,
});
ready = true;

// this checkout keeps scanning, so payments from wallets without handover still work.
function syncPaymentStatus() {
  // save scan updates in order so a prior snapshot cannot overwrite a reorg.
  paymentSync = paymentSync.then(async () => {
    try {
      const rows = await getAllCheckoutSessions();
      await syncWalletPayments(rows, wallets.wallets[0]?.transactions ?? []);
      syncFailed = false;
    } catch (error) {
      syncFailed = true;
      console.error("payment sync failed", error);
    }
  });
  return paymentSync;
}
await syncPaymentStatus();

async function newSessionRoute() {
  const wallet = wallets.wallets[0];
  if (!wallet) return styledNotice("no merchant wallet found");
  const id = crypto.randomUUID();
  const row = (await createCheckoutSession("0.1337", id, wallet.merchant_confirmations ?? 10))[0];
  await updateCheckoutSessionAddress(id, wallet.makeIntegratedAddress(row.id));
  return new Response(null, { status: 303, headers: { Location: `/?checkoutId=${id}` } });
}

async function checkoutRoute(req: Request) {
  const id = new URL(req.url).searchParams.get("checkoutId") || "";
  const row = (await getCheckoutSessionBySessionId(id))[0];
  if (!row?.address) return instanceInfo();
  const link = tools["001"].counterparty.make({ address: row.address, amount: row.amount, no_check: false });
  return checkoutPage(row, `/wallet_info?checkoutId=${encodeURIComponent(id)}#${link}`);
}

async function paymentStatusRoute(req: Request) {
  const id = new URL(req.url).searchParams.get("checkoutId") || "";
  const row = (await getCheckoutSessionBySessionId(id))[0];
  if (!row?.address) return paymentStatusPage("Checkout session not found.");
  const status = wallets.connectionStatus?.last_packet.status;
  if (syncFailed || scanFailed || status === "catastrophic_reorg" || status === "connection_failed") {
    return paymentStatusPage("Payment status unavailable. Try again later.", false);
  }
  return paymentStatusPage(statusMessage(row, storedStatus(row)), !!row.paid_status);
}

async function handoverRoute(req: Request & { params: { address: string } }) {
  const row = (await getCheckoutSessionByAddress(req.params.address))[0];
  if (!row?.address) return Response.json({ ok: false, error: "unknown checkout" }, { status: 404 });
  const wallet = wallets.wallets[0];
  const view_key = wallet && Bun.env[`vk${wallet.primary_address}`];
  if (!wallet || !view_key) return Response.json({ ok: false, error: "merchant wallet not ready" }, { status: 503 });
  return handoverRequest(req, row, { node_url: wallet.node_url, primary_address: wallet.primary_address, view_key });
}

export function makeRoutes() {
  return {
    ...skeleton.static_routes,
    "/": { GET: checkoutRoute },
    "/newsession": { GET: newSessionRoute },
    "/paymentstatus": { GET: paymentStatusRoute },
    "/wallet_info": { GET: (req: Request) => walletInfoPage(new URL(req.url).searchParams.get("checkoutId")) },
    "/return": { GET: checkoutRoute },
    "/monerochan001/:address": {
      GET: async (req: Request & { params: { address: string } }) =>
        validateAddressRequest(req, (await getCheckoutSessionByAddress(req.params.address))[0]),
      POST: handoverRoute,
    },
  };
}

Bun.serve({ port: Number(Bun.env.CHECKOUT_PORT || 3004), maxRequestBodySize: 2_010_000, routes: makeRoutes() });
