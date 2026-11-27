# monero checkout implementation

if you don't have bun installed, run first:

```bash
curl -fsSL https://bun.sh/install | bash
```

To install dependencies:

```bash
bun install
```

Now you can start the server with the dev command (it will refresh on code changes):

dev:

```bash
bun run dev
```

production:

```bash
bun run prod
```

---

## checkout.ts overview

`checkout.ts` is a **JavaScript free, server-rendered Monero payment page** built with [Bun](https://bun.sh) and [mininext](https://github.com/spirobel/mininext). It creates a checkout session, generates a unique integrated address, and displays it with a QR code, without any client-side JavaScript.

### How it works

The entire payment flow is driven by **HTTP headers and server-side rendering**, not JavaScript:

1. **`/newsession`** creates a new checkout session in the database with a unique `session_id`, generates an integrated address from the merchant wallet, and **303-redirects** the user to `/?checkoutId=<session_id>`.

2. **`/` (checkout page)** renders the full payment UI: amount, integrated address, QR code, and a "pay with browser wallet" link. The page includes an `<iframe>` pointing to `/paymentstatus?checkoutId=<id>`.

3. **`/paymentstatus`** this route returns the payment status (pending / success) with a `Refresh: 1` HTTP header. The browser **automatically reloads the iframe every second**, so the status updates live. There is no clienside JavaScript polling needed to achieve a modern, interactive experience with this approach.

4. **`/wallet_info`** is a fallback page shown when the user clicks the browser wallet link but no wallet is installed. It includes a "back to checkout" link that preserves the `checkoutId` query param.

5. **`/monerochan001/:address`** implements a validation endpoint that the Monero wallet API calls to verify the displayed monero address belongs to the merchant. This API is accessed by the customers wallet when he clicks the "pay with browser wallet" link.

## Submission privacy

The merchant receives the signed transaction from the buyer's browser session and sends it to the merchant's node. The node sees the merchant as a source of the transaction.

## Browser-wallet handover

`001` address validation supplies the session's return URL and advertises the same address route for handover. The wallet submits the signed transaction with `POST /monerochan001/:address`. `acceptance.ts` checks the scanned amount and payment ID, awaits the transaction-hash write, and then lets the library send the exact transaction to the merchant's node. The node answers OK for a new transaction and for one that it has already.

The node URL comes from the opened wallet's scan settings. There are no separate hard-coded display and relay nodes. The status page reads the saved checkout row. The wallet scan updates the confirmation count when the chain changes. A checkout stays paid after it reaches the required confirmation count, even if a later reorg removes the payment block. If the scanner reports a failure, the status page shows that verification is unavailable.

The status iframe uses `Refresh: 1`. It can show the handover receipt while the wallet scans for the payment.

## Mininext Tutorial

If you understand these 3 basic concepts you can build your own website with mininext:

1. html + css
2. templating
3. you can use data inside of your html templates

For a full tutorial on mininext, check out the [mininext repository](https://github.com/spirobel/mininext).
