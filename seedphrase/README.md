# seedphrase

This package collects functions to generate wallet secrets from a bip39 seedphrase + wallet route + seedphrase offset passphrase.

## Motivation

The goal is to avoid a nested jungle of successively applied key derivation standards with derivation paths that are not human readable.

The structure of key derivation paths should not be cryptic and protect the user from accidentally using a wallet in the wrong context.

## Usage

generate seedphrase and derive private spend key

```ts
const seedphrase = generateSeedphrase();
const wallet_secret = getWalletSecret({
  route: WALLET_DEFAULT_ROUTE,
  seedphrase,
  coin_name: "monero",
  key_type: "spend",
});

console.log("Wallet secret:", wallet_secret);
```

Most commonly used functions:

```ts
import {
  generateSeedphrase,
  getWalletSecret,
  validateSeedphrase,
  WALLET_DEFAULT_ROUTE,
  walletRouteToString,
} from "@spirobel/seedphrase";
```

For a full usage example see the onboarding dialogue implemented in the [monero browser wallet](https://github.com/monerochan-ecosystem/monerochan-city-wallet)

To install:

```bash
bun install @spirobel/seedphrase
```

## Concepts

### Wallet route

The wallet route is a tool to keep online identities compartmentalized and manage multi signature wallets derived from the same seedphrase.

```
${identity}/${domain}/${wallet_type}/${wallet_slot}/
```

the default route is `main/no_domain/single/0`

#### identity

The identity is a string that is used to distinguish between different roles a user plays online. It can be a nickname or a username.

#### domain

The domain in the context of which this wallet was created.
This helps the user to distinguish view wallets that were created in the context of different domains. Wallet apps may help to prevent the user from using a wallet in the wrong context, based on this information.

#### wallet type

- `single` - a single wallet
- `sa_multi` - a multi signature wallet that was create with a separate hardware device
- `pl_multi` - a multi signature wallet that was created in the context of a payment links instance

#### wallet slot

The wallet slot is used to distinguish between multiple wallets that are derived from the same seedphrase and identity in the context of one domain.

### Key type

This is used in addtion to the wallet route to obtain secrets from the seedphrase. This is not as relevant for the users and will be transparent in the wallet software in most cases

In the typical multisig escrow usecase, the customer visits the checkout page of a merchant shop,
selects an arbitrator from the merchant approved arbitrator list, and wants to pay immediately.

1. The merchant does not want to keep all private key material on the shop server.
2. To finish the DKG setup process and obtain the shared spend pub key, (which is used to obtain the address of the shared escrow wallet), at least t (threshold) of n (total number of multisig participants) participants need to exchange messages.
3. To obtain the multisig private viewkey, a shared secret between at least two parties of the escrow wallet is needed.

Instead of a typical 2 of 3 multisig setup, we use a 3 of 5 multisig setup, merchant and customer each get 2 keys and the arbitrator gets 1 key.

A. This still means two parties have to collude to unlock the funds in the escrow wallet.

B. The merchant can keep one key offline, while even if the hotkey on the shopserver is compromised, the arbitrator key alone is not enough to unlock the escrow wallet.

C. The wallet can be set up without the direct participation of the arbitrator.

##### key type options

To bundle the two multisig shares (+ shared secret for viewkey) under one route, these key options are used:

- `spend` - the private spend key, this is the default case.
- `comms` - in the typical escrow multisig case we need to create a shared secret via ECDH with the merchant, for the creation of the view private key of the escrow wallet. The generic name `comms` implies this shared secret can also be used to provide encrypted direct messages features, between the multisig participants.
- `hotkey` - this is the hotkey that is put on the checkout page of the merchant. To facilitate the exchange of messages to perform the wallet setup with 3 out of 6 participants.
