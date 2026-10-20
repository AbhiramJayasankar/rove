import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Search, X } from "lucide-react";
import { api } from "./ui";

type Model = {
  id: string;
  name: string;
  contextWindow?: number;
  free: boolean;
  owner?: string;
};
export const tokenCount = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`
    : count >= 1000
      ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
      : String(count);
export const isThinkingModel = (model: string, format = "auto") =>
  format === "thinking" || (format === "auto" && /mimo/i.test(model));

export default function ModelPicker({
  model,
  onSelect,
  disabled = false,
}: {
  model: string;
  onSelect: (model: string, contextWindow?: number) => void | Promise<void>;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [customId, setCustomId] = useState("");
  const [freeOnly, setFreeOnly] = useState(
    localStorage.getItem("relay.freeModels") !== "false",
  );
  async function load() {
    setLoading(true);
    setError("");
    try {
      setModels((await api<{ models: Model[] }>("/api/models")).models);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }
  function open() {
    setSearch("");
    dialog.current?.showModal();
    void load();
  }
  async function choose(id: string, contextWindow?: number) {
    await onSelect(id, contextWindow);
    dialog.current?.close();
  }
  useEffect(() => () => dialog.current?.close(), []);
  const filtered = models.filter(
    (m) =>
      (!freeOnly || m.free) &&
      `${m.id} ${m.name} ${m.owner || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <button
        type="button"
        className="model-picker-trigger"
        aria-label="Choose model"
        disabled={disabled}
        onClick={open}
        title={model || "Choose a model"}
      >
        <span className="model-glyph" aria-hidden="true">
          ✳
        </span>
        <span>{model || "Choose model"}</span>
        <ChevronDown size={13} />
      </button>
      <dialog
        ref={dialog}
        className="model-catalogue"
        aria-label="Choose a model"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="catalogue-heading">
          <h2>Choose a model</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close model picker"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>
        <div className="catalogue-search">
          <Search size={17} />
          <input
            aria-label="Search models"
            autoFocus
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="catalogue-filter">
          <label>
            <input
              type="checkbox"
              checked={freeOnly}
              onChange={(e) => {
                setFreeOnly(e.target.checked);
                localStorage.setItem(
                  "relay.freeModels",
                  String(e.target.checked),
                );
              }}
            />
            Free models only
          </label>
          <button
            type="button"
            className="text-button"
            onClick={load}
            disabled={loading}
          >
            {loading ? <LoaderCircle size={14} className="spin" /> : "Refresh"}
          </button>
        </div>
        <div className="catalogue-list" aria-label="Available models">
          {filtered.map((m) => (
            <button
              type="button"
              key={m.id}
              className={`catalogue-model ${m.id === model ? "selected" : ""}`}
              aria-label={`Use ${m.id}`}
              onClick={() => choose(m.id, m.contextWindow)}
            >
              <span className="catalogue-model-text">
                <strong>{m.name}</strong>
                <small>{m.id}</small>
              </span>
              <span className="catalogue-model-meta">
                {m.free && <span className="free-label">Free</span>}
                {m.contextWindow && (
                  <span>{tokenCount(m.contextWindow)} context</span>
                )}
                {m.id === model && <Check size={16} />}
              </span>
            </button>
          ))}
          {loading && !models.length && (
            <div className="catalogue-empty">Loading models…</div>
          )}
          {!loading && !filtered.length && (
            <div className="catalogue-empty">
              {error || "No matching models."}
            </div>
          )}
        </div>
        <form
          className="manual-model"
          onSubmit={(e) => {
            e.preventDefault();
            if (customId.trim()) void choose(customId.trim());
          }}
        >
          <input
            aria-label="Custom model ID"
            placeholder="Or enter a model ID"
            value={customId}
            onChange={(e) => setCustomId(e.target.value)}
          />
          <button
            type="submit"
            className="button secondary"
            disabled={!customId.trim()}
          >
            Use ID
          </button>
        </form>
      </dialog>
    </>
  );
}
