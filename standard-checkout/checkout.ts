import { html } from "@spirobel/mininext";
import {
  openWallets,
  tools,
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
  updateTxHash,
} from "./db";
const AMOUNT = "0.1337";
export const WALLET_CACHES_DIR = "wallet-caches";
export const SCAN_SETTINGS_PATH = WALLET_CACHES_DIR + "/ScanSettings.json";

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

const noticeStyles = html`<style>
  body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #070707; font-family: "Inter", system-ui, sans-serif; color: #f8fafc; padding: 1rem; background-image: radial-gradient(circle at 50% 50%, rgba(124,58,237,0.15) 0%, transparent 50%); }
  .info-container { max-width: 520px; width: 100%; text-align: center; }
  .info-card { background: rgba(20,20,20,0.8); backdrop-filter: blur(10px); border: 1px solid rgba(124,58,237,0.2); border-radius: 20px; padding: 2.5rem 2rem; }
  .info-title { font-size: 1.125rem; font-weight: 600; color: #7c3aed; margin-bottom: 0.5rem; }
  .info-message { font-size: 1rem; line-height: 1.7; color: rgba(248,250,252,0.8); margin: 1rem 0 0 0; }
  .info-message a { color: inherit; text-decoration: none; border-bottom: 1px solid currentColor; }
</style>`;

function styledNotice(title: string, sub?: string) {
  const content = html`<div class="info-container">
    ${noticeStyles}
    <div class="info-card">
      <div class="info-title">${title}</div>
      ${sub ? html`<p class="info-message">${sub}</p>` : ""}
    </div>
  </div>`;
  return new Response(skeleton.fill(content));
}

function instanceInfo() {
  const content = html`<div class="info-container">
    ${noticeStyles}
    <div class="info-card">
      <div class="info-title">standard checkout</div>
      <p class="info-message"><a href="https://github.com/monerochan-ecosystem/monero-wallet-api" target="_blank" rel="noopener noreferrer">[source]</a></p>
    </div>
  </div>`;
  return new Response(skeleton.fill(content));
}

export function makeRoutes() {
  return {
    ...skeleton.static_routes,
    "/newsession": { GET: newSessionRoute },
    "/paymentstatus": { GET: paymentStatusRoute },
    "/monerochan001/:address": {
      GET: tools["001"].counterparty.validate_route({
        isPayAddressKnown: async (address) => {
          const sessionRow = await getCheckoutSessionByAddress(address);
          return !!sessionRow[0]?.id;
        },
      }),
    },
    "/": { GET: checkoutRoute },
    "/wallet_info": { GET: walletInfoRoute },
  };
}

const wallets = await openWallets({
  scan_settings_path: SCAN_SETTINGS_PATH,
  notifyMasterChanged: async (params) => {
    try {
      await syncPaymentStatus();
    } catch {
    }
  },
  autoRetry: true,
});
function liveWallets() {
  return wallets?.wallets ?? [];
}
async function syncPaymentStatus() {
  try {
    for (const w of liveWallets()) {
      let txs: { payment_id: number; confirmations: number; tx_hash: string; amount: bigint }[] = [];
      try {
        txs = w.transactions as typeof txs;
      } catch {
        continue;
      }
      for (const tx of txs) {
        try {
          const row = (await getCheckoutSessionByPrimaryId(tx.payment_id))[0];
          if (!row) continue;
          if (row.tx_hash && row.tx_hash !== tx.tx_hash) continue;
          if (!row.tx_hash) await updateTxHash(tx.payment_id, tx.tx_hash);
          if (row.tx_confirmations !== tx.confirmations) {
            await updateTxConfirmations(tx.payment_id, tx.confirmations);
          }
          if (row.paid_status === 1) continue;
          let need: bigint | null = null;
          try {
            need = convertAmountBigInt(row.amount);
          } catch {
          }
          if (need === null || tx.amount < need) continue;
          if (tx.confirmations < row.required_confirmations) continue;
          await markAsPaid(tx.payment_id);
        } catch {
        }
      }
    }
  } catch {
  }
}
try {
  await syncPaymentStatus();
} catch {
}

Bun.serve({ port: 3004, routes: makeRoutes() });

async function newSessionRoute() {
  const live = liveWallets()[0];
  if (!live)
    return styledNotice("no merchant wallet found");
  const secret = crypto.randomUUID();
  const insertedRow = (
    await createCheckoutSession(
      AMOUNT,
      secret,
      live.merchant_confirmations ?? 10,
    )
  )[0];

  const address = await live.makeIntegratedAddress(insertedRow.id);
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
    return styledNotice("checkout session not found");
  }

  let sessionRow = (await getCheckoutSessionBySessionId(sessionId))[0];

  if (!sessionRow?.address) {
    return styledNotice("checkout session not found");
  }

  if (!sessionRow.paid_status) {
    const rowId = sessionRow.id;
    try {
      const live = liveWallets().flatMap((w) => {
        try {
          return w.transactions;
        } catch {
          return [];
        }
      }).find((t) => t.payment_id === rowId);
      if (live) {
        if (!sessionRow.tx_hash) await updateTxHash(sessionRow.id, live.tx_hash);
        if (sessionRow.tx_confirmations !== live.confirmations) {
          await updateTxConfirmations(sessionRow.id, live.confirmations);
        }
        let need: bigint | null = null;
        try {
          need = convertAmountBigInt(sessionRow.amount);
        } catch {
        }
        if (need !== null && live.amount >= need && live.confirmations >= sessionRow.required_confirmations) {
          await markAsPaid(sessionRow.id);
        }
        sessionRow = (await getCheckoutSessionBySessionId(sessionId))[0] ?? sessionRow;
      }
    } catch {
    }
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
    : html`<svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          style="margin-right: 8px;"
        >
          <circle cx="12" cy="12" r="10" stroke-dasharray="4 4" />
        </svg>
        <span>
          Waiting for payment...
          (${sessionRow.tx_confirmations}/${sessionRow.required_confirmations}
          confirmations)
        </span>`;

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
    return instanceInfo();
  }

  const sessionRow = (await getCheckoutSessionBySessionId(sessionId))[0];

  if (!sessionRow?.address) {
    return instanceInfo();
  }

  const displayAmount = sessionRow.amount;
  const address = sessionRow.address;
  const toollink = `/wallet_info?checkoutId=${sessionId}#${tools["001"].counterparty.make({ address, amount: sessionRow.amount, no_check: false })}`;
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
            <a
              href="${toollink}"
              class="pay-button"
              target="_blank"
              rel="noopener noreferrer"
              >pay with browser wallet</a
            >
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
        href="https://monerochan.cash"
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
