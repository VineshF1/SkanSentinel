"use client";

import { memo, useEffect, useRef, useState, Fragment } from "react";

type Props = {
  onClose: () => void;
  onDone: () => void;
};

const INPUT =
  "w-full rounded-md border border-[#262b31] bg-[#0b0c0e] px-2.5 py-1.5 text-sm text-[#e8eaed] placeholder:text-[#6b7280]";

const FIELDS: Array<[string, string, string, string]> = [
  ["name", "Name", "text", "Nightly Database Backup"],
  ["slug", "Slug", "text", "nightly-database-backup"],
  ["cron_expression", "Cron expression", "text", "* * * * *"],
  ["timezone", "Timezone", "text", "UTC"],
  ["grace_minutes", "Grace minutes", "number", "5"],
  ["max_runtime_minutes", "Max runtime minutes", "number", "30"],
];

function slugify(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function NewMonitorForm({ onClose, onDone }: Props) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    cron_expression: "",
    timezone: "Asia/Kolkata",
    grace_minutes: "5",
    max_runtime_minutes: "30",
    alert_channel_type: "none",
    alert_channel_url: "",
  });
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Focus once on mount. (A previous version re-ran this on every dashboard
  // refresh and stole focus back to the name field while typing elsewhere.)
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set(k: string, v: string) {
    setForm((f) => {
      const next = { ...f, [k]: v };
      if (k === "name" && (f.slug === "" || f.slug === slugify(f.name))) {
        next.slug = slugify(v);
      }
      return next;
    });
  }

  useEffect(() => {
    if (!form.cron_expression.trim()) {
      setPreview(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/cron-preview?expr=${encodeURIComponent(form.cron_expression)}&tz=${encodeURIComponent(form.timezone || "Asia/Kolkata")}`
        );
        const j = await r.json();
        if (j.ok) {
          setPreviewError(false);
          setPreview(
            `${j.text}. Next: ${j.next
              .map((n: number) => new Date(n * 1000).toLocaleString())
              .join("  ·  ")}`
          );
        } else {
          setPreviewError(true);
          setPreview(j.error ?? "Invalid schedule");
        }
      } catch {
        setPreviewError(true);
        setPreview("Preview unavailable");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [form.cron_expression, form.timezone]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const r = await fetch("/api/monitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          grace_minutes: Number(form.grace_minutes),
          max_runtime_minutes: Number(form.max_runtime_minutes),
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErrors(j.errors ?? { form: j.error ?? "Could not create monitor" });
        return;
      }
      onDone();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New monitor"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-[#262b31] bg-[#141619] p-5"
      >
        <h2 className="text-base font-semibold">New monitor</h2>
        <p className="mt-0.5 text-sm text-[#9aa1a9]">
          SkanSentinel expects a ping on this schedule. Missing pings raise the alarm.
        </p>

        <div className="mt-4 space-y-3">
          {FIELDS.map(([k, label, type, ph]) => (
            <Fragment key={k}>
              <div>
                <label
                  htmlFor={`nm-${k}`}
                  className="mb-1 block text-xs font-medium text-[#9aa1a9]"
                >
                  {label}
                </label>
                <input
                  id={`nm-${k}`}
                  ref={k === "name" ? nameRef : undefined}
                  type={type}
                  value={form[k as keyof typeof form]}
                  onChange={(e) => set(k, e.target.value)}
                  placeholder={ph}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT}${k === "cron_expression" ? " font-mono tabular-nums" : ""}`}
                  aria-invalid={Boolean(errors[k])}
                />
                {errors[k] && (
                  <p role="alert" className="mt-1 text-xs text-rose-300">
                    {errors[k]}
                  </p>
                )}
              </div>
              {k === "cron_expression" && preview && (
                <p
                  role="status"
                  className={`-mt-1 text-xs ${previewError ? "text-rose-300" : "text-[#9aa1a9]"}`}
                >
                  {preview}
                </p>
              )}
            </Fragment>
          ))}

          <div>
            <label
              htmlFor="nm-channel"
              className="mb-1 block text-xs font-medium text-[#9aa1a9]"
            >
              Alert channel
            </label>
            <select
              id="nm-channel"
              value={form.alert_channel_type}
              onChange={(e) => set("alert_channel_type", e.target.value)}
              className={INPUT}
            >
              <option value="none">None</option>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="webhook">Generic webhook</option>
            </select>
            {errors.alert_channel_type && (
              <p role="alert" className="mt-1 text-xs text-rose-300">
                {errors.alert_channel_type}
              </p>
            )}
          </div>

          {form.alert_channel_type !== "none" && (
            <div>
                <label
                  htmlFor="nm-url"
                  className="mb-1 block text-xs font-medium text-[#9aa1a9]"
                >
                  Webhook URL
                </label>
                <input
                  id="nm-url"
                  type="url"
                  inputMode="url"
                  value={form.alert_channel_url}
                  onChange={(e) => set("alert_channel_url", e.target.value)}
                  placeholder="https://…"
                  className={INPUT}
                  aria-invalid={Boolean(errors.alert_channel_url)}
                />
                {errors.alert_channel_url && (
                  <p role="alert" className="mt-1 text-xs text-rose-300">
                    {errors.alert_channel_url}
                  </p>
                )}
              </div>
            )}

          {errors.form && (
            <p role="alert" className="text-xs text-rose-300">
              {errors.form}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[#262b31] px-3.5 py-1.5 text-sm text-[#9aa1a9]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-emerald-500 px-3.5 py-1.5 text-sm font-semibold text-emerald-950 disabled:opacity-60"
          >
            {saving ? "Creating…" : "Create monitor"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default memo(NewMonitorForm);
