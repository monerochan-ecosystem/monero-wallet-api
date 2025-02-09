declare global {
  var scanworker: Worker;
}
export default function runOnStart() {
  if (!global.scanworker) {
    global.scanworker = new Worker("./scanner.ts");

    scanworker.postMessage("hello");
    scanworker.onmessage = (event) => {
      console.log(event.data);
    };
  }
}
