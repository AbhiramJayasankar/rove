import { useId, useEffect } from "react";
import { createPortal } from "react-dom";
import type { ModelInfo, RunRecord } from "../shared/types";
import { chatUsage } from "../shared/usage";
import { tokenCount } from "./ModelPicker";
import { usePopover } from "./Popover";
const format = (value: number) => value.toLocaleString();
export default function UsageRing({
  run,
  model,
  connected,
}: {
  run?: RunRecord;
  model?: ModelInfo | null;
  connected: boolean;
}) {
  const id = useId();
  const popup = usePopover({ width: 270 });
  useEffect(() => {
    if (popup.open) popup.panel.current?.focus();
  }, [popup.open]);
  const usage = chatUsage(run?.events || [], model);
  const percent = Math.min(100, (usage.current / usage.contextWindow) * 100);
  const total = (value: number, reports: number) =>
    usage.requests && !reports
      ? "Not reported"
      : `${reports < usage.requests ? "≥ " : ""}${format(value)}`;
  return (
    <>
      <button
        ref={popup.trigger}
        type="button"
        className={`usage-ring ${percent > 85 ? "near-limit" : ""} ${!connected ? "disconnected" : ""}`}
        aria-label="Chat usage"
        title={
          connected
            ? `${Math.round(percent)}% context used`
            : "Reconnecting to Relay"
        }
        aria-haspopup="dialog"
        aria-expanded={popup.open}
        aria-controls={popup.open ? id : undefined}
        onClick={() => popup.setOpen(!popup.open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle className="ring-track" cx="12" cy="12" r="10.8" />
          <circle
            className="ring-fill"
            cx="12"
            cy="12"
            r="10.8"
            pathLength="100"
            strokeDasharray={`${percent} 100`}
            transform="rotate(-90 12 12)"
          />
        </svg>
      </button>
      {popup.open &&
        createPortal(
          <div
            ref={popup.panel}
            id={id}
            role="dialog"
            aria-label="Chat usage"
            tabIndex={-1}
            className="usage-popover anchored-popover"
            style={popup.style}
          >
            <div className="usage-heading">
              <strong>Context</strong>
              <span>{Math.round(percent)}%</span>
            </div>
            <div className="usage-context">
              {usage.estimated && usage.current > 0 ? "~" : ""}
              {tokenCount(usage.current)}{" "}
              <span>of {tokenCount(usage.contextWindow)}</span>
            </div>
            <div className="usage-bar">
              <i style={{ width: `${percent}%` }} />
            </div>
            <dl className="usage-totals">
              <dt>Total input tokens</dt>
              <dd>{total(usage.input, usage.inputReports)}</dd>
              <dt>Total output tokens</dt>
              <dd>{total(usage.output, usage.outputReports)}</dd>
              {usage.cached > 0 && (
                <>
                  <dt>Cached input</dt>
                  <dd>{format(usage.cached)}</dd>
                </>
              )}
              {usage.reasoning > 0 && (
                <>
                  <dt>Reasoning tokens</dt>
                  <dd>{format(usage.reasoning)}</dd>
                </>
              )}
              <dt>Estimated cost</dt>
              <dd>
                {usage.cost == null
                  ? "Not available"
                  : new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits:
                        usage.cost > 0 && usage.cost < 0.01 ? 6 : 4,
                      minimumFractionDigits: 2,
                    }).format(usage.cost)}
              </dd>
            </dl>
            {(usage.inputBudget != null || usage.outputBudget != null) && (
              <dl className="usage-limits">
                {usage.inputBudget != null && (
                  <>
                    <dt>Input budget</dt>
                    <dd>{tokenCount(usage.inputBudget)}</dd>
                  </>
                )}
                {usage.outputBudget != null && (
                  <>
                    <dt>Output reserve</dt>
                    <dd>{tokenCount(usage.outputBudget)}</dd>
                  </>
                )}
              </dl>
            )}
            <p className="usage-note">
              {usage.requests} {usage.requests === 1 ? "request" : "requests"}{" "}
              in this chat
              {!connected ? " · Reconnecting" : ""}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
