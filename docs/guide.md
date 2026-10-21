# Rove user guide

The details behind the [README](../README.md): models, local servers, providers, browsing behavior, voice, prompts and storage.

## Models and context

Rove uses OpenAI-compatible **Chat Completions function calling**. Set a base URL such as `https://api.openai.com/v1`, a compatible gateway, or a local model server. A full URL ending in `/chat/completions` also works. Local endpoints may omit the key. The model must support tools. Streaming is always requested.

The picker uses endpoint labels, prices, modalities, supported parameters and limits. Endpoint metadata takes precedence. Exact provider/model fallbacks from primary documentation fill missing capabilities for a few known free models. Unknown capabilities stay automatic; Rove does not invent effort levels. Context and output limits use the model maxima, reserving enough room for the actual input. The trace shows provider reasoning when the endpoint returns it. The context ring separates current context from cumulative input and output tokens and estimates cost from provider usage or model pricing; missing usage or pricing stays marked unknown.

Before each request, Rove keeps complete tool-call groups within the model's budget and limits older screenshots independently. Provider usage calibrates its token estimates. A structured context rejection triggers a bounded retry of the model request, dropping older images before older text. Browser actions are never replayed. Learned input and image limits are isolated by endpoint, credential hash and model.

### What the endpoint reports

**Settings → Model → Details for** shows everything the endpoint says about any model it lists: context window, max input and output, accepted and produced modalities, tool calling, image input, reasoning levels, price, accepted parameters and the raw entry. Anything the endpoint leaves out reads "Not reported". The same facts appear in an info tooltip beside each model in the picker. The search box lets you inspect a single model among hundreds on OpenRouter or TokenHarbor.

### Model abilities: images and reasoning

Below the details, **Model abilities** lets you override two things for one model on one endpoint (saved separately from the API key):

- **Images**: follow the endpoint, always send images, or never send them. A model that gets no images is not offered the screenshot tool, takes no automatic screenshots and is told to work from page text.
- **Reasoning control**: replace what the endpoint advertises with your own levels. Each level is a name and a JSON object merged into the request, for example `{"reasoning_effort": "none"}` or `{"chat_template_kwargs": {"enable_thinking": true}}`. Presets cover llama.cpp, vLLM, DeepSeek/MiMo, OpenAI-style and OpenRouter-style controls. A level cannot set `model`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options`, `max_tokens` or `max_completion_tokens`, which the agent owns. List levels from lowest to highest; the last is the default. The reasoning menu in the chat box then offers your levels.

### Local models (llama.cpp)

A llama.cpp server reports `owned_by: "llamacpp"`. Rove then also reads the server's `/props` to learn whether it accepts images and whether its chat template has a thinking switch, and takes the loaded context size from `meta.n_ctx`. A text-only model is detected automatically, and a thinking model gets Off and High reasoning levels. Anything else a server expects can be set with custom levels above.

## Multiple providers

In **Settings → Model → Provider**, choose **+ Add OpenRouter** or **+ Add compatible provider**. Enter its name, OpenAI-compatible base URL and a separate API key, choose a model, then **Save changes**. The provider dropdown edits a saved connection; its trash button removes it.

All saved providers contribute to the same searchable model picker. Each model shows its provider when several catalogues are present, including duplicate model IDs, and choosing one uses that provider's URL and key. A catalogue that fails to load does not hide the others. **Free** filters paid models. There is no automatic fallback between providers.

Provider keys stay in `chrome.storage.local` (`modelProviderKeys`, with the selected key mirrored in `modelApiKey`). They are excluded from settings responses, run history and exports.

## Browsing behavior

Settings → Tools → **Browsing** has three switches, all on by default and applied to the next browser action of every task:

- **Work in the background.** Rove never switches to the tab it works in. It opens its own tabs behind the one you are using and keeps hidden tabs rendering at full speed while a task runs, so you can keep using Chrome (or another app). Screenshots of a hidden tab work without bringing it forward, and a tab Chrome unloaded to save memory is reloaded in place. Turn this off if a page only works while it is in front; Rove then switches to the tab as older versions did.
- **Group Rove's tabs.** Tabs Rove opens go into one Chrome tab group titled Rove per task, so you can see what it opened and close it together. Your own tabs are never grouped. The group stays after the task so you can review it.
- **Keep going if I close Chrome's debugging bar.** While Rove controls a tab, Chrome shows "Rove started debugging this browser". Its Cancel and close buttons both detach the debugger. With this on, the task carries on and Rove reconnects at its next action (the bar comes back with it). With it off, closing the bar stops the task. An extension cannot hide the bar; only starting Chrome with `--silent-debugger-extension-api` does.

Up to three tasks run at once, each leasing its own tabs. Stop (or Escape) prevents further actions; an action already sent cannot be undone.

## Prompts, rules and attachments

- **Standing instructions** (Settings → Instructions) are added to every task after the system instructions.
- **Saved prompts**: add them in Settings → Instructions. Type `/` in the message box to search and insert one; an optional start page is prefixed as "Start at ...". Nothing is sent until you press Send.
- **Site rules** (Settings → Tools) set Allow, Ask or Block for a site and its subdomains. They override Auto-approve and Ask first for that site; Ask cannot be answered by switching to Auto-approve; Block never reaches the browser and the model is told why. The most specific rule wins and a tie takes the stricter action. A rule checks the address a tool acts on, so a link that leads to a blocked site is caught on the next tool call.
- **Attachments**: the paperclip adds up to five images (5 MB each) or text files (200,000 characters each), or a screenshot of the selected tab. Images need a vision model. File contents are treated as untrusted data.
- **Reports**: the agent can save a `.md`, `.txt`, `.csv`, `.json` or `.html` report to Downloads/Rove with `browser_save_file`. File names are bare names; folders and other types are refused.
- **Export**: the trace view exports a run as JSON or a readable Markdown transcript.
- **Languages**: English, Simplified Chinese and Traditional Chinese. Settings → Language defaults to following Chrome. The system prompt and the model's answers are not translated.
- **Shortcut**: Alt+Shift+O opens Rove; change it at `chrome://extensions/shortcuts`.

