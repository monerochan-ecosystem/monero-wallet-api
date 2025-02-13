import { url, head, commonHead, cssReset, html } from "@spirobel/mininext";
import QRCode from "qrcode";
import { db } from "../db/db";
import { checkoutSession } from "../db/schema";
import { ViewPair } from "@spirobel/monero-wallet-api";
import { PRIMARY_ADDRESS, SECRET_VIEW_KEY, STAGENET_URL } from "./viewpair";
import { eq } from "drizzle-orm";
head((mini) => mini.html`<title>checkout</title>${commonHead}${cssReset}`);
url.set("/newsession", async (mini) => {
  const secret = crypto.randomUUID();
  const viewPair = await ViewPair.create(
    PRIMARY_ADDRESS,
    SECRET_VIEW_KEY,
    STAGENET_URL
  );
  const insertedRow = db
    .insert(checkoutSession)
    .values({ amount: 0.1337, sessionId: secret })
    .returning()
    .get();
  const address = await viewPair.makeIntegratedAddress(insertedRow.id);
  await db.update(checkoutSession).set({ address }).returning();

  return mini.html`<a href="/?checkoutId=${insertedRow.sessionId}">checkout-session link</a>`;
});
url.set(
  "/paymentstatus",
  (mini) =>
    mini.html`${mini.headers({
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      Refresh: "1",
    })}    <div class="payment-status pending">
      Waiting for payment...
    </div><style> 
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
  
  </style>`
);
url.set("/", async (mini) => {
  const sessionId = mini.params.get("checkoutId");
  if (!sessionId) return mini.html`<h1>checkout session not found </h1>`;
  const sessionRow = db
    .select()
    .from(checkoutSession)
    .where(eq(checkoutSession.sessionId, sessionId))
    .get();
  if (!sessionRow?.address)
    return mini.html`<h1>checkout session not found </h1>`;

  const display_amount = sessionRow.amount;
  const address = sessionRow.address;

  const address_qrcode = await QRCode.toDataURL(address);
  const payment_uri = `monero:${address}?tx_amount=${display_amount}`;
  const payment_uri_qrcode = await QRCode.toDataURL(payment_uri);
  return mini.html` <div class="checkout-container">

    <div class="payment-info">
      <div class="payment-amount">${display_amount} XMR</div>
      <div class="payment-title">Super Special Green Tea</div>

      <div class="payment-steps">
        <div class="step">
          <div class="step-content">
            <h3>Copy Wallet Address</h3>
            <p>Send exactly ${display_amount} XMR to this address:</p>
            <div class="wallet-address">
              ${address}
              
            </div>
          </div>
        </div>
        
        <div class="step">
          <div class="step-content">
            <h3>Scan QR Code</h3>
            <p>Or scan this QR code with your wallet app:</p>
            <div class="qr-code">
              <img src="${payment_uri_qrcode}" width="100%" height="100%" />
            </div>
          </div>
        </div>
      </div>
    </div>
   <iframe src="/paymentstatus?checkoutId=${sessionRow.sessionId}" scrolling="no" frameBorder="0"></iframe>
  </div>
  ${styles}
  `;
});

export default url.install;

const styles = html`<style>
  :root {
    --primary: #5b21b6;
    --accent: #7c3aed;
    --text: #f8fafc;
    --bg: #070707;
    --success: #10b981;
  }
  iframe {
    border: none;
    width: 100%;
    height: 50px;
  }

  body {
    margin: 0;
    min-height: 100vh;
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
    margin-bottom: 1.5rem;
    padding: 1.5rem;
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
    width: 200px;
    height: 200px;
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
