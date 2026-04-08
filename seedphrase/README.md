# seedphrase

This package collects functions to generate wallet secrets from a bip39 seedphrase + wallet route + seedphrase offset passphrase.

The purpose is to help users keep their online identities compartmentalized.

## Usage

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
