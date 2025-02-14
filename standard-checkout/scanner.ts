import { ViewPair } from "@spirobel/monero-wallet-api";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./db/schema.ts";
import {
  PRIMARY_ADDRESS,
  SECRET_VIEW_KEY,
  STAGENET_URL,
  START_HEIGHT,
} from "./backend/viewpair";
import { eq } from "drizzle-orm";
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
let current_height = START_HEIGHT;
const syncState = db.select().from(schema.syncState).get();
if (syncState && syncState?.height > current_height)
  current_height = syncState?.height;

await scanLoop();

async function scanLoop() {
  while (true) {
    try {
      await viewPair.scan(current_height, (result) => {
        if ("new_height" in result) {
          for (const unsavedOutput of result.outputs) {
            try {
              const newOutputRow = db
                .insert(schema.outputs)
                .values(unsavedOutput)
                .onConflictDoNothing()
                .returning()
                .get();
              if (!newOutputRow) continue;
              const checkoutSession = db
                .select()
                .from(schema.checkoutSession)
                .where(eq(schema.checkoutSession.id, newOutputRow.payment_id))
                .get();
              if (checkoutSession) {
                const allOutputsWithPaymentId = db
                  .select()
                  .from(schema.outputs)
                  .where(eq(schema.outputs.payment_id, newOutputRow.payment_id))
                  .all();
                let totalAmount = 0;
                for (const savedOutput of allOutputsWithPaymentId) {
                  totalAmount += savedOutput.amount;
                }
                if (totalAmount >= checkoutSession.amount * 1000000000000)
                  db.update(schema.checkoutSession)
                    .set({ paidStatus: true })
                    .where(eq(schema.checkoutSession.id, checkoutSession.id))
                    .returning()
                    .get();
              }
            } catch (error) {
              console.log("new output row ", error);
            }
          }
          if (result.outputs.length > 0) {
          }
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