## Voice input

The microphone inserts dictation at the cursor or replaces selected text. Click again to stop; Escape cancels and restores the draft. It never auto-sends.

Settings → Model → Speech to text selects the backend:

- **Web Speech** (default): no key, live text; Chrome sends audio to Google. Needs internet and a Chrome build with speech recognition.
- **Groq / compatible API**: uploads WebM/Opus only to your configured endpoint when you stop. Defaults: `https://api.groq.com/openai/v1`, `whisper-large-v3-turbo`. The base URL and model are editable; enter a separate voice API key. There is no automatic fallback between backends.

Dictation runs inside the composer with a live waveform and timer. On first use Chrome may need a small permission window: choose **Allow** and it closes. If blocked, check Chrome's microphone site settings and your system's microphone permission for Chrome. API clips stay below 25 MB and 10 minutes; Groq free quotas vary. Audio and the voice key stay out of history and exports. Cancelling cannot retract audio already uploaded.

## Storage and privacy

- The model API key persists in `chrome.storage.local`, restricted to Rove's own pages, across Chrome and extension restarts. Settings, history, API responses and run exports exclude it. Saving an empty key clears it.
- Settings and learned model limits use `chrome.storage.local`. Run metadata and the append-only event history use IndexedDB. Light/dark mode and the free-model filter persist in the extension profile.
- Page text and screenshots sent to the model go directly from your browser to the endpoint you chose. Rove has no server and sends nothing anywhere else.
- Web Speech dictation sends audio to Google through Chrome; the Groq backend sends it to the endpoint you configure.
- The worker attaches the debugger before a run's model requests and releases it afterwards. If Chrome interrupts a run, its history remains and the run is marked failed on recovery; no browser action is resumed automatically. Durable journal checkpoints are written before every model or tool dispatch.

## Limits

Rove controls web content. Chrome internal pages, the Chrome Web Store, OS windows, native permission prompts, CAPTCHAs and some sign-in challenges need you. DevTools, browser policy or another debugger on the same tab can detach Rove. Stop cannot undo an action already dispatched. Browser and file permissions still apply, and unusual frame layouts may need a fresh observation or a manual takeover.

## Versions

The version lives in `package.json`; `npm run build` copies it into the extension manifest and the app, which shows it in Settings with a "What's new" view. Every user-visible change is recorded in [CHANGELOG.md](../CHANGELOG.md), and a test keeps the package, manifest and changelog in step. Rove was called Relay before 2.1.0; saved history, providers and keys carry over.
