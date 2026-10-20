import { useEffect, useRef, useState, type RefObject } from "react";
import { LoaderCircle, Mic, X } from "lucide-react";
import { beginDictation } from "./dictation";
import VoiceWaveform from "./VoiceWaveform";
import { useT } from "./i18n";

type Props = { input: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (text: string) => void; context: string; visible: boolean; onBusy: (busy: boolean) => void };
export default function VoiceInput({ input, value, onChange, context, visible, onBusy }: Props) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "processing">("idle");
  const [seconds, setSeconds] = useState(0);
  const t = useT();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const session = useRef<{ capture: ReturnType<typeof beginDictation>; before: string; update: (value: string) => void } | null>(null);
  const busy = useRef(onBusy); busy.current = onBusy;
  function finish(rollback = false, focus = true) {
    const current = session.current; if (!current) return;
    session.current = null; current.capture.cancel();
    if (rollback) current.update(current.before);
    setPhase("idle"); setStream(null); busy.current(false);
    if (focus) input.current?.focus();
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) { event.preventDefault(); event.stopImmediatePropagation(); finish(true); }
    };
    const leave = () => finish(true, false);
    window.addEventListener("keydown", escape, true); window.addEventListener("pagehide", leave);
    return () => { leave(); window.removeEventListener("keydown", escape, true); window.removeEventListener("pagehide", leave); };
  }, []);
  useEffect(() => { if (!visible) finish(true, false); return () => finish(true, false); }, [context, visible]);
  useEffect(() => setError(""), [context]);
  useEffect(() => {
    if (phase !== "recording") return;
    const began = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - began) / 1000)), 250);
    return () => clearInterval(timer);
  }, [phase]);
  function start() {
    setError(""); setSeconds(0); setPhase("starting"); busy.current(true);
    const start = input.current?.selectionStart ?? value.length, end = input.current?.selectionEnd ?? value.length;
    const insert = (text: string) => onChange(value.slice(0, start) + text + value.slice(end));
    const capture = beginDictation({
      stream: setStream, recording: () => setPhase("recording"), processing: () => setPhase("processing"), text: insert,
      done: text => { insert(text); finish(); requestAnimationFrame(() => input.current?.setSelectionRange(start + text.length, start + text.length)); },
      error: message => { setError(message); finish(true); },
    });
    session.current = { capture, before: value, update: onChange };
  }
  return <>
    <span className="visually-hidden" role="status">{phase === "recording" ? t("Recording. Click the mic to stop; Escape cancels.") : phase === "starting" ? t("Starting microphone.") : phase === "processing" ? t("Transcribing your recording.") : ""}</span>
    {phase !== "idle" && <div className="voice-activity">
      {phase === "recording" ? <><VoiceWaveform stream={stream} /><span role="timer" aria-label={t("Recording duration")}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span></> : <span>{phase === "starting" ? t("Starting microphone…") : t("Transcribing…")}</span>}
      <button type="button" className="voice-button" aria-label={t("Cancel dictation")} onClick={() => finish(true)}><X size={13} /></button>
    </div>}
    <button type="button" className={`voice-button ${phase === "recording" ? "recording" : ""}`} aria-label={phase === "idle" ? t("Start dictation") : phase === "starting" ? t("Cancel microphone setup") : phase === "processing" ? t("Transcribing voice") : t("Stop dictation")} aria-pressed={phase !== "idle"} title={phase === "idle" ? t("Dictate a task") : t("Stop dictation · Escape cancels")} disabled={phase === "processing"} onClick={() => { if (phase === "idle") start(); else if (phase === "starting") finish(true); else session.current?.capture.stop(); }}>
      {phase === "processing" || phase === "starting" ? <LoaderCircle size={15} className="spin" /> : <Mic size={15} />}
    </button>
    {error && <span className="voice-error" role="alert">{error}</span>}
  </>;
}
