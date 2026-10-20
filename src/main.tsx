import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import VoiceCapture from "./VoiceCapture";
import "./style.css";
import "./execution.css";
import "./composer.css";
import { applyTheme, readTheme } from "./theme";
applyTheme(readTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("voice") ? <VoiceCapture /> : <React.StrictMode>
    <App />
  </React.StrictMode>,
);
