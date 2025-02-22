#!/bin/sh

RPC_USER="${RPC_USER:=serai}"
RPC_PASS="${RPC_PASS:=seraidex}"

# Run Monero
monerod --non-interactive --regtest --offline --fixed-difficulty=1 \
  --no-zmq --rpc-bind-ip=0.0.0.0 --rpc-bind-port=18081 --confirm-external-bind \
  --rpc-access-control-origins "*" --disable-rpc-ban \
  --rpc-login=$RPC_USER:$RPC_PASS --log-level 2 \
  $1
