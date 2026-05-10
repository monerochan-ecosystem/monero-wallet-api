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
