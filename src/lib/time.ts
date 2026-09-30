/** Epoch seconds everywhere. Date.now() is ms — never store/compare it directly. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function secondsAgo(sec: number, agoSeconds: number): number {
  return sec - agoSeconds;
}

export function formatAgo(epochSec: number | null, nowSec: number): string {
  if (epochSec === null || epochSec === undefined) return "never";
  const d = nowSec - epochSec;
  if (d < 0) return "in the future";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function formatIn(epochSec: number | null, nowSec: number): string {
  if (epochSec === null || epochSec === undefined) return "n/a";
  const d = epochSec - nowSec;
  if (d < 0) return `${formatAgo(epochSec, nowSec).replace(" ago", "")} overdue`;
  if (d < 60) return `in ${d}s`;
  if (d < 3600) return `in ${Math.floor(d / 60)}m`;
  if (d < 86400) return `in ${Math.floor(d / 3600)}h`;
  return `in ${Math.floor(d / 86400)}d`;
}
