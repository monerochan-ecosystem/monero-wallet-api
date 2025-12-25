#!/usr/bin/env bun

if (Bun.argv.length < 3) {
  console.error("Usage: bun run pop-block.ts <number_of_blocks>");
  process.exit(1);
}

const numBlocks = parseInt(Bun.argv[2], 10);

console.log("run this command to start regtest node:");
console.log("./monerod --regtest --offline --fixed-difficulty 1");
console.log("run this command to start regtest node with persisted fakechain:");
console.log(
  "./monerod --regtest --offline --fixed-difficulty 1 --data-dir ./regtest-data --keep-fakechain --rpc-bind-port 18081 --confirm-external-bind --disable-rpc-ban"
);
console.log("");
console.log("regtest pop_blocks command response:");

(async () => {
  try {
    const response = await fetch("http://127.0.0.1:18081/pop_blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nblocks: numBlocks }),
    });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("Error:", e);
  }
})();
