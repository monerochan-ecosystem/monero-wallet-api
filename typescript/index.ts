const fs = require("fs");
const source = fs.readFileSync(
  "../rust/target/wasm32-wasip1/release/monero_wallet_api.wasm"
);
const typedArray = new Uint8Array(source);
var WASI_ESUCCESS = 0;
var WASI_EBADF = 8;
var WASI_EINVAL = 28;
var WASI_ENOSYS = 52;
var WASI_ERRNO_SUCCESS = 0;

var WASI_STDOUT_FILENO = 1;
var mem = null;

function getModuleMemoryDataView() {
  // call this any time you'll be reading or writing to a module's memory
  // the returned DataView tends to be dissaociated with the module's memory buffer at the will of the WebAssembly engine
  // cache the returned DataView at your own peril!!

  return new DataView(mem.buffer);
}

function fd_prestat_get(fd, bufPtr) {
  return WASI_EBADF;
}

function fd_prestat_dir_name(fd, pathPtr, pathLen) {
  return WASI_EINVAL;
}

function environ_sizes_get(environCount, environBufSize) {
  var view = getModuleMemoryDataView();

  view.setUint32(environCount, 0, !0);
  view.setUint32(environBufSize, 0, !0);

  return WASI_ESUCCESS;
}

function fd_write(fd, iovs, iovsLen, nwritten) {
  if (fd > 2) return WASI_ERRNO_BADF;

  const view = getModuleMemoryDataView();
  const memory = mem;

  const buffers = [];

  for (let i = 0; i < iovsLen; i++) {
    const iov = iovs + i * 8;
    const offset = view.getUint32(iov, true);
    const len = view.getUint32(iov + 4, true);

    buffers.push(new Uint8Array(memory.buffer, offset, len));
  }

  const length = buffers.reduce((s, b) => s + b.length, 0);

  const buffer = new Uint8Array(length);
  let offset = 0;

  buffers.forEach((b) => {
    buffer.set(b, offset);
    offset += b.length;
  });

  const string = new TextDecoder("utf-8").decode(buffer).replace(/\n$/, "");

  if (fd === 1) console.log(string);
  else console.error(string);

  view.setUint32(nwritten, buffer.length, true);

  return WASI_ERRNO_SUCCESS;
}

WebAssembly.instantiate(typedArray, {
  wasi_snapshot_preview1: {
    args_get: function () {
      console.log("args_get lol");
    }, // ((param i32 i32) (result i32))
    args_sizes_get: function () {
      console.log("args_sizes_get lol");
    }, // ((param i32 i32) (result i32))

    clock_res_get: this.clock_res_get, // ((param i32 i32) (result i32))
    clock_time_get: () => {
      console.log("clock_time_get");
    }, // ((param i32 i64 i32) (result i32))

    environ_get: function () {
      console.log("environ_get lol");
    }, // ((param i32 i32) (result i32))
    environ_sizes_get: environ_sizes_get, // ((param i32 i32) (result i32))

    fd_advise: undefined, // ((param i32 i64 i64 i32) (result i32))
    fd_allocate: undefined, // ((param i32 i64 i64) (result i32))
    fd_close: function () {
      console.log("fd_close lol");
    }, // ((param i32) (result i32))
    fd_datasync: undefined, // ((param i32) (result i32))
    fd_fdstat_get: function () {
      console.log("fd_fdstat_get lol");
    }, // ((param i32 i32) (result i32))
    fd_fdstat_set_flags: undefined, // ((param i32 i32) (result i32))
    fd_fdstat_set_rights: undefined, // ((param i32 i64 i64) (result i32))
    fd_filestat_get: () => console.log("fd_filestat_get"), // ((param i32 i32) (result i32))
    fd_filestat_set_size: undefined, // ((param i32 i64) (result i32))
    fd_filestat_set_times: undefined, // ((param i32 i64 i64 i32) (result i32))
    fd_pread: undefined, // ((param i32 i32 i32 i64 i32) (result i32))
    fd_prestat_dir_name: fd_prestat_dir_name, // ((param i32 i32 i32) (result i32))
    fd_prestat_get: fd_prestat_get, // ((param i32 i32) (result i32))
    fd_pwrite: undefined, // ((param i32 i32 i32 i64 i32) (result i32))
    fd_read: function (fd, iovsPtr, iovsLength, bytesReadPtr) {
      console.log("fd_read lol", fd, iovsPtr, iovsLength, bytesReadPtr);
    }, // ((param i32 i32 i32 i32) (result i32))
    fd_readdir: undefined, // ((param i32 i32 i32 i64 i32) (result i32))
    fd_renumber: undefined, // ((param i32 i32) (result i32))
    fd_seek: function () {
      console.log("fd_seek lol");
    }, // ((param i32 i64 i32 i32) (result i32))
    fd_sync: undefined, // ((param i32) (result i32))
    fd_tell: undefined, // ((param i32 i32) (result i32))
    fd_write: fd_write, // ((param i32 i32 i32 i32) (result i32))

    path_create_directory: undefined, // ((param i32 i32 i32) (result i32))
    path_filestat_get: () => console.log("path_filestat_get"), // ((param i32 i32 i32 i32 i32) (result i32))
    path_filestat_set_times: undefined, // ((param i32 i32 i32 i32 i64 i64 i32) (result i32))
    path_link: undefined, // ((param i32 i32 i32 i32 i32 i32 i32) (result i32))
    path_open: function () {
      console.log("path_open lol");
    }, // ((param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32))
    path_readlink: undefined, // ((param i32 i32 i32 i32 i32 i32) (result i32))
    path_remove_directory: undefined, // ((param i32 i32 i32) (result i32))
    path_rename: undefined, // ((param i32 i32 i32 i32 i32 i32) (result i32))
    path_symlink: undefined, // ((param i32 i32 i32 i32 i32) (result i32))
    path_unlink_file: undefined, // ((param i32 i32 i32) (result i32))

    poll_oneoff: undefined, // ((param i32 i32 i32 i32) (result i32))

    proc_exit: function () {
      console.log("proc_exit lol");
    }, // ((param i32))
    proc_raise: undefined, // ((param i32) (result i32))

    random_get: this.random_get, // ((param i32 i32) (result i32))

    sched_yield: () => console.log("sched_yield"), // ((result i32))

    sock_recv: undefined, // ((param i32 i32 i32 i32 i32 i32) (result i32))
    sock_send: undefined, // ((param i32 i32 i32 i32 i32) (result i32))
    sock_shutdown: undefined, // ((param i32 i32) (result i32))
  },
  env: {},
}).then((result) => {
  console.log("exports", result.instance.exports);
  mem = result.instance.exports.memory;
  const main = result.instance.exports.init_view_pair;
  //   console.log(result.instance.exports._start())
  console.log(main());
});
