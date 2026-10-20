import { useEffect, useState } from "react";
import { DEFAULT_VOICE, readVoice, transcriptionUrl, type VoiceSettings as Options } from "./voice";
import { Check, Cloud, Mic } from "lucide-react";

export function useVoiceSettings() {
  const [value, setValue] = useState<Options>(DEFAULT_VOICE);
  const [key, setKey] = useState("");
  const [changed, setChanged] = useState(false);
  const [savedKey, setSavedKey] = useState(false);
  useEffect(() => { void readVoice().then(setValue); void chrome.storage.local.get("voiceApiKey").then(v => setSavedKey(!!v.voiceApiKey)); }, []);
  async function save() {
      if (value.backend === "api") { transcriptionUrl(value.baseUrl); if (!value.model.trim()) throw new Error("Enter a transcription model."); }
      await chrome.storage.local.set({ voiceSettings: value, ...(changed ? { voiceApiKey: key.trim() } : {}) });
      if (changed) setSavedKey(!!key.trim());
      setKey(""); setChanged(false);
  }
  return { value, setValue, key, setKey, setChanged, savedKey, save };
}
const backends: { value: Options["backend"]; label: string; note: string; Icon: typeof Mic }[] = [
  { value: "web", label: "Web Speech", note: "No key. Chrome sends audio to Google.", Icon: Mic },
  { value: "api", label: "Groq / compatible API", note: "Audio goes to your endpoint.", Icon: Cloud },
];
export default function VoiceSettings({ voice }: { voice: ReturnType<typeof useVoiceSettings> }) {
  const { value, setValue, key, setKey, setChanged, savedKey } = voice;
  return <section className="voice-settings">
    <h2 className="settings-title">Speech to text</h2>
    <div className="panel voice-panel">
      <div className="backend-tiles" role="radiogroup" aria-label="Dictation backend">
        {backends.map(({ value: id, label, note, Icon }) => <button key={id} type="button" role="radio" aria-checked={value.backend === id} className="backend-tile" onClick={() => setValue({ ...value, backend: id })}>
          <Icon size={18} aria-hidden="true" /><strong>{label}</strong><small>{note}</small>
        </button>)}
      </div>
      {value.backend === "api" && <>
        <label className="field"><span>Transcription base URL</span><input type="url" value={value.baseUrl} onChange={e => setValue({ ...value, baseUrl: e.target.value })} /></label>
        <label className="field"><span>Transcription model</span><input value={value.model} onChange={e => setValue({ ...value, model: e.target.value })} /></label>
        <label className="field"><span>Voice API key {savedKey && <span className="field-state"><Check size={12} /> Saved</span>}</span><input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={savedKey ? "Enter to replace saved key" : "Separate from your model key"} onChange={e => { setKey(e.target.value); setChanged(true); }} /></label>
        {savedKey && <button type="button" className="text-button" onClick={() => { setKey(""); setChanged(true); }}>Clear voice key</button>}
      </>}
    </div>
  </section>;
}
