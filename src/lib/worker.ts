import { getDb, setWorkerHeartbeat, nowSeconds } from "./db";
import { runCheckerPass } from "./engine";
import { sendPendingAlerts } from "./alerts";

declare global {
  // eslint-disable-next-line no-var
  var __skansentinel_worker_started: boolean | undefined;
}

let checkerTimer: NodeJS.Timeout | null = null;
let senderTimer: NodeJS.Timeout | null = null;

export function startWorker(): void {
  if (globalThis.__skansentinel_worker_started) return;
  globalThis.__skansentinel_worker_started = true;

  // Immediate heartbeat so the dashboard banner clears on boot.
  try {
    setWorkerHeartbeat(nowSeconds(), getDb());
  } catch (e) {
    console.error("[worker] initial heartbeat failed", e);
  }

  checkerTimer = setInterval(() => {
    try {
      runCheckerPass();
    } catch (e) {
      console.error("[checker] pass failed", e);
    }
  }, 5000);
  senderTimer = setInterval(() => {
    sendPendingAlerts().catch((e) => console.error("[sender] pass failed", e));
  }, 3000);
  if (checkerTimer.unref) checkerTimer.unref();
  if (senderTimer.unref) senderTimer.unref();
  console.log("[worker] SkanSentinel background worker started");
}

export function stopWorkerForTests(): void {
  if (checkerTimer) clearInterval(checkerTimer);
  if (senderTimer) clearInterval(senderTimer);
  checkerTimer = null;
  senderTimer = null;
  globalThis.__skansentinel_worker_started = false;
}
