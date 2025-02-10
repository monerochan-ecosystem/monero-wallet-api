import { ViewPair } from "@spirobel/monero-wallet-api";
import { sleep } from "bun";
export const STAGENET_URL = "http://localhost:38081"; //"http://35.198.32.241:18081"; //"http://83.217.209.212:18089"; // "http://xmr-lux.boldsuck.org:38081"; //http://localhost:38081";

export const PRIMARY_ADDRESS =
  "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9";
export const SECRET_VIEW_KEY =
  "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01";
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
