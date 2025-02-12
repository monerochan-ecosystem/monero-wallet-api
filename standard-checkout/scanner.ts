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
let current_height = 1788708; //1788708; //3342711;  //1731708;
await scanLoop();

async function scanLoop() {
  while (true) {
    try {
      await viewPair.scan(current_height, (result) => {
        //TODO insert scan result
        if ("new_height" in result) {
          for (const output of result.outputs) {
            try {
              const newOutputRow = db
                .insert(schema.outputs)
                .values(output)
                .onConflictDoNothing()
                .returning()
                .get();
              console.log("new row", newOutputRow);
              const checkoutSession = db
                .select()
                .from(schema.checkoutSession)
                .where(eq(schema.checkoutSession.id, output.payment_id))
                .get();
              if (checkoutSession) {
                const allOutputsWithPaymentId = db
                  .select()
                  .from(schema.outputs)
                  .where(eq(schema.outputs.payment_id, output.payment_id))
                  .all();
                let totalAmount = 0;
                for (const savedOutput of allOutputsWithPaymentId) {
                  totalAmount += savedOutput.amount;
                }
                if (totalAmount >= output.amount * 1000000000000)
                  console.log(output.payment_id, totalAmount, checkoutSession);
                db.update(schema.checkoutSession)
                  .set({ paidStatus: true })
                  .returning()
                  .get();
              }

              console.log(output.payment_id, output, checkoutSession);
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
