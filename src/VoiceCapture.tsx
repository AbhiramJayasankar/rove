import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { microphoneError } from "./voice";

// Permission setup only; recognition and recording stay in the composer.
export default function VoiceCapture() {
  const [message, setMessage] = useState("Choose Allow in Chrome’s microphone prompt. Dictation will continue inside Rove.");
  useEffect(() => {
    const channel = new BroadcastChannel(`rove-mic-${new URLSearchParams(location.search).get("voice")}`);
    let disposed = false;
    void navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
      stream.getTracks().forEach(t => t.stop());
      if (!disposed) { setMessage("Microphone enabled. You can return to Rove."); channel.postMessage({ type: "granted" }); }
    }).catch(error => {
      if (!disposed) { const message = microphoneError(error); setMessage(message); channel.postMessage({ type: "error", error: message }); }
    });
    return () => { disposed = true; channel.close(); };
  }, []);
  return <main className="voice-capture"><Mic size={24} /><h1>Enable microphone</h1><p role="status" className="voice-note">{message}</p></main>;
}
