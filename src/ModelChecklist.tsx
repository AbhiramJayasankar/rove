import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { api } from "./ui";
import { tokenCount } from "./ModelPicker";
import type { ModelInfo } from "../shared/types";
import type { ModelVisibility } from "./modelVisibility";
import { useT } from "./i18n";
import Tooltip from "./Tooltip";
import { ModelFactList } from "./ModelFacts";

export default function ModelChecklist({
  providerId,
  connection,
  model,
  visibility,
  onFirstPick,
  onModels,
}: {
  providerId: string;
  connection: { baseUrl: string; apiKey?: string };
  model: string;
  visibility: ModelVisibility;
  onFirstPick: (model: string) => void;
  onModels?: (models: ModelInfo[]) => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const t = useT();
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
        const own = result.models.filter((info) => !info.providerId || info.providerId === providerId);
        setModels(own);
        onModels?.(own);
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
  // Word order differs by language, so the count sits inside the translated sentence.
  const inChat = t("{count} of {n} in chat", { count: "\u0000", n: models.length }).split("\u0000");
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
            aria-label={t("Search models")}
            placeholder={t("Search models…")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className={`catalogue-free ${freeOnly ? "selected" : ""}`}
            aria-pressed={freeOnly}
            onClick={() => setFreeOnly(!freeOnly)}
          >
            {t("Free")}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Refresh models")}
            title={t("Refresh models")}
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
        <div className="checklist-bulk">
          <span className="checklist-count">
            {inChat[0]}<strong>{count}</strong>{inChat[1]}
          </span>
          <button
            type="button"
            className="text-button"
            disabled={!shown.length}
            onClick={() => apply(shown.map((info) => info.id), true)}
          >
            {search || freeOnly ? t("Select shown") : t("Select all")}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={!shown.length}
            onClick={() => apply(shown.map((info) => info.id), false)}
          >
            {t("Clear")}
          </button>
        </div>
      </div>
      <div className="checklist-list" role="group" aria-label={t("Models shown in chat")}>
        {shown.map((info) => (
          <div className="checklist-item" key={info.id}>
          <label className="checklist-row">
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
              {info.free && <em>{t("Free")}</em>}
            </span>
            {info.contextWindow && <small>{tokenCount(info.contextWindow)}</small>}
          </label>
          <Tooltip label={t("Details for {name}", { name: info.name })} width={340}>
            <strong className="tool-details-name">{info.name}</strong>
            <ModelFactList model={info} />
          </Tooltip>
          </div>
        ))}
        {loading && !models.length && <p className="checklist-empty">{t("Loading models…")}</p>}
        {!loading && error && <p className="checklist-empty">{error}</p>}
        {!loading && !error && !shown.length && (
          <p className="checklist-empty">
            {models.length ? t("No matching models.") : t("Add your endpoint and key to list its models.")}
          </p>
        )}
      </div>
    </div>
  );
}
