import { useState, type RefObject } from "react";
import { Search, X } from "lucide-react";
import type { RunRecord } from "../shared/types";
import { statusLabels } from "./ui";

export default function HistoryDialog({
  dialogRef,
  runs,
  selectedId,
  onSelect,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  runs: RunRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = runs.filter((run) =>
    run.prompt.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <dialog
      ref={dialogRef}
      className="history-dialog"
      aria-label="Task history"
      onClose={() => setQuery("")}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <div className="dialog-heading">
        <h2>History</h2>
        <button
          className="icon-button"
          aria-label="Close history"
          onClick={() => dialogRef.current?.close()}
        >
          <X size={18} />
        </button>
      </div>
      <label className="history-search">
        <Search size={16} />
        <input
          autoFocus
          aria-label="Search tasks"
          placeholder="Search tasks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="history-list">
        {filtered.map((run) => (
          <button
            key={run.id}
            className="history-item"
            aria-label={run.prompt}
            aria-current={selectedId === run.id ? "page" : undefined}
            onClick={() => {
              onSelect(run.id);
              dialogRef.current?.close();
            }}
          >
            <span
              className={`status-dot ${run.status}`}
              title={statusLabels[run.status]}
            />
            <span className="history-item-title">{run.prompt}</span>
            <time dateTime={run.updatedAt}>
              {new Date(run.updatedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </time>
          </button>
        ))}
        {!filtered.length && (
          <p className="history-empty">
            {query ? "No matching tasks." : "Your tasks will appear here."}
          </p>
        )}
      </div>
    </dialog>
  );
}
