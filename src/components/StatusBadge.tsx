import { memo } from "react";

const STYLES: Record<string, string> = {
  HEALTHY: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  RUNNING: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  LATE: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  MISSED: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  FAILED: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  RUNAWAY: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  PENDING: "border-neutral-500/30 bg-neutral-500/10 text-neutral-300",
  PAUSED: "border-neutral-500/30 bg-neutral-500/10 text-neutral-400",
};

const PULSE = new Set(["RUNNING", "FAILED", "MISSED", "RUNAWAY"]);

/** Status is never color alone: always a text label, plus a dot for active states. */
function StatusBadge({ status }: { status: string }) {
  const cls = STYLES[status] ?? STYLES.PENDING;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {PULSE.has(status) && (
        <span aria-hidden="true" className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {status}
    </span>
  );
}

export default memo(StatusBadge);
