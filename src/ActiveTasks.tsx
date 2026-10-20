import type { RunRecord } from "../shared/types";
import { useT } from "./i18n";

/** Chips for tasks that are running right now, so a task in the background is never out of sight. */
export default function ActiveTasks({
  runs,
  activeIds,
  selectedId,
  onOpen,
}: {
  runs: RunRecord[];
  activeIds: string[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const active = activeIds.map((id) => runs.find((run) => run.id === id)).filter((run): run is RunRecord => !!run);
  // One task on screen needs no strip; it appears when something else is running too.
  if (active.length < 2 && !(active.length === 1 && active[0].id !== selectedId)) return null;
  return (
    <nav className="active-tasks" aria-label={t("Running tasks")}>
      {active.map((run) => {
        const waiting = run.status === "awaiting_approval";
        return (
          <button
            key={run.id}
            type="button"
            className={`active-task ${run.id === selectedId ? "selected" : ""} ${waiting ? "waiting" : ""}`}
            aria-current={run.id === selectedId ? "true" : undefined}
            title={run.prompt}
            onClick={() => onOpen(run.id)}
          >
            <span className={`status-dot ${run.status}`} aria-hidden="true" />
            <span className="active-task-name">{run.prompt}</span>
            {waiting && <em>{t("Needs you")}</em>}
          </button>
        );
      })}
    </nav>
  );
}
