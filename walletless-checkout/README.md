# Walletless checkout

If you don't have Bun installed, install it first.

```bash
curl -fsSL https://bun.sh/install | bash
```

Install the dependencies.

```bash
bun install
```

Set the merchant address and private view key in `.env`.

```dotenv
MONERO_PRIMARY_ADDRESS=your_primary_address
MONERO_VIEW_KEY=your_private_view_key
MONERO_NODE_URL=http://127.0.0.1:18081
```

Start the server and open `http://127.0.0.1:3006/newsession`.

```bash
bun run start
```

## `checkout.ts` overview

The checkout serves the same server-rendered page as standard checkout, with payment through a browser-wallet link. It follows each payment with a tracker.

1. `/newsession` creates a checkout with an integrated address and redirects to the payment page.
2. `GET /monerochan001/:address` verifies the address and returns the handover and return URLs.
3. `POST /monerochan001/:address` checks the signed transaction against the invoice, saves a receipt, and submits the transaction to the node.
4. `/paymentstatus` refreshes every second and shows the receipt, node acceptance, or confirmation status.

The trackers save their state in SQLite and resume unpaid checkouts after a restart. The checkout marks a payment as final when it reaches the required confirmation count, which defaults to 10. Use a separate primary address for each checkout database because payment IDs come from the database row IDs.

## Submission privacy

With a handover the counterparty gets the signed transaction from the browser session of the payer, before or while the network gets it. It sends the transaction to its own node, so that node sees the counterparty as a source of the transaction.
