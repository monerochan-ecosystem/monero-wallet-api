import { ViewPair } from "@spirobel/monero-wallet-api";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./db/schema.ts";
import { sleep } from "bun";
import {
  PRIMARY_ADDRESS,
  SECRET_VIEW_KEY,
  STAGENET_URL,
} from "./backend/viewpair";
const db = drizzle(new Database("./db/sqlite.db"), {
  schema,
});
// prevents TS errors
declare var self: Worker;

const viewPair = await ViewPair.create(
  PRIMARY_ADDRESS,
  SECRET_VIEW_KEY,
  STAGENET_URL
);
//TODO:set current height from db
let current_height = 1788708; //1788708; //3342711;  //1731708;
await scanLoop();

async function scanLoop() {
  while (true) {
    try {
      await viewPair.scan(current_height, (result) => {
        //TODO insert scan result
        if ("new_height" in result) {
          console.log("scanLoop, new height:", current_height, result);
          const syncStateRow = db
            .insert(schema.syncState)
            .values({ height: current_height, id: 1 })
            .onConflictDoUpdate({
              target: schema.syncState.id,
              set: { height: current_height },
            })
            .returning()
            .get();
          if (current_height < result.new_height)
            current_height = result.new_height;
        }
      });
    } catch (error) {
      console.log(error);
    }

    Bun.sleepSync(1000);
  }
}
