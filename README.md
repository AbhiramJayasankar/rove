# Rove

Your own prompt-driven Chrome agent. Bring an OpenAI-compatible endpoint, choose a model, write a task, and inspect every request and browser action.

Rove v2 runs entirely inside a Chrome extension: the agent, browser controller, interface and history. Once built and installed, it needs no Node process, local server or pairing connection. Node.js is used only to build and test the source.

## Install

Requires Chrome 125 or newer. To build from source, install Node.js 22 or newer and run:

```sh
npm install
npm run build
```

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `extension` folder.
2. Pin Rove and click its toolbar icon to open the side panel. Use the extension's **Options** page for the full workbench in a tab.
3. In **Model settings → Language model**, enter an OpenAI-compatible base URL and a key if required. Choose a model from the searchable endpoint catalogue and save the settings.
4. Open a normal webpage, select its tab in Rove, and enter a task. The activity, execution details and trace show what happens. Use **Stop** or Escape to prevent further dispatch.

After source changes, rebuild and reload Rove on `chrome://extensions`. Keep the generated folder in place while the unpacked extension is installed. Clicking the toolbar icon uses Chrome's [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

## What you control

- Your existing Chrome tabs and signed-in sessions: navigation/history, frame-aware snapshots, native pointer/keyboard input, forms/selects, hover/drag, screenshots, dialogs, download metadata and optional file uploads.
- Editable instructions, browser tool enablement, model and reasoning selection, and approvals directly in the composer.
- Streaming responses and provider-returned reasoning, model requests/responses, full tool arguments/results, screenshots, approvals, questions, saved history and individual run export.

**Auto-approve** is on by default. Turn it off in the composer to review interactions. Changes apply to the current run; enabling auto-approval releases a pending approval. Questions still wait for your answer. Generic JavaScript, raw CDP and file uploads begin disabled. Prompt-injection instructions guide the model, while approval settings determine which enabled actions require review.

See [architecture](docs/architecture.md), [extension messaging](docs/api.md), [browser tools](docs/browser-tools.md) and [verification](docs/verification.md). Earlier technology comparisons are recorded in [research](docs/research.md).

The interface is designed for Chrome's side panel: a single conversation column, current-tab selector, optional screenshot preview and searchable history. Reply in the composer to continue the selected chat; New task starts a separate chat. The compact control row contains model, reasoning, approval mode, a context ring and Send. Model search and usage details open beside their buttons. Settings has an explicit Back to chat action and retains your draft. Syne and Commissioner fonts ship inside the extension with their licenses. Enter sends a task; Shift+Enter adds a line. See the [interface decisions](docs/extension-design.md).

## Models and context

Rove uses OpenAI-compatible **Chat Completions function calling**. Set a base URL such as `https://api.openai.com/v1`, a compatible gateway, or a local model server. A full URL ending in `/chat/completions` also works. Local endpoints may omit the key. The model must support tools. Streaming is always requested; screenshots are sent automatically unless the endpoint explicitly reports a text-only model.

The picker uses endpoint labels, prices, modalities, supported parameters and limits. Endpoint metadata takes precedence. Exact provider/model fallbacks from primary documentation fill missing capabilities for the configured free models. Unknown capabilities remain automatic; the interface does not invent effort levels. Context and output limits use the model maxima, reserving sufficient room for actual input. The trace shows provider reasoning when returned; Rove does not invent it. Documented effort aliases appear with their canonical mapping in the selector. The context-ring popover separates current context from cumulative chat input/output tokens and estimates cost from provider usage or model pricing; missing usage/pricing stays explicitly unknown.

Before each request, Rove retains complete tool-call groups within the selected model's budget and limits older screenshots independently. Provider usage calibrates token estimates. Structured context rejections trigger bounded recovery of the model request, removing older images before older text. Browser mutations are not replayed. Learned input/image limits are isolated by endpoint, credential hash and model.

## Storage

The model API key persists in a dedicated trusted `chrome.storage.local.modelApiKey` entry across Chrome and extension restarts. Settings, history, API responses and run exports exclude the key. Legacy session credentials migrate once. Save an empty key to clear it.

Settings and learned model limits use `chrome.storage.local`. Run metadata and append-only event history use IndexedDB. Page content and screenshots sent in model context go directly from the extension to your selected provider. Light/dark mode and the free-model filter persist within the extension profile.

The worker attaches the debugger before a run's model requests and releases it afterward. If Chrome interrupts a run, history remains and that run becomes failed on recovery; no browser action is resumed automatically. Durable journal checkpoints precede model/tool dispatch. Chrome documents the active-debugger worker lifetime behavior in its [service-worker lifecycle reference](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

## Development

```sh
npm run dev                    # Rebuild extension source in watch mode
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e                # Actual extension in isolated Chromium
npm run build                  # Generate the loadable extension/ directory
```

