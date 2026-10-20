import type { RunRecord } from "../shared/types";
import { useState, useEffect, useRef, useImperativeHandle, type Ref } from "react";
import { Pencil, X, Check } from "lucide-react";
import ExecutionLog from "./ExecutionLog";
import { AssistantMessage } from "./ui";
export type ConversationHandle = { editLatest: () => void };
export default function Conversation({
  run,
  onEdit,
  disabled,
  onReply,
  replyPending,
  editorRef,
}: {
  run: RunRecord;
  onEdit: (id: number, message: string) => Promise<boolean>;
  disabled: boolean;
  onReply?: (message: string) => Promise<void>;
  replyPending?: boolean;
  editorRef?: Ref<ConversationHandle>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const editInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const input = editInput.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(180, Math.max(28, input.scrollHeight))}px`;
  }, [editing, draft]);
  const turns: { id: number; prompt: string; events: RunRecord["events"] }[] = [
    { id: 0, prompt: run.prompt, events: [] },
  ];
  for (const event of run.events) {
    if (event.type === "user_message")
      turns.push({ id: event.id, prompt: event.data.message, events: [] });
    else turns.at(-1)!.events.push(event);
  }
  useImperativeHandle(editorRef, () => ({
    editLatest() {
      const latest = turns.at(-1)!;
      setDraft(latest.prompt);
      setEditing(latest.id);
    },
  }));
  return (
    <>
      {turns.map((turn, index) => {
        const last = index === turns.length - 1;
        const record = {
          ...run,
          events: turn.events,
          status: last
            ? run.status
            : turn.events.findLast((event) => event.type === "status")?.data
                .status || "completed",
        };
        return (
          <section className="conversation-turn" key={`${run.id}:${turn.id}`}>
            {editing === turn.id ? (
              <form
                className="message-editor"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!draft.trim() || disabled) return;
                  if (await onEdit(turn.id, draft.trim())) setEditing(null);
                }}
              >
                <textarea
                  ref={editInput}
                  rows={1}
                  aria-label="Edit message"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(null);
                    }
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  autoFocus
                  disabled={disabled}
                />
                <div className="message-editor-footer">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Cancel edit"
                    title="Cancel edit"
                    onClick={() => setEditing(null)}
                  >
                    <X size={14} />
                  </button>
                  <button
                    type="submit"
                    className="message-confirm-button"
                    aria-label="Save and run"
                    title="Save and run"
                    disabled={disabled || !draft.trim()}
                  >
                    <Check size={15} />
                  </button>
                </div>
              </form>
            ) : (
              <div className="user-message editable-message">
                <span>{turn.prompt}</span>
                <button
                  type="button"
                  className="message-edit-button"
                  aria-label="Edit message"
                  title="Edit message"
                  disabled={disabled}
                  onClick={() => {
                    setDraft(turn.prompt);
                    setEditing(turn.id);
                  }}
                >
                  <Pencil size={12} />
                </button>
              </div>
            )}
            <ExecutionLog
              run={record}
              onReply={onReply}
              replyPending={replyPending}
            />
            {turn.events.map((event) =>
              event.type === "model_response" &&
              !event.data.message?.tool_calls?.length &&
              event.data.message?.content ? (
                <AssistantMessage
                  key={event.id}
                  content={String(event.data.message.content)}
                />
              ) : event.type === "error" ? (
                <div
                  key={event.id}
                  className={
                    event.type === "error" ? "activity-error" : "user-message"
                  }
                >
                  {String(event.data.message)}
                </div>
              ) : null,
            )}
          </section>
        );
      })}
    </>
  );
}
