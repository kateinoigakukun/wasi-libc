#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import url from "node:url";
import { chromium } from 'playwright';

const SKIP_TESTS = [
    // "poll_oneoff" can't be implemented in the browser
    "libc-test/functional/pthread_cond",
    // atomic.wait32 can't be executed on the main thread
    "libc-test/functional/pthread_mutex",
];

const __dirname = dirname(fileURLToPath(import.meta.url));

async function startServer({ wasmPath, port }) {
    const server = createServer((req, res) => {
        // Set required headers for SharedArrayBuffer
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

        let filePath;
        const parsed = url.parse(req.url, true);
        const pathname = parsed.pathname;
        if (pathname === "/target.wasm") {
            filePath = wasmPath;
            res.setHeader('Content-Type', 'application/wasm');
        } else {
            filePath = join(__dirname, pathname);
            const contentTypes = {
                "mjs": "text/javascript",
                "js": "text/javascript",
                "html": "text/html",
            }
            res.setHeader('Content-Type', contentTypes[pathname.split('.').pop()] || 'text/plain');
        }

        try {
            const content = readFileSync(filePath);
            res.end(content);
        } catch (error) {
            res.statusCode = 404;
            res.end('Not found');
        }
    });

    return new Promise((resolve) => {
        server.listen(port, () => {
            const port = server.address().port;
            resolve({ server, port });
        });
    });
}

function buildUrl(port) {
    return `http://localhost:${port}/run-test.html`;
}

/** @returns {Promise<{passed: boolean, error?: string}>} */
async function runTest(page, port) {
    const url = buildUrl(port);
    const onExit = new Promise((resolve) => {
        page.exposeFunction("exitTest", resolve);
    });
    await page.goto(url);
    return onExit;
}

async function main() {
    const args = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            wasi: {
                type: "string",
                multiple: true,
            },
            dir: {
                type: "string",
                multiple: true,
            },
            headful: {
                type: "boolean",
                default: false,
            },
            port: {
                type: "string",
                default: "0",
            }
        }
    });

    const wasmPath = args.positionals[0];
    if (!wasmPath) {
        console.error('Test path not specified');
        return 1;
    }

    if (SKIP_TESTS.some(test => wasmPath.includes(test))) {
        return 0;
    }

    const { server, port } = await startServer({ wasmPath, port: parseInt(args.values.port) });
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
        if (args.values.headful) {
            // Run in headful mode to allow manual testing
            console.log(`Please visit ${buildUrl(port)}`);
            console.log('Press Ctrl+C to stop');
            await new Promise(resolve => process.on('SIGINT', resolve));
            return 0;
        }

        // Run in headless mode
        const result = await runTest(page, port);
        if (!result.passed) {
            console.error('Test failed:', result.error);
            return 1;
        }
        return 0;
    } catch (error) {
        console.error('Test failed:', error);
        return 1;
    } finally {
        await browser.close();
        server.close();
    }
}

process.exit(await main());
