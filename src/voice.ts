export type VoiceSettings = { backend: "web" | "api"; baseUrl: string; model: string };
export const DEFAULT_VOICE: VoiceSettings = {
  backend: "web", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo",
};
export const MAX_AUDIO_BYTES = 25_000_000;
export function transcriptionUrl(baseUrl: string) {
  const url = new URL(baseUrl.trim().replace(/\/+$/, "") + "/audio/transcriptions");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error("Use an HTTPS transcription endpoint (or localhost for development).");
  if (url.username || url.password || url.search || url.hash) throw new Error("Use a base URL without credentials, query parameters or fragments.");
  return url;
}
export async function readVoice(): Promise<VoiceSettings> {
  const { voiceSettings } = await chrome.storage.local.get("voiceSettings");
  const stored = voiceSettings as Partial<VoiceSettings> | undefined;
  return { backend: stored?.backend === "api" ? "api" : "web", baseUrl: typeof stored?.baseUrl === "string" ? stored.baseUrl : DEFAULT_VOICE.baseUrl, model: typeof stored?.model === "string" ? stored.model : DEFAULT_VOICE.model };
}
export async function transcribe(audio: Blob, settings: VoiceSettings, key: string, seconds: number, signal?: AbortSignal, request: typeof fetch = fetch): Promise<string> {
  const url = transcriptionUrl(settings.baseUrl);
  if (!key.trim()) throw new Error("Add a transcription API key in Settings → Voice input.");
  if (!settings.model.trim()) throw new Error("Choose a transcription model in Settings → Voice input.");
  if (!audio.size) throw new Error("No audio recorded. Check your microphone and try again.");
  if (audio.size >= MAX_AUDIO_BYTES) throw new Error("Recording reached the 25 MB limit. Try a shorter clip.");
  if (url.hostname === "openrouter.ai" && seconds >= 60) throw new Error("Keep OpenRouter clips under 60 seconds to avoid its transcription timeout.");
  const form = new FormData();
  form.append("file", audio, "dictation.webm");
  form.append("model", settings.model.trim());
  form.append("response_format", "json");
  let response: Response;
  try {
    response = await request(url.href, { method: "POST", headers: { Authorization: `Bearer ${key.trim()}` }, body: form, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]), redirect: "error", credentials: "omit" });
  } catch (error) {
    if (signal?.aborted) throw new Error("Dictation cancelled.");
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("Transcription timed out. Try a shorter clip.");
    throw new Error("Could not reach the transcription service. Check the endpoint and your connection.");
  }
  if (response.status === 401 || response.status === 403) throw new Error("Transcription key was rejected. Check your voice API key in Settings.");
  if (response.status === 429) throw new Error("Transcription rate limit reached. Wait a moment before trying again; your hourly audio allowance may be used up.");
  if (response.status === 413) throw new Error("Recording is too large for this service. Try a shorter clip.");
  if (response.status === 408 || response.status === 504) throw new Error("Transcription timed out. Try a shorter clip.");
  if (!response.ok) throw new Error(`Transcription failed (HTTP ${response.status}). Check the endpoint and model in Settings.`);
  const data = await response.json().catch(() => null);
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("No speech was recognized. Try speaking closer to the microphone.");
  return text;
}
export function microphoneError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (["NotAllowedError", "SecurityError"].includes(name)) return "Microphone permission denied or blocked. Allow Relay in Chrome’s microphone site settings and allow Chrome in your system microphone settings, then try again.";
  if (["NotFoundError", "DevicesNotFoundError"].includes(name)) return "No microphone found. Connect a microphone and try again.";
  if (["NotReadableError", "TrackStartError"].includes(name)) return "Microphone is unavailable. Check whether another app is using it.";
  return error instanceof Error ? error.message : "Could not start microphone capture.";
}
