## Coins vs Accounts

There are two models of implementing payment systems: Utxo based and Account based.

**Account based systems** work according to the mental model of bank accounts. A transfer specifies a sending and a receiving account and an amount.

**Utxo based transactions** are more like physical cash transfers. Utxo stands for unspent transaction output. In practice it can be viewed as akin to a metal coin that is handed to someone.

**Monero is a utxo based currency.** In the context of Monero they are often just called "outputs".

One approach is not inherently better or worse than the other. Unspent Transaction outputs can be looked at as miniature accounts that get passed around. The key takeaway is that **in utxo based systems the value is contained in the outputs.**

## Nodes

The nodes are responsible for verifying the [consensus rules](https://monero-book.cuprate.org/consensus_rules.html). Nodes connect in a p2p fashion to exchange blocks. The transactions in these blocks are checked to not double spend transaction outputs.

The nodes offer the blocks, transactions and outputs via a [REST api](https://docs.getmonero.org/rpc-library/monerod-rpc/) for the wallets to fetch.

## Wallets and Payment Gateways

There is some overlap between wallets and payment gateways: both need to fetch outputs from the node and decrypt them. The difference is that wallets also implement the ability to spend outputs and handle spend keys.

The [burning bug](https://web.getmonero.org/2018/09/25/a-post-mortum-of-the-burning-bug.html) means that there is also the responsibility to ensure that the received outputs are actually spendable. This is achieved by recording the so called "stealth address" of each output and validating that there are no two outputs with the same stealth address. One way to achieve this is via a uniqueness constraint on the database table that saves the outputs.
