import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } from 'https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.3.0/+esm'
import { polyfill } from 'https://cdn.jsdelivr.net/npm/wasm-imports-parser@1.0.4/polyfill.js/+esm';

export async function instantiate({ module, addToImports }) {
    const args = ["target.wasm"]
    const env = []
    const fds = [
        new OpenFile(new File([])), // stdin
        ConsoleStdout.lineBuffered((stdout) => {
            console.log(stdout);
        }),
        ConsoleStdout.lineBuffered((stderr) => {
            console.error(stderr);
        }),
        new PreopenDirectory("/", new Map()),
    ];
    const wasi = new WASI(args, env, fds);

    const importObject = {
        wasi_snapshot_preview1: wasi.wasiImport,
    };
    addToImports(importObject);
    const instance = await WebAssembly.instantiate(module, importObject);
    return { wasi, instance };
}

class Threads {
    constructor(poolSize) {
        this.poolSize = poolSize;
        this.workers = [];
        this.nextTid = 1;
        const channel = new SharedArrayBuffer(poolSize * 12);
        this.channel = channel;

        for (let i = 0; i < poolSize; i++) {
            const worker = new Worker("./run-test.worker.mjs", { type: 'module' });
            this.workers.push(worker);
        }
    }

    async warmUp(module, memory) {
        for (let i = 0; i < this.workers.length; i++) {
            this.workers[i].postMessage({ selfFilePath: import.meta.url, module, memory, index: i, channel: this.channel });
        }
        // Wait until all workers are ready
        const view = new Int32Array(this.channel);
        for (let i = 0; i < this.workers.length; i++) {
            const { value } = await Atomics.waitAsync(view, i * 3, 0);
            await value;
        }
    }

    findAvailableWorker() {
        for (let i = 0; i < this.workers.length; i++) {
            const view = new DataView(this.channel);
            const state = view.getUint32(i * 12, true);
            if (state === 1) {
                return i;
            }
        }
        throw new Error("No available worker");
    }

    spawnThread(startArg) {
        const tid = this.nextTid++;
        const index = this.findAvailableWorker();
        const view = new Int32Array(this.channel);
        view[index * 3] = 2;
        view[index * 3 + 1] = tid;
        view[index * 3 + 2] = startArg;
        Atomics.notify(view, index * 3);
        return tid;
    }

    terminateAll() {
        for (const worker of this.workers.values()) {
            worker.terminate();
        }
        this.workers.clear();
    }
}

export async function runWasmTest(wasmPath) {
    const response = await fetch(wasmPath);
    const wasmBytes = await response.arrayBuffer();

    // Polyfill WebAssembly if "Type Reflection JS API" is unavailable.
    // The feature is required to know the imported memory type.
    const WebAssembly = polyfill(globalThis.WebAssembly);

    const module = await WebAssembly.compile(wasmBytes);
    const imports = WebAssembly.Module.imports(module);
    const threads = new Threads(8);

    const { wasi, instance } = await instantiate({
        module,
        addToImports: (importObject) => {
            const memoryImport = imports.find(i => i.module === 'env' && i.name === 'memory');
            if (!memoryImport) {
                return;
            }

            // Add wasi-threads support if memory is imported
            const memoryType = memoryImport.type;
            const memory = new WebAssembly.Memory({
                initial: memoryType.minimum,
                maximum: memoryType.maximum,
                shared: memoryType.shared,
            });
            importObject.env = { memory };
            importObject.wasi = {
                "thread-spawn": (startArg) => {
                    return threads.spawnThread(startArg);
                }
            };
        },
    });

    await threads.warmUp(module, instance.exports.memory);

    wasi.start(instance);
    // threads.terminateAll();
    console.log('Test passed successfully');
    return true;
}

// Worker state memory layout:
// | offset | type | description      |
// | 0      | u32  | state            |
// |        |      | * 0: not started |
// |        |      | * 1: ready       |
// |        |      | * 2: started     |
// |        |      | * 3: finished    |
// | 4      | u32  | tid              |
// | 8      | u32  | startArg         |

export async function startWorker({ channel, index, module, memory }) {
    const int32View = new Int32Array(channel);
    // Mark the worker as ready
    int32View[index * 3] = 1;
    Atomics.notify(int32View, index * 3);
    // Wait until the main thread marks the worker as started
    await (await Atomics.waitAsync(int32View, index * 3, 1)).value;
    const tid = int32View[index * 3 + 1];
    const startArg = int32View[index * 3 + 2];
    await startThread({ module, memory, tid, startArg });
    // Mark the worker as finished
    int32View[index * 3] = 3;
}

export async function startThread({ module, memory, tid, startArg }) {
    const { instance, wasi } = await instantiate({
        module,
        addToImports(importObject) {
            importObject["env"] = { memory }
            importObject["wasi"] = {
                "thread-spawn": () => { throw new Error("Cannot spawn a new thread from a worker thread"); }
            };
        },
    });

    wasi.inst = instance;
    instance.exports.wasi_thread_start(tid, startArg);
}
