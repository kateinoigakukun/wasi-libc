self.onmessage = async (event) => {
    try {
        const { selfFilePath } = event.data;
        const { startWorker } = await import(selfFilePath);
        await startWorker(event.data);
    } catch (e) {
        console.error("Worker error:", e);
    }
}
