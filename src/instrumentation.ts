export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) {
      throw new Error(
        "ADMIN_PASSWORD is not set. SkanSentinel refuses to start without it."
      );
    }
    const { startWorker } = await import("./lib/worker");
    startWorker();
  }
}
