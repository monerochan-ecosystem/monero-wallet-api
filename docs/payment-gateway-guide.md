## Payment Gateway Implementation Guide

If you want to accept Monero as part of an automated system, there are a few things to consider. An implementation of a checkout flow can be found in [standard-checkout](../standard-checkout). Go through the checklist and read the code to understand how each point is addressed. If you need context read [nodes and wallets](nodes-and-wallets.md) and [wasm memory management](wasm-memory-management.md).

## Checklist

- prevent the burning bug
- choose the right syncing strategy
- create checkout session
- address generation
- calculate amount
- display checkout page
- update session paid status

## Syncing Strategies

The checkout flow in [standard-checkout](../standard-checkout) currently uses the vanilla strategy of fetching and scanning blocks in a background thread. This approach might not be the right one for a situation where lots of wallets need to be scanned in parallel.
In some cases it might even be useful to only scan wallets that have an open checkout page.

Initiating the scan process from the HTTP request to the checkout page potentially adds more robustness compared to a long running background thread (that might die and not be properly restarted). The downside is that the user has to keep the checkout page open until the transaction is found. This means there is a trade off between UX and resource intensity.

In the future, browser wallet UX will alleviate this trade off by programmatically sharing the txid with the backend.

## Integrated Adresses vs Subaddresses

The primary benefit of Subaddresses is for endusers to be able to avoid linking their identities together while still being able to use just one wallet.

For payment gateways integrated addresses are the right choice. They are used to distinguish different customers. Using subaddresses leads to worse merchant UX when clients request the creation of many subaddresses that stay unused. This can result in missed outputs during the scanning process.

## Future Developments

This guide will get extended with the following sections as the library development progresses

- fetch once sync many
- transaction building
- multisig + escrow UX
- browser wallet interaction
