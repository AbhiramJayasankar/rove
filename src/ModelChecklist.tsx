import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { api } from "./ui";
import { tokenCount } from "./ModelPicker";
import type { ModelInfo } from "../shared/types";
import type { ModelVisibility } from "./modelVisibility";

export default function ModelChecklist({
  providerId,
  connection,
  model,
  visibility,
  onFirstPick,
}: {
  providerId: string;
  connection: { baseUrl: string; apiKey?: string };
  model: string;
  visibility: ModelVisibility;
  onFirstPick: (model: string) => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [reload, setReload] = useState(0);
  const { selected, change } = visibility;
  useEffect(() => {
    if (!connection.baseUrl.trim()) return;
    let current = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api<{ models: ModelInfo[]; warnings?: string[] }>("/api/models", {
          method: "POST",
          body: JSON.stringify({ ...connection, refresh: reload > 0 }),
        });
        if (!current) return;
        setModels(result.models.filter((info) => !info.providerId || info.providerId === providerId));
        setError(result.warnings?.join(" ") || "");
      } catch (failure) {
        if (current) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (current) setLoading(false);
      }
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [providerId, connection.baseUrl, connection.apiKey, reload]);
  const shown = useMemo(
    () =>
      models.filter(
        (info) =>
          (!freeOnly || info.free) &&
          `${info.name} ${info.id} ${info.owner || ""}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [models, freeOnly, search],
  );
  useEffect(() => {
    if (!model && models.length) onFirstPick((models.find((info) => info.free) || models[0]).id);
  }, [models, model]);
  const isOn = (id: string) => selected === null || selected.has(id);
  const count = models.filter((info) => isOn(info.id)).length;
  function apply(ids: string[], on: boolean) {
    const next = new Set(selected ?? models.map((info) => info.id));
    for (const id of ids) on ? next.add(id) : next.delete(id);
    change(next);
    if (on && !model && ids[0]) onFirstPick(ids[0]);
  }
  return (
    <div className="model-checklist">
      <div className="checklist-head">
        <div className="checklist-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="Search models"
            placeholder="Search models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className={`catalogue-free ${freeOnly ? "selected" : ""}`}
            aria-pressed={freeOnly}
            onClick={() => setFreeOnly(!freeOnly)}
          >
            Free
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh models"
            title="Refresh models"
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
        <div className="checklist-bulk">
          <span className="checklist-count">
            <strong>{count}</strong> of {models.length} in chat
          </span>
          <button
            type="button"
            className="text-button"
            disabled={!shown.length}
            onClick={() => apply(shown.map((info) => info.id), true)}
          >
            Select {search || freeOnly ? "shown" : "all"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={!shown.length}
            onClick={() => apply(shown.map((info) => info.id), false)}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="checklist-list" role="group" aria-label="Models shown in chat">
        {shown.map((info) => (
          <label className="checklist-row" key={info.id}>
            <input
              type="checkbox"
              checked={isOn(info.id)}
              aria-label={info.name}
              onChange={(event) => apply([info.id], event.target.checked)}
            />
            <span className="checkmark" aria-hidden="true">
              <Check size={12} strokeWidth={3} />
            </span>
            <span className="checklist-name">
              {info.name}
              {info.free && <em>Free</em>}
            </span>
            {info.contextWindow && <small>{tokenCount(info.contextWindow)}</small>}
          </label>
        ))}
        {loading && !models.length && <p className="checklist-empty">Loading models…</p>}
        {!loading && error && <p className="checklist-empty">{error}</p>}
        {!loading && !error && !shown.length && (
          <p className="checklist-empty">
            {models.length ? "No matching models." : "Add your endpoint and key to list its models."}
          </p>
        )}
      </div>
    </div>
  );
}
