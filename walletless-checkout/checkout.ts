import { tools } from "@spirobel/monero-wallet-api";
import { checkoutPage, instanceInfo, paymentStatusPage, skeleton, walletInfoPage } from "../standard-checkout/page";
import { createCheckoutSession, getCheckoutSessionByAddress, getCheckoutSessionBySessionId, updateCheckoutSessionAddress } from "../standard-checkout/db";
import { validateAddressRequest } from "../standard-checkout/payment";
import { openCheckoutTrackers } from "./tracker";

const primary_address = Bun.env.MONERO_PRIMARY_ADDRESS;
const view_key = Bun.env.MONERO_VIEW_KEY;
if (!primary_address || !view_key) throw new Error("Set MONERO_PRIMARY_ADDRESS and MONERO_VIEW_KEY before starting walletless checkout.");
const node_url = Bun.env.MONERO_NODE_URL || "http://127.0.0.1:18081";
const confirmations = Number(Bun.env.REQUIRED_CONFIRMATIONS || 10);
if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error("REQUIRED_CONFIRMATIONS must be a positive integer.");
const trackers = await openCheckoutTrackers({ node_url, primary_address, view_key });

async function newSessionRoute() {
  const id = crypto.randomUUID();
  const row = (await createCheckoutSession("0.1337", id, confirmations))[0];
  await updateCheckoutSessionAddress(id, trackers.makeIntegratedAddress(row.id));
  return new Response(null, { status: 303, headers: { Location: `/?checkoutId=${id}` } });
}

async function checkoutRoute(req: Request) {
  const id = new URL(req.url).searchParams.get("checkoutId") || "";
  const row = (await getCheckoutSessionBySessionId(id))[0];
  if (!row?.address) return instanceInfo("walletless checkout");
  const link = tools["001"].counterparty.make({ address: row.address, amount: row.amount, no_check: false });
  return checkoutPage(row, `/wallet_info?checkoutId=${encodeURIComponent(id)}#${link}`, true);
}

async function paymentStatusRoute(req: Request) {
  const id = new URL(req.url).searchParams.get("checkoutId") || "";
  const row = (await getCheckoutSessionBySessionId(id))[0];
  if (!row?.address) return paymentStatusPage("Checkout session not found.");
  const current = await trackers.refresh(row);
  return paymentStatusPage(trackers.status(current), !!current.paid_status);
}

async function handoverRoute(req: Request & { params: { address: string } }) {
  const row = (await getCheckoutSessionByAddress(req.params.address))[0];
  return trackers.handoverRequest(req, row);
}

Bun.serve({ port: Number(Bun.env.CHECKOUT_PORT || 3006), maxRequestBodySize: 2_010_000, routes: {
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
} });
