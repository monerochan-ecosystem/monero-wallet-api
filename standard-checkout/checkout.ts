import { html } from "@spirobel/mininext";
import {
  openWallets,
  make001ToolLink,
  ADDRESS_VALID_RESPONSE,
  ADDRESS_INVALID_RESPONSE,
  convertAmountBigInt,
} from "@spirobel/monero-wallet-api";
import QRCode from "qrcode";
import {
  createCheckoutSession,
  updateCheckoutSessionAddress,
  getCheckoutSessionBySessionId,
  getCheckoutSessionByAddress,
  getCheckoutSessionByPrimaryId,
  markAsPaid,
  updateTxConfirmations,
} from "./db";
import type { BunRequest } from "bun";

const AMOUNT = "0.1337";
const ACCEPT_AFTER_CONFIRMATIONS = 10;

// ─── Skeleton ───────────────────────────────────────────────────────────────

const skeleton = await html`<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>checkout</title>
    </head>
    <body>
      ${null}
    </body>
  </html> `.build();

// ─── Routes ─────────────────────────────────────────────────────────────────

export function makeRoutes() {
  return {
    ...skeleton.static_routes,
    "/newsession": { GET: newSessionRoute },
    "/paymentstatus": { GET: paymentStatusRoute },
    "/monerochan001/:address": {
      GET: async (req: BunRequest<"/monerochan001/:address">) => {
        const sessionRow = await getCheckoutSessionByAddress(
          req.params.address,
        );
        if (!sessionRow[0]?.id) return Response.json(ADDRESS_INVALID_RESPONSE);
        return Response.json(ADDRESS_VALID_RESPONSE);
      },
    },
    "/": { GET: checkoutRoute },
    "/wallet_info": { GET: walletInfoRoute },
  };
}

Bun.serve({ port: 3004, routes: makeRoutes() });

// ─── Open Merchant Wallet ─────────────────────────────────────────────────────────

let retryScheduled = false;

const wallets = await openWallets({
  notifyMasterChanged: async (params) => {
    // sync payments on cache change
    // sync in any case to update confirmations
    await syncPaymentStatus();
  },
  workerError: async (err) => {
    console.log(
      "scan worker error, typically loss of network connection, retry in 1 second",
      err,
    );
    if (retryScheduled) return;

    retryScheduled = true;
    setTimeout(() => {
      wallets?.retry();
      retryScheduled = false;
    }, 1000);
  },
  no_stats: true,
});
const mainwallet = wallets?.wallets[0];
async function syncPaymentStatus() {
  if (!mainwallet) return;
  for (const tx of mainwallet.transactions) {
    const txConfirmations = tx.confirmations;
    const checkout_session_row = await getCheckoutSessionByPrimaryId(
      tx.payment_id,
    );
    if (!checkout_session_row[0]) continue;

    // update current confirmation count
    await updateTxConfirmations(tx.payment_id, txConfirmations);

    if (!checkout_session_row[0].paid_status) {
      if (
        txConfirmations >= checkout_session_row[0].required_confirmations &&
        tx.amount >= convertAmountBigInt(checkout_session_row[0].amount)
      ) {
        await markAsPaid(tx.payment_id);
      }
    }
  }
}
// sync payments on startup
await syncPaymentStatus();

// ─── Route Handlers ─────────────────────────────────────────────────────────

async function newSessionRoute() {
  const secret = crypto.randomUUID();
  const insertedRow = (
    await createCheckoutSession(AMOUNT, secret, ACCEPT_AFTER_CONFIRMATIONS)
  )[0];

  if (!mainwallet)
    return new Response(skeleton.fill(html`<h1>no merchant wallet found</h1>`));

  const address = await mainwallet.makeIntegratedAddress(insertedRow.id);
  await updateCheckoutSessionAddress(insertedRow.session_id, address);

  const redirectUrl = `/?checkoutId=${insertedRow.session_id}`;
  const headers = new Headers();
  headers.set("Location", redirectUrl);
  return new Response(null, { status: 303, headers });
}

