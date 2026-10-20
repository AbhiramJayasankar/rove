import { useState } from "react";
import { ArrowUp, MessageCircle } from "lucide-react";
import { useT } from "./i18n";

export default function QuestionActivity({
  question,
  answer,
  waiting,
  disabled,
  onReply,
}: {
  question: string;
  answer?: string;
  waiting: boolean;
  disabled?: boolean;
  onReply?: (message: string) => Promise<void>;
}) {
  const [reply, setReply] = useState("");
  const t = useT();
  return (
    <div
      className="question-activity"
      role={waiting ? "region" : undefined}
      aria-label={waiting ? t("Reply required") : undefined}
    >
      <div className="question-text">
        <MessageCircle size={14} />
        <span>{question}</span>
      </div>
      {answer ? (
        <div className="question-answer">{answer}</div>
      ) : waiting ? (
        <form
          className="question-reply"
          onSubmit={async (event) => {
            event.preventDefault();
            if (reply.trim() && !disabled && onReply)
              await onReply(reply.trim());
          }}
        >
          <input
            aria-label={t("Reply to Rove")}
            placeholder={t("Your answer…")}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            disabled={disabled}
            autoFocus
          />
          <button
            type="submit"
            className="message-confirm-button"
            aria-label={t("Send answer")}
            title={t("Send answer")}
            disabled={disabled || !reply.trim()}
          >
            <ArrowUp size={15} />
          </button>
        </form>
      ) : null}
    </div>
  );
}
