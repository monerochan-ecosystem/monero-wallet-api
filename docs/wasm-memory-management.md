The Monero Wallet API has a core of rust that is compiled to WebAssembly. The resulting piece of wasm is instrumented with typescript. This section gives context and details on the implementation.

## Wasm Memory Model

WebAssembly currently supports a maximum of 4GB memory. There is no way to free memory from a wasm module. It is only possible to allocate more memory over the initial size, a wasm module has been instantiated with. The memory is only freed once the JS Garbage Collector destroys the module when it is out of scope.

## Rust Reference Counting

Rust uses reference counting to free memory when it goes out of scope. When two programming languages interact inside of one program, the question arises who is responsible for allocating and freeing memory.
We let rust mange the allocation and deallocation of memory inside of the WebAssembly module. There are callbacks to the JS runtime with pointer and length to read and write from. Until the callback returns, the JS runtime can read / write and the WebAssembly module takes care of it afterwards.

## Concurrency

Wasm does not support multithreading out of the box. It is important to run [cpu bound](https://en.wikipedia.org/wiki/CPU-bound) tasks like scanning Monero outputs in a separate worker thread if the main thread has to be responsive to IO-events.

## WASI target

The wasm32-wasip1 target has advantages over wasm32-unknown-unknown. It has a clearly defined set of "syscalls". It is a bit like compiling for a target that is POSIX compliant vs compiling to a sparsely documented microcontroller.

The environment WASI expects can be filled in easily, so it works in the browser as well. If you are interested in the details, take a look at the code in the [wasm-processing folder](typescript/wallet-api/wasm-processing).

There are tools that produce a deliverable that is made of javascript and wasm modules.
Emscripten is a typical example for this kind of tool.
It contains a file called [preamble.js](https://emscripten.org/docs/api_reference/preamble.js.html) (C ifdefs mixed with Javascript).
There are more tools like this that use a similar approach but for different languages than CPP. For rust the respective tool is wasm-bindgen.

**The approach that monero-wallet-api takes is different**: It targets wasi instead of the wasm unknown target.
The need for generating a mixture of JS and wasm is sidestepped by constraining the rust code to be focused on purely functional, CPU-bound work. The networking and parallelism is implemented in typescript.

The rust functions are pure functions without side effects with the exception of the initialization of the ViewPair (it is placed on the heap, because it will be needed again and again for every block). The control flow is usually in the hand of the typescript side, with the exception of the [input and output](../rust/src/lib.rs) functions in lib.rs. This is a consequence of letting rust handle the allocation and deallocation of buffers that are passed at the typescript-wasm boundary. Those are set up before each call to a wasm function from the TS side. Think of this like setting up registers as part of a [calling convention](https://en.wikipedia.org/wiki/Calling_convention). The control flow still fundamentallly stays with the TS side and as a result with the library consumer.
