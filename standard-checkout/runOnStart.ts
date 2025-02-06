export default function runOnStart() {
  const worker = new Worker("./scanner.ts");

  worker.postMessage("hello");
  worker.onmessage = (event) => {
    console.log(event.data);
  };
}