After a watch rebuild, reload the extension and reopen its interface. Test fixture servers are used only by integration tests; the installed product has no backend service. Edit `extension-src/`, `extension-core/`, `src/` and `shared/`, rather than generated `extension/` files.

Rove controls web content. Chrome internal pages, OS windows, native permissions, CAPTCHA and some sign-in challenges require direct interaction. DevTools or browser policy can detach the debugger. Stop cannot undo an action already dispatched. Browser/file permissions still apply, and site-specific or transformed frame layouts may need fresh observations or manual takeover. One run is active at a time in the shared browser session.
## Multiple language-model providers

In **Settings → Model → Provider**, choose **+ Add OpenRouter** or **+ Add compatible provider**. Enter its name, OpenAI-compatible base URL and separate API key, choose a model, then **Save changes**. Existing connections are retained automatically. The provider dropdown edits a saved connection; its trash button removes that connection.

All saved providers contribute models to the same searchable model picker. Each model shows its provider when multiple catalogues are present, including duplicate model IDs. Selecting a model automatically uses that provider’s URL and key. A failed catalogue does not hide other providers. **Free** still filters paid models; turn it off to see the full combined list. There is no automatic cross-provider request fallback.

Provider keys stay in trusted `chrome.storage.local.modelProviderKeys`, with the currently selected key mirrored in `modelApiKey`; they are excluded from settings responses, run history and exports. Provider selection and credential changes are committed together. Your existing provider is migrated automatically; the voice transcription key remains separate.

## Voice input

The microphone inserts dictation at the cursor or replaces selected text. Click again to stop; Escape cancels and restores the draft. It never auto-sends. Afterwards, Enter sends and Shift+Enter adds a newline.

Settings → Model → Speech to text selects the backend; **Save changes** saves both model and voice settings:

- **Web Speech** (default): no key, live text; Chrome sends audio to Google. Requires internet and a Chrome build supporting speech recognition.
- **Groq / compatible API**: uploads WebM/Opus only to your configured endpoint on stop. Defaults: `https://api.groq.com/openai/v1`, `whisper-large-v3-turbo`. The base URL/model are editable; enter a separate voice API key. No automatic backend fallback.

Dictation runs inside the composer, with a live microphone waveform and timer. On first use only, Chrome may need a small permission setup window: choose **Allow**, and it closes automatically. Subsequent recording stays in Rove. Escape or leaving the chat cancels. If blocked, check Chrome’s microphone site settings and your system’s microphone permission for Chrome.

API clips stay below 25 MB and 10 minutes. Paid OpenRouter STT stops recording at 59 seconds to avoid its 60-second timeout. Groq free quotas vary (roughly 20 requests/minute, 7,200 audio-seconds/hour). Errors appear inline. Audio/key stay out of history and exports; `voiceApiKey` persists separately in trusted `chrome.storage.local`. Cancellation cannot retract audio already uploaded.

After building, reload Rove on `chrome://extensions`, reopen its side panel, and refresh open workbench tabs. No manifest permission or CSP changes are needed. See [verification](docs/verification.md#voice-input-verification) for detailed checks.

## Prompts, rules and attachments

- **Standing instructions** (Settings, Instructions) are added to every task, after the system instructions.
- **Saved prompts**: add them in Settings, Instructions. Type `/` in the message box to search and insert one; an optional start page is prefixed as "Start at ...". Nothing is sent until you press Send.
- **Site rules** (Settings, Tools) set Allow, Ask or Block for a site and its subdomains. They override Auto-approve and Ask first for that site; Ask cannot be answered by switching to Auto-approve; Block never reaches the browser and the model is told why. The most specific rule wins, and a tie takes the stricter action. A rule checks the address a tool acts on, so a link that leads to a blocked site is caught on the next tool call.
- **Attachments**: the paperclip adds up to five images (5 MB each) or text files (200,000 characters each), or a screenshot of the selected tab. Images need a vision model. File contents are treated as untrusted data.
- **Reports**: the agent can save a `.md`, `.txt`, `.csv`, `.json` or `.html` report to Downloads/Rove with `browser_save_file`. File names are bare names; folders and other types are refused.
- **Export**: the trace view exports a run as JSON or a readable Markdown transcript.
- **Languages**: English, Simplified Chinese and Traditional Chinese. Settings, Language defaults to following Chrome. The system prompt and the model's answers are not translated.
- **Shortcut**: Alt+Shift+N is registered for the toolbar action; change it at `chrome://extensions/shortcuts`.

## Versions

The version lives in `package.json`; `npm run build` copies it into the extension manifest and the app, which shows it in Settings with a "What's new" view. Every user-visible change is recorded in [CHANGELOG.md](CHANGELOG.md), and a test keeps the package, manifest and changelog in step. Rove was called Relay before 2.1.0; saved history, providers and keys carry over.