// this route is rendered as an iframe on the checkout page
// the refresh header means it will be reloaded every 1 second
// the result is a live experience without javascript in the frontend.
async function paymentStatusRoute(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("checkoutId");
  if (!sessionId) {
    return new Response(
      skeleton.fill(html`<h1>checkout session not found</h1>`),
    );
  }

  const sessionRow = (await getCheckoutSessionBySessionId(sessionId))[0];

  if (!sessionRow?.address) {
    return new Response(
      skeleton.fill(html`<h1>checkout session not found</h1>`),
    );
  }

  const statusClass = sessionRow.paid_status ? "success" : "pending";
  const statusText = sessionRow.paid_status
    ? html`<svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          style="margin-right: 8px;"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <span>Payment received!</span>`
    : "Waiting for payment...";

  const content = html`
    <div class="payment-status ${statusClass}">
      ${statusText}${paymentStatusStyles}
    </div>
  `;

  const headers = new Headers();
  headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("Refresh", "1");

  return new Response(skeleton.fill(content), { headers });
}

async function checkoutRoute(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("checkoutId");
  if (!sessionId) {
    return new Response(
      skeleton.fill(html`<h1>checkout session not found</h1>`),
    );
  }

  const sessionRow = (await getCheckoutSessionBySessionId(sessionId))[0];

  if (!sessionRow?.address) {
    return new Response(
      skeleton.fill(html`<h1>checkout session not found</h1>`),
    );
  }

  const displayAmount = sessionRow.amount;
  const address = sessionRow.address;
  const toollink = `/wallet_info?checkoutId=${sessionId}#${make001ToolLink(address, AMOUNT)}`;
  const addressQrCode = await QRCode.toDataURL(address);
  const paymentUri = `monero:${address}?tx_amount=${displayAmount}`;
  const paymentUriQrCode = await QRCode.toDataURL(paymentUri);

  const content = html`<div class="checkout-container">
    ${checkoutStyles}
    <div class="payment-info">
      <div class="payment-amount">${displayAmount} XMR</div>
      <div class="payment-title">Super Special Green Tea</div>

      <div class="payment-steps">
        <div class="step">
          <div class="step-content">
            <h3>Copy Wallet Address</h3>
            <p>Send exactly ${displayAmount} XMR to this address:</p>
            <div class="wallet-address">${address}</div>
          </div>
        </div>
        <div class="step">
          <div class="step-content" style="text-align: center;">
            <a href="${toollink}" class="pay-button">pay with browser wallet</a>
          </div>
        </div>

        <div class="step">
          <div class="step-content">
            <h3>Scan QR Code</h3>
            <p>Or scan this QR code with your wallet app:</p>
            <div class="qr-code">
              <img src="${paymentUriQrCode}" width="100%" height="100%" />
            </div>
          </div>
        </div>
      </div>
    </div>
    <iframe
      src="/paymentstatus?checkoutId=${sessionRow.session_id}"
      scrolling="no"
      frameborder="0"
    ></iframe>
  </div>`;

  return new Response(skeleton.fill(content));
}

// ─── Styles ─────────────────────────────────────────────────────

