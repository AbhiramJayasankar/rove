import { useEffect, useState } from "react";
import { DEFAULT_VOICE, readVoice, transcriptionUrl, type VoiceSettings as Options } from "./voice";
import ChoiceMenu from "./ChoiceMenu";

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
export default function VoiceSettings({ voice }: { voice: ReturnType<typeof useVoiceSettings> }) {
  const { value, setValue, key, setKey, setChanged, savedKey } = voice;
  return <section className="voice-settings">
    <div className="settings-heading"><h2>Speech to text</h2></div>
    <div className="field"><span>Dictation backend</span><ChoiceMenu label="Dictation backend" value={value.backend} onChange={backend => setValue({ ...value, backend: backend as Options["backend"] })} options={[{ value: "web", label: "Web Speech · no API key", description: "Chrome sends audio to Google." }, { value: "api", label: "Groq / compatible API", description: "Audio goes to your configured endpoint." }]} /></div>
    {value.backend === "api" && <div className="connection-fields">
      <label className="field"><span>Transcription base URL</span><input type="url" value={value.baseUrl} onChange={e => setValue({ ...value, baseUrl: e.target.value })} /></label>
      <label className="field"><span>Transcription model</span><input value={value.model} onChange={e => setValue({ ...value, model: e.target.value })} /></label>
      <label className="field"><span>Voice API key {savedKey ? "· saved" : ""}</span><input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={savedKey ? "Enter to replace saved key" : "Separate from your model key"} onChange={e => { setKey(e.target.value); setChanged(true); }} /></label>
      {savedKey && <button type="button" className="text-button" onClick={() => { setKey(""); setChanged(true); }}>Clear voice key</button>}
    </div>}
  </section>;
}
