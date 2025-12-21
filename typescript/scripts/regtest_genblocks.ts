#!/usr/bin/env bun

if (Bun.argv.length < 3) {
  console.error("Usage: bun run script.ts <wallet_address>");
  process.exit(1);
}

const walletAddress = Bun.argv[2];
const payload = {
  jsonrpc: "2.0",
  id: "0",
  method: "generateblocks",
  params: {
    amount_of_blocks: 1,
    wallet_address: walletAddress,
  },
};
console.log("run this command to start regtest node:");
console.log("./monerod --regtest --offline --fixed-difficulty 1");
console.log("");
console.log("regest generateblocks command response:");
(async () => {
  try {
    const response = await fetch("http://127.0.0.1:18081/json_rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("Error:", e);
  }
})();