const checkoutStyles = html`<style>
  iframe {
    border: none;
    width: 100%;
    height: 55px;
  }

  :root {
    --primary: #5b21b6;
    --accent: #7c3aed;
    --text: #f8fafc;
    --bg: #070707;
    --success: #10b981;
  }

  body {
    margin: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--bg);
    font-family: "Inter", system-ui, sans-serif;
    color: var(--text);
    padding: 1rem;
    background-image: radial-gradient(
      circle at 50% 50%,
      rgba(124, 58, 237, 0.15) 0%,
      transparent 50%
    );
  }

  .checkout-container {
    max-width: 500px;
    width: 100%;
    background: rgba(20, 20, 20, 0.8);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(124, 58, 237, 0.2);
    border-radius: 20px;
    padding: 2rem;
  }

  .payment-info {
    margin-bottom: 2rem;
  }

  .payment-amount {
    text-align: center;
    font-size: 3rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
    background: linear-gradient(135deg, #fff 0%, #7c3aed 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 0 30px rgba(124, 58, 237, 0.3);
  }

  .payment-title {
    text-align: center;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 2rem;
    letter-spacing: -0.02em;
  }

  .product-description {
    text-align: center;
    margin-bottom: 3rem;
    line-height: 1.8;
    font-size: 1.1rem;
    color: rgba(248, 250, 252, 0.9);
    padding: 2rem;
    background: rgba(124, 58, 237, 0.05);
    border-radius: 12px;
    border: 1px solid rgba(124, 58, 237, 0.1);
  }

  .payment-steps {
    counter-reset: step;
  }

  .step {
    display: flex;
    gap: 1rem;
    margin-bottom: 12px;
    padding: 19px;
    background: rgba(20, 20, 20, 0.5);
    border-radius: 12px;
    border: 1px solid rgba(124, 58, 237, 0.1);
    transition: all 0.3s ease;
  }

  .step:hover {
    border-color: rgba(124, 58, 237, 0.3);
    transform: translateY(-2px);
  }

  .step:before {
    counter-increment: step;
    content: counter(step);
    width: 28px;
    height: 28px;
    background: var(--accent);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    flex-shrink: 0;
    box-shadow: 0 0 20px rgba(124, 58, 237, 0.3);
  }

  .step-content {
    flex: 1;
  }

  .step h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.1rem;
    background: linear-gradient(135deg, #fff 0%, #a78bfa 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .step p {
    margin: 0;
    font-size: 0.925rem;
    opacity: 0.8;
  }

  .wallet-address {
    background: rgba(20, 20, 20, 0.5);
    border-radius: 12px;
    padding: 1rem;
    font-family: monospace;
    word-break: break-all;
    margin: 0.5rem 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border: 1px solid rgba(124, 58, 237, 0.1);
  }
  .wallet-address::selection {
    background: rgba(124, 58, 237, 0.4);
  }

  .pay-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 14px 31px;
    font-size: 1rem;
    font-weight: 600;
    font-family: inherit;
    color: #fff;
    background: linear-gradient(135deg, var(--accent) 0%, #6d28d9 100%);
    border: none;
    border-radius: 12px;
    cursor: pointer;
    text-decoration: none;
    text-align: center;
    transition: all 0.25s ease;
    box-shadow:
      0 4px 15px rgba(124, 58, 237, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .pay-button:hover {
    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
    transform: translateY(-2px);
    box-shadow:
      0 6px 25px rgba(124, 58, 237, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.15);
  }

  .pay-button:active {
    transform: translateY(0);
    box-shadow:
      0 2px 10px rgba(124, 58, 237, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .wallet-address::selection {
    background: rgba(124, 58, 237, 0.6);
    color: #ffffff;
  }
  .wallet-address::-moz-selection {
    background: rgba(124, 58, 237, 0.6);
    color: #ffffff;
  }

  .copy-btn {
    background: var(--accent);
    border: none;
    color: var(--text);
    padding: 0.5rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.3s ease;
    white-space: nowrap;
    box-shadow: 0 0 20px rgba(124, 58, 237, 0.2);
  }

  .copy-btn:hover {
    background: var(--primary);
    transform: translateY(-2px);
  }

  .copy-btn.copied {
    background: var(--success);
  }

  .qr-code {
    width: 140px;
    height: 140px;
    background: white;
    border-radius: 12px;
    margin: 1rem auto;
    padding: 1rem;
    box-shadow: 0 0 30px rgba(124, 58, 237, 0.2);
  }

  .payment-status {
    text-align: center;
    margin-top: 2rem;
    padding: 1rem;
    border-radius: 12px;
    animation: pulse 2s infinite;
    backdrop-filter: blur(5px);
  }

  .payment-status.pending {
    background: rgba(124, 58, 237, 0.1);
  }

  .payment-status.success {
    background: rgba(16, 185, 129, 0.1);
  }

  @keyframes pulse {
    0% {
      opacity: 0.8;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.8;
    }
  }

  .timer {
    text-align: center;
    font-size: 0.875rem;
    opacity: 0.8;
    margin-top: 1rem;
  }

  @media (max-width: 640px) {
    .checkout-container {
      padding: 1.5rem;
    }

    .payment-amount {
      font-size: 2.5rem;
    }

    .wallet-address {
      flex-direction: column;
    }

    .copy-btn {
      width: 100%;
    }
  }
</style>`;

