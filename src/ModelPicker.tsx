import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Check,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { api } from "./ui";
import { usePopover } from "./Popover";
import { useVisibleModels } from "./modelVisibility";
import type { ModelInfo } from "../shared/types";
export const tokenCount = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`
    : count >= 1000
      ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
      : String(count);
export default function ModelPicker({
  model,
  onSelect,
  label,
  connection,
  disabled = false,
  placement = "top",
  providerId,
}: {
  model: string;
  label?: string;
  connection?: { baseUrl: string; apiKey?: string };
  onSelect: (model: string, contextWindow?: number, providerId?: string) => void | Promise<void>;
  providerId?: string;
  disabled?: boolean;
  placement?: "top" | "bottom";
}) {
  const id = useId();
  const popup = usePopover({ width: 330, placement });
  const searchRef = useRef<HTMLInputElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const sequence = useRef(0);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const visible = useVisibleModels();
  const [freeOnly, setFreeOnly] = useState(
    localStorage.getItem("relay.freeModels") === "true",
  );
  async function load(refresh = false) {
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ models: ModelInfo[]; warnings?: string[] }>(
        `/api/models${refresh ? "?refresh=1" : ""}`,
        connection
          ? { method: "POST", body: JSON.stringify({ ...connection, refresh }) }
          : undefined,
      );
      if (current === sequence.current) { setModels(result.models); setError(result.warnings?.join(" ") || ""); }
    } catch (error) {
      if (current === sequence.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }
  function open() {
    setSearch("");
    setFreeOnly(localStorage.getItem("relay.freeModels") === "true");
    popup.setOpen(true);
    void load();
  }
  async function choose(info: ModelInfo) {
    await onSelect(info.id, info.contextWindow, info.providerId);
    popup.close(true);
  }
  useEffect(() => {
    if (model && !label) void load();
  }, [model, label, connection?.baseUrl]);
  useEffect(() => {
    if (popup.open) searchRef.current?.focus();
  }, [popup.open]);
  const showProviders = new Set(models.map(model => model.providerId)).size > 1;
  const isCurrent = (info: ModelInfo) =>
    info.id === model && (!providerId || info.providerId === providerId);
  const filtered = models.filter(
    (info) =>
      (visible[info.providerId || providerId || ""]
        ? visible[info.providerId || providerId || ""].includes(info.id) || isCurrent(info)
        : !freeOnly || info.free) &&
      `${info.name} ${info.id} ${info.owner || ""} ${info.providerName || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const name =
    label ||
    models.find((info) => info.id === model && (!providerId || info.providerId === providerId))?.name ||
    (model ? "Selected model" : "Choose model");
  return (
    <>
      <button
        ref={popup.trigger}
        type="button"
        className="model-picker-trigger"
        aria-label="Choose model"
        title={name}
        aria-haspopup="dialog"
        aria-expanded={popup.open}
        aria-controls={popup.open ? id : undefined}
        disabled={disabled}
        onClick={() => (popup.open ? popup.close() : open())}
      >
        <Box size={13} className="model-glyph" />
        <span>{name}</span>
        <ChevronDown size={11} />
      </button>
      {popup.open &&
        createPortal(
          <div
            ref={popup.panel}
            id={id}
            role="dialog"
            aria-label="Model picker"
            className="model-catalogue anchored-popover"
            style={popup.style}
          >
            <div className="catalogue-search">
              <Search size={14} />
              <input
                ref={searchRef}
                aria-label="Search models"
                placeholder="Search models…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    options.current[0]?.focus();
                  }
                }}
              />
              <button
                type="button"
                className={`catalogue-free ${freeOnly ? "selected" : ""}`}
                aria-label="Free models only"
                aria-pressed={freeOnly}
                title="Free models only"
                onClick={() => {
                  setFreeOnly(!freeOnly);
                  localStorage.setItem("relay.freeModels", String(!freeOnly));
                }}
              >
                Free
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Refresh models"
                title="Refresh models"
                disabled={loading}
                onClick={() => load(true)}
              >
                {loading ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
              </button>
            </div>
            <div
              className="catalogue-list"
              role="listbox"
              aria-label="Available models"
            >
              {filtered.map((info, index) => (
                <button
                  ref={(element) => {
                    options.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={info.id === model && (!providerId || info.providerId === providerId)}
                  aria-label={info.name}
                  key={`${info.providerId || ""}:${info.id}`}
                  className="catalogue-model"
                  onClick={() => choose(info)}
                  onKeyDown={(event) => {
                    let next = index;
                    if (event.key === "ArrowDown")
                      next = (index + 1) % filtered.length;
                    else if (event.key === "ArrowUp")
                      next = (index - 1 + filtered.length) % filtered.length;
                    else if (event.key === "Home") next = 0;
                    else if (event.key === "End") next = filtered.length - 1;
                    else return;
                    event.preventDefault();
                    options.current[next]?.focus();
                  }}
                >
                  <span className="catalogue-model-text">{info.name}{showProviders && <small className="model-provider-name">{info.providerName}</small>}</span>
                  <span className="catalogue-model-meta">
                    {info.contextWindow && (
                      <small>{tokenCount(info.contextWindow)}</small>
                    )}
                    {info.id === model && (!providerId || info.providerId === providerId) && <Check size={13} />}
                  </span>
                </button>
              ))}
              {loading && !models.length && (
                <div className="catalogue-empty">Loading models…</div>
              )}
              {!loading && (error || !filtered.length) && (
                <div className="catalogue-empty">
                  {error || "No matching models."}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
