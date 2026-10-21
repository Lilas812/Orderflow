import { useEffect, useRef, useState } from "react";

export interface FieldCtl {
  setFieldError: (key: string, error: string | null) => void;
}

interface NumProps {
  fkey: string; testid: string; label: string; unit?: string; hint?: string;
  value: number; min: number; max?: number; sliderMax: number; step: number;
  integer?: boolean; positive?: boolean; disabled?: boolean;
  extra?: (v: number) => string | null; sig?: string;
  ctl: FieldCtl; onCommit: (v: number) => void;
}

/** Text + slider kept in sync. Invalid text stays local and is reported; update() never sees it. */
export function NumField(p: NumProps) {
  const { fkey, testid, label, unit, hint, value, min, max, sliderMax, step, integer, positive, disabled, extra, sig } = p;
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState<string | null>(null);
  const ctlRef = useRef(p.ctl); ctlRef.current = p.ctl;
  const commitRef = useRef(p.onCommit); commitRef.current = p.onCommit;
  const check = (raw: string): { v?: number; e?: string } => {
    if (raw.trim() === "") return { e: "Blank: enter a number" };
    const v = Number(raw);
    if (!Number.isFinite(v)) return { e: "Not a finite number" };
    if (integer && !Number.isSafeInteger(v)) return { e: "Whole number required" };
    if (positive && v <= 0) return { e: "Must be greater than 0" };
    if (v < min) return { e: `Must be at least ${min}${unit ? " " + unit : ""}` };
    if (max !== undefined && v > max) return { e: `Must be at most ${max}${unit ? " " + unit : ""}` };
    const x = extra?.(v); if (x) return { e: x };
    return { v };
  };
  const onText = (raw: string) => {
    setText(raw);
    const r = check(raw);
    if (r.e) { setErr(r.e); ctlRef.current.setFieldError(fkey, r.e); }
    else { setErr(null); ctlRef.current.setFieldError(fkey, null); commitRef.current(r.v!); }
  };
  useEffect(() => { if (err === null && Number(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (err === null) return;
    const r = check(text);
    if (!r.e) { setErr(null); ctlRef.current.setFieldError(fkey, null); commitRef.current(r.v!); }
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const rangeMax = Math.max(sliderMax, Number.isFinite(value) ? value : sliderMax);
  return (
    <div className="sf">
      <label htmlFor={testid}>{label}{unit ? <span className="sf-unit"> ({unit})</span> : null}</label>
      <div className="sf-row">
        <input id={testid} data-testid={testid} type="text" inputMode="decimal" value={text} disabled={disabled}
          aria-invalid={err !== null} aria-describedby={`${testid}-msg`} onChange={(e) => onText(e.target.value)} />
        <input data-testid={`${testid}-slider`} type="range" aria-label={`${label} slider`} min={min} max={rangeMax} step={step}
          disabled={disabled} value={Math.min(Math.max(value, min), rangeMax)} onChange={(e) => onText(e.target.value)} />
      </div>
      <span id={`${testid}-msg`} className={err ? "sf-err" : "sf-hint"} role={err ? "alert" : undefined} data-testid={`${testid}-error`}>
        {err ?? hint ?? ""}
      </span>
    </div>
  );
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
export function ColorField({ fkey, testid, label, value, ctl, onCommit }: {
  fkey: string; testid: string; label: string; value: string; ctl: FieldCtl; onCommit: (hex: string) => void;
}) {
  const [text, setText] = useState(value.toUpperCase());
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (err === null && text.toUpperCase() !== value.toUpperCase()) setText(value.toUpperCase()); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const onText = (raw: string) => {
    setText(raw);
    if (!HEX.test(raw)) { const e = "Use #RRGGBB (six hex digits)"; setErr(e); ctl.setFieldError(fkey, e); return; }
    setErr(null); ctl.setFieldError(fkey, null); onCommit(raw.toUpperCase());
  };
  return (
    <div className="sf sf-color">
      <label htmlFor={testid}>{label}</label>
      <div className="sf-row">
        <input type="color" aria-label={`${label} picker`} data-testid={`${testid}-picker`}
          value={HEX.test(value) ? value.toLowerCase() : "#000000"} onChange={(e) => onText(e.target.value)} />
        <input id={testid} data-testid={testid} type="text" value={text} maxLength={7} spellCheck={false}
          aria-invalid={err !== null} aria-describedby={`${testid}-msg`} onChange={(e) => onText(e.target.value)} />
      </div>
      <span id={`${testid}-msg`} className="sf-err" role={err ? "alert" : undefined} data-testid={`${testid}-error`}>{err ?? ""}</span>
    </div>
  );
}