const paymentStatusStyles = html`<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  html,
  body {
    background-color: #000;
    color: #fff;
  }
  :root {
    --primary: #5b21b6;
    --accent: #7c3aed;
    --text: #f8fafc;
    --bg: #070707;
    --success: #10b981;
  }
  .payment-status {
    text-align: center;
    padding: 1rem;
    border-radius: 12px;
    animation: pulse 2s infinite;
    backdrop-filter: blur(5px);
    display: flex;
    justify-content: center;
    align-items: center;
  }
  html {
    background: rgba(20, 20, 20, 0.8);
  }

  .payment-status.pending {
    background: rgba(124, 58, 237, 0.1);
  }

  .payment-status.success {
    background: rgba(16, 185, 129, 0.1);
  }

  @keyframes pulse {
    0% {
      opacity: 0.8;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.8;
    }
  }
  body {
    font-family: "Inter", system-ui, sans-serif;
    color: var(--text);
    background: rgba(20, 20, 20, 0.8);
  }
</style>`;

async function walletInfoRoute(req: Request) {
  const url = new URL(req.url);
  const checkoutId = url.searchParams.get("checkoutId");
  const backUrl = checkoutId ? `/?checkoutId=${checkoutId}` : "/";
  const content = html`
    <div class="wallet-not-detected">
      <h1>Monero Browser Wallet Not Installed</h1>
      <p>
        You clicked a Monero payment link, but no browser wallet was found to
        handle it. Please install a Monero browser wallet to pay with your
        browser.
      </p>
      <a
        href="https://monerochan.city"
        class="install-btn"
        target="_blank"
        rel="noopener noreferrer"
      >
        Install Monero Browser Wallet
      </a>
      <a href="${backUrl}" class="back-btn" id="back-btn">
        ← Back to Checkout
      </a>
      ${walletNotDetectedStyles}
    </div>
  `;
  return new Response(skeleton.fill(content));
}

const walletNotDetectedStyles = html`<style>
  :root {
    --primary: #5b21b6;
    --accent: #7c3aed;
    --text: #f8fafc;
    --bg: #070707;
    --success: #10b981;
  }

  body {
    margin: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    background: var(--bg);
    font-family: "Inter", system-ui, sans-serif;
    color: var(--text);
    padding: 1rem;
    background-image: radial-gradient(
      circle at 50% 50%,
      rgba(124, 58, 237, 0.15) 0%,
      transparent 50%
    );
  }

  .wallet-not-detected {
    max-width: 480px;
    width: 100%;
    text-align: center;
    background: rgba(20, 20, 20, 0.8);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(124, 58, 237, 0.2);
    border-radius: 20px;
    padding: 3rem 2rem;
  }

  .wallet-not-detected h1 {
    font-size: 1.75rem;
    font-weight: 700;
    margin: 0 0 1rem 0;
    background: linear-gradient(135deg, #fff 0%, #a78bfa 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .wallet-not-detected p {
    font-size: 1rem;
    line-height: 1.7;
    color: rgba(248, 250, 252, 0.8);
    margin: 0 0 2rem 0;
  }

  .install-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 14px 32px;
    font-size: 1rem;
    font-weight: 600;
    font-family: inherit;
    color: #fff;
    background: linear-gradient(135deg, var(--accent) 0%, #6d28d9 100%);
    border: none;
    border-radius: 12px;
    cursor: pointer;
    text-decoration: none;
    text-align: center;
    transition: all 0.25s ease;
    box-shadow:
      0 4px 15px rgba(124, 58, 237, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .install-btn:hover {
    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
    transform: translateY(-2px);
    box-shadow:
      0 6px 25px rgba(124, 58, 237, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.15);
  }

  .install-btn:active {
    transform: translateY(0);
    box-shadow:
      0 2px 10px rgba(124, 58, 237, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .back-btn {
    display: block;
    align-items: center;
    gap: 6px;
    margin-top: 1.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    font-family: inherit;
    color: rgba(248, 250, 252, 0.5);
    text-decoration: none;
    transition: color 0.2s ease;
  }

  .back-btn:hover {
    color: rgba(248, 250, 252, 0.85);
  }

  @media (max-width: 640px) {
    .wallet-not-detected {
      padding: 2rem 1.5rem;
    }

    .wallet-not-detected h1 {
      font-size: 1.5rem;
    }
  }
</style>`;
