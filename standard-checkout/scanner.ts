import { ViewPair } from "@spirobel/monero-wallet-api";
import { sleep } from "bun";
import {
  PRIMARY_ADDRESS,
  SECRET_VIEW_KEY,
  STAGENET_URL,
} from "./backend/viewpair";

// prevents TS errors
declare var self: Worker;

self.onmessage = (event: MessageEvent) => {
  console.log(event.data);
  //TODO set currentheight
  postMessage("world");
};
const viewPair = await ViewPair.create(
  PRIMARY_ADDRESS,
  SECRET_VIEW_KEY,
  STAGENET_URL
);
let current_height = 1788708; //1788708; //3342711;  //1731708;
await scanLoop();

async function scanLoop() {
  while (true) {
    try {
      await viewPair.scan(current_height, (result) => {
        postMessage(result);
        if ("new_height" in result) {
          console.log("scanLoop, new height:", current_height, result);
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
