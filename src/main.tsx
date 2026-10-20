import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import VoiceCapture from "./VoiceCapture";
import "./style.css";
import "./execution.css";
import "./composer.css";
import "./settings.css";
import "./chat.css";
import { applyTheme, readTheme } from "./theme";
import { I18nProvider } from "./i18n";
applyTheme(readTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("voice") ? <VoiceCapture /> : <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
