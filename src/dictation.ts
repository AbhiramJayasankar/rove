import { MAX_AUDIO_BYTES, microphoneError, readVoice, transcribe, transcriptionUrl } from "./voice";

type Recognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null; onstart: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type Callbacks = {
  stream: (stream: MediaStream | null) => void;
  recording: () => void; processing: () => void;
  text: (text: string) => void; done: (text: string) => void;
  error: (message: string) => void;
};

// Only permission setup needs a normal page if Chrome cannot prompt in a panel.
async function microphone(signal: AbortSignal): Promise<MediaStream> {
  const permission = await navigator.permissions.query({ name: "microphone" as PermissionName }).catch(() => null);
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  if (permission?.state === "prompt") {
    await new Promise<void>((resolve, reject) => {
      const channel = new BroadcastChannel(`rove-mic-${crypto.randomUUID()}`);
      let windowId: number | undefined, finished = false;
      const complete = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timeout); channel.close();
        chrome.windows.onRemoved.removeListener(removed); signal.removeEventListener("abort", cancelled);
        if (windowId !== undefined) void chrome.windows.remove(windowId).catch(() => {});
        error ? reject(error) : resolve();
      };
      const removed = (id: number) => { if (id === windowId) complete(new Error("Microphone setup closed. Click the mic to try again.")); };
      const cancelled = () => complete(new DOMException("Cancelled", "AbortError"));
      const timeout = setTimeout(() => complete(new Error("Microphone setup timed out. Allow Rove’s microphone access, then try again.")), 90_000);
      chrome.windows.onRemoved.addListener(removed); signal.addEventListener("abort", cancelled, { once: true });
      channel.onmessage = event => {
        if (event.data?.type === "granted") complete();
        if (event.data?.type === "error") complete(new Error(event.data.error || "Microphone permission denied."));
      };
      void chrome.windows.create({ url: chrome.runtime.getURL(`index.html?voice=${channel.name.slice("rove-mic-".length)}`), type: "popup", width: 420, height: 260 }).then(window => {
        windowId = window?.id;
        if (finished && windowId !== undefined) void chrome.windows.remove(windowId).catch(() => {});
      }).catch(() => complete(new Error("Could not open microphone permission setup.")));
    });
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  if (signal.aborted) { stream.getTracks().forEach(t => t.stop()); throw new DOMException("Cancelled", "AbortError"); }
  return stream;
}

export function beginDictation(callbacks: Callbacks) {
  const abort = new AbortController();
  let stream: MediaStream | undefined, recorder: MediaRecorder | undefined, recognition: Recognition | undefined;
  let done = false, stopping = false, started = 0, words = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function release() {
    clearInterval(timer); clearTimeout(deadline); abort.abort();
    if (recognition) { recognition.onend = null; recognition.onerror = null; recognition.abort(); }
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach(t => t.stop()); callbacks.stream(null);
  }
  function fail(error: unknown) {
    if (done) return;
    done = true; release(); callbacks.error(microphoneError(error));
  }
  function finish(text: string) {
    if (done) return;
    done = true; release(); callbacks.done(text);
  }
  function cancel() { if (!done) { done = true; release(); } }
  function stop() {
    if (done || stopping) return;
    stopping = true;
    if (!started) { fail(new Error("Microphone has not started yet. Try again.")); return; }
    callbacks.processing(); clearInterval(timer);
    deadline = setTimeout(() => fail(new Error("Transcription timed out. Try a shorter clip.")), 65_000);
    recognition?.stop();
    if (recorder?.state === "recording") recorder.stop();
  }
  void (async () => {
    try {
      const settings = await readVoice();
      if (done) return;
      const api = settings.backend === "api";
      const stored = api ? (await chrome.storage.local.get("voiceApiKey")).voiceApiKey : "";
      const key = typeof stored === "string" ? stored : "";
      if (api && !key.trim()) throw new Error("Add a transcription API key in Settings → Voice input.");
      if (api) transcriptionUrl(settings.baseUrl);
      const Constructor = (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
      if (!api && !Constructor) throw new Error("Web Speech is unavailable in this Chrome build. Choose Groq / compatible API in Settings.");
      if (done) return;
      stream = await microphone(abort.signal);
      if (done) { stream.getTracks().forEach(t => t.stop()); return; }
      callbacks.stream(stream);
      const recording = () => {
        if (done) return;
        started = Date.now(); callbacks.recording();
        timer = setInterval(() => {
          if (api && (Date.now() - started) / 1000 >= (new URL(settings.baseUrl).hostname === "openrouter.ai" ? 59 : 600)) stop();
        }, 250);
      };
      if (!api) {
        recognition = new Constructor!();
        recognition.continuous = true; recognition.interimResults = true; recognition.lang = navigator.language || "en-US";
        recognition.onstart = recording;
        recognition.onresult = event => {
          words = Array.from(event.results).map(result => result[0].transcript.trim()).filter(Boolean).join(" ");
          callbacks.text(words);
        };
        recognition.onerror = event => fail(new Error(({
          "not-allowed": microphoneError(new DOMException("", "NotAllowedError")),
          "service-not-allowed": "Chrome blocked speech recognition. Allow microphone access or choose the API backend.",
          "audio-capture": "No usable microphone found.", network: "Chrome speech recognition could not connect. Check your internet connection.",
          "no-speech": "No speech was recognized. Try again.",
        } as Record<string, string>)[event.error] || "Speech recognition stopped unexpectedly. Try again."));
        recognition.onend = () => words ? finish(words) : fail(new Error("No speech was recognized. Try again."));
        recognition.start();
      } else {
        if (!MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) throw new Error("This Chrome build cannot record WebM/Opus audio.");
        const chunks: Blob[] = []; let bytes = 0;
        recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000 });
        recorder.ondataavailable = event => {
          if (done) return;
          bytes += event.data.size;
          if (bytes >= MAX_AUDIO_BYTES) { fail(new Error("Recording reached the 25 MB limit. Try a shorter clip.")); return; }
          chunks.push(event.data);
        };
        recorder.onerror = () => fail(new Error("Microphone recording failed. Try again."));
        recorder.onstop = () => {
          stream?.getTracks().forEach(t => t.stop()); callbacks.stream(null);
          if (done) return;
          callbacks.processing();
          void transcribe(new Blob(chunks, { type: "audio/webm" }), settings, key, (Date.now() - started) / 1000, abort.signal).then(finish).catch(fail);
        };
        recorder.start(250); recording();
      }
    } catch (error) { fail(error); }
  })();
  return { stop, cancel };
}
