import { html } from "@spirobel/mininext";
import QRCode from "qrcode";

export const skeleton = await html`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>checkout</title></head>
<body>${null}</body></html>`.build();

const documentStyles = html`<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 1rem; background: #fafafa; color: #1a1a1a; font-family: Georgia, "Times New Roman", serif; line-height: 1.5; }
  main { max-width: 566px; margin: 0 auto; padding: 2rem; background: #fff; border: 1px solid #ddd; border-radius: 2px; box-shadow: 0 1px 3px #0001; }
  h1, h2, h3, p { margin: 0 0 1rem; }
  h1 { font-size: 2.5rem; text-align: center; }
  h2 { font-size: 1.5rem; text-align: center; }
  h3 { font-size: 1.1rem; }
  a { color: inherit; }
  .step { padding: 1rem; margin: 1rem 0; border: 1px solid #eee; }
  .wallet-address { font-family: "Courier New", monospace; overflow-wrap: anywhere; background: #f9f9f9; border: 1px solid #eee; padding: 1rem; font-size: .9rem; }
  .pay-button { display: inline-block; padding: .75rem 1.5rem; background: #1a1a1a; color: #fff; border: 1px solid #1a1a1a; border-radius: 2px; text-decoration: none; font: bold 1rem Georgia, serif; }
  .pay-button:hover { background: #333; }
  .pay-button:focus-visible { outline: 2px solid #111; outline-offset: 3px; }
  .pay-action { text-align: center; }
  .qr-code { display: block; width: 180px; max-width: 100%; height: auto; margin: 1rem auto 0; }
  iframe { width: 100%; height: 84px; border: 0; display: block; }
  @media (max-width: 420px) { body { padding: .5rem; } main { padding: 1rem; } h1 { font-size: 2rem; } .step { padding: .75rem; } iframe { height: 110px; } }
</style>`;

export function styledNotice(title: string, sub?: string) {
  return new Response(skeleton.fill(html`<main>${documentStyles}<h2>${title}</h2>${sub ? html`<p>${sub}</p>` : ""}</main>`));
}

export function instanceInfo(name = "standard checkout") {
  return new Response(skeleton.fill(html`<main>${documentStyles}<h2>${name}</h2>
    <p><a href="https://github.com/monerochan-ecosystem/monero-wallet-api" target="_blank" rel="noopener noreferrer">source</a></p></main>`));
}

export function paymentStatusPage(message: string, paid = false) {
  return new Response(skeleton.fill(html`<div class="payment-status ${paid ? "success" : "pending"}" role="status">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; color: #1a1a1a; font: 16px/1.5 Georgia, "Times New Roman", serif; }
      .payment-status { border-top: 1px solid #ddd; padding: .75rem 0; text-align: center; }
      .payment-status.success { font-weight: bold; }
    </style>${message}</div>`), { headers: {
    "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0", "Refresh": "1",
  } });
}

export async function checkoutPage(sessionRow: { amount: string; address: string | null; session_id: string }, toollink: string, browserOnly = false) {
  if (!sessionRow.address) return instanceInfo();
  const paymentUri = `monero:${sessionRow.address}?tx_amount=${sessionRow.amount}`;
  const qr = browserOnly ? "" : await QRCode.toDataURL(paymentUri);
  return new Response(skeleton.fill(html`<main class="checkout-container">
    ${documentStyles}
    <h1 class="payment-amount">${sessionRow.amount} XMR</h1>
    <h2 class="payment-title">Super Special Green Tea</h2>
    ${browserOnly ? "" : html`<section class="step"><h3>Payment address</h3>
      <p>Send exactly ${sessionRow.amount} XMR to this address:</p>
      <div class="wallet-address">${sessionRow.address}</div>
    </section>`}
    <section class="step pay-action"><a class="pay-button" href="${toollink}" target="_blank" rel="noopener noreferrer">pay with browser wallet</a></section>
    ${browserOnly ? "" : html`<section class="step"><h3>Payment QR code</h3>
      <p>You can also scan this code with your wallet app.</p>
      <img class="qr-code" src="${qr}" width="180" height="180" alt="Monero payment QR code" />
    </section>`}
    <iframe title="Payment status" src="/paymentstatus?checkoutId=${sessionRow.session_id}" scrolling="no"></iframe>
  </main>`));
}

export function walletInfoPage(checkoutId: string | null) {
  return new Response(skeleton.fill(html`<main>${documentStyles}
    <h2>Monero browser wallet not installed</h2>
    <p>No browser wallet handled this payment link. Install the wallet to pay in your browser.</p>
    <p><a class="pay-button" href="https://monerochan.cash" target="_blank" rel="noopener noreferrer">Install Monero Browser Wallet</a></p>
    <a href="${checkoutId ? `/?checkoutId=${encodeURIComponent(checkoutId)}` : "/"}">Back to checkout</a>
  </main>`));
}
