# Changelog

Rove follows [semantic versioning](https://semver.org). The version lives in `package.json`; the build copies it into the extension manifest and the app.

## 2.8.0 - 2026-11-20

### Added
- **Themes.** **Settings > Model > Appearance** has six colour themes, Sage (the one Rove always had), Harbor, Heather, Ochre, Rosehip and Graphite, each with a light and a dark version. Every swatch is a small Rove chat drawn in that theme's own colours, and picking one repaints Rove at once. Next to them, choose **Match Chrome**, **Light** or **Dark**; the moon and sun button in the header still switches light and dark and keeps your theme. Other open Rove panels follow the change, and **Match Chrome** follows Chrome when it switches between light and dark. Your theme is saved in backups.

### Changed
- Sage's grey secondary text is a shade darker in light mode, so it meets the WCAG AA contrast ratio (4.5:1) on the page and in settings panels. Every theme is checked for this in the tests.

## 2.7.0 - 2026-11-19

### Added
- **Web search.** Choose Exa, Tavily or Parallel under **Settings > Tools > Web search** and add that service's API key. The model then gets a `web_search` tool that returns titles, links, dates and short excerpts, which is quicker than opening a search engine in a tab. Queries go only to the service you chose, its key is sent only to that service, and results on sites you blocked are left out. **Test search** checks the key. Web search works in New Tab mode too.
- **Gemini.** The provider menu has **+ Add Google AI Studio (Gemini)** and **+ Add Vertex AI (Gemini)**. AI Studio uses Google's OpenAI-compatible endpoint, and its model list shows each model's real context window, output limit and thinking levels. Vertex AI takes an express-mode API key (no project or service account); Rove talks to it in Gemini's own format, since that is the only one Vertex accepts with an API key, and offers the Gemini models Vertex documents. Gemini's thought signatures are kept with tool calls on both, so multi-step tasks on Gemini 3 and later do not fail.
- **Backup and restore** under **Settings > Model > Backup**: save your providers, instructions, standing notes, saved prompts, tool and voice settings to a file, with or without API keys, and restore them in any Rove. Chat history is not included.

### Changed
- **Updating no longer installs a second Rove.** Rove now has a fixed extension ID (`mklgbmacaelcomgamkccjncffojpfekb`), so loading a new release from a new folder updates the Rove you have, and your endpoints, keys, instructions and chats stay. Because the ID changes once with this release, this update still arrives as a new extension. The README's "Updating from 2.6.x or older" has a one-line way to carry your settings over; from 2.7.0 on, updates keep everything.
- **The step limit goes up to 2,000, and past that it turns off.** With no limit, a task runs until it finishes or you press Stop. Before, the limit stopped at 200.
- **Rove's side panel stays on the tabs where you open it.** Open it on a tab with the toolbar button or `Alt+Shift+O`, and switching to another tab closes it there; coming back shows it again. Before, the panel stayed open on every tab in the window.

### Fixed
- The message box no longer comes back tall and empty after you close and reopen the side panel while a task runs. The panel lays out narrow for a moment when it opens, and the box kept the height it measured then; it now measures again when its width changes.

## 2.6.2 - 2026-11-19

### Fixed
- A tab Rove worked in no longer goes black (or blank) when you switch to it. Rove's screenshots of a background tab used a clip at the page's scroll position, and once the tab had been scrolled, Chrome then showed no picture of it until the task ended. Screenshots of a background tab now capture the viewport without a clip (a tab in front is captured as before); what the model sees is unchanged. Measured in Chrome 157 from the real screen: the old capture left the page area blank in every run, the new one never did.
- **New Tab** beside Chrome's empty New Tab page now uses that tab instead of opening another one next to it. A New Tab chat started beside an ordinary page still opens a new tab and leaves your page alone, and your tab is not moved into Rove's tab group.
- A tab that a page opens while Rove works (a link that opens in a new tab) belongs to the task straight away. The side panel there shows the running task instead of an empty "What's the task?", the tab joins the task's tab group, and the model is told which tab opened. Before, this only happened once the model happened to use that tab.

## 2.6.1 - 2026-11-16

### Fixed
- OpenCode Go works as a provider. Go rejected every request with "Request is missing x-opencode-session", so a chat failed even though the model list loaded. Rove now sends the chat's ID in the `x-opencode-session` header to `opencode.ai`, one session per chat, follow-ups included. Other providers never receive it.
- OpenCode models show their reasoning menu. OpenCode lists levels as `capabilities.reasoning.effort` (for example Low, High, Max for GLM-5.3-Flash), which Rove did not read, so no model had a reasoning control. Models that OpenCode marks as switchable (LongCat-2.0, MiniMax M3, Qwen3.7 Plus) now get Thinking off/on, sent as `thinking: { type }`, because Go ignores `reasoning_effort: "none"`.

## 2.6.0 - 2026-11-08

### Changed
- The side panel follows the tab you are on. Each tab shows the chat Rove worked on there, or a fresh chat for that tab, and switching tabs switches chats. Before, every tab showed the same chat, and a new task started anywhere took over every open panel. A full-page Rove tab now opens fresh and keeps its own chat across reloads. **New task** works on the tab beside the panel instead of opening a new tab.
- While Rove waits on a question, the main message box answers it (Enter or the send button), so an answer typed there is not lost.
- Leaving Settings with unsaved changes asks whether to save, discard or keep editing. Before, Back to chat quietly dropped them, including a saved prompt kept with **Keep prompt**, and switching browser tabs closed Settings.

### Fixed
- The context ring in the chat box is closer to the truth. A new chat shows what the system message and tools already take (about 3k tokens) instead of 0, current context includes the latest answer, and Rove's estimate now follows the provider's real counts down as well as up. With a real OpenRouter model the estimate had run 2 to 2.5 times high (tool results are JSON inside JSON), which made Rove compact history long before a small model's limit; calibrated estimates now land within about 20%, and a follow-up keeps the chat's calibration.
- The browser preview of a tab a task is working in showed "Tab … is owned by another task" and no picture. It now shows the task's newest screenshot with a note, and refresh waits until the task finishes.
- Starting a task on a tab another task is using explains it in plain words instead of an internal error.
- The "Up to 3 tasks can run at once" error disappears once a task finishes or you switch chats, and other errors no longer follow you to another tab or chat.
- Page script errors no longer include JavaScript stack lines.
- Model errors say what went wrong and what to do (a rejected key, rate limiting, a server error, a missing model) with the provider's own message, instead of raw JSON or an HTML error page. A connection that drops mid-answer says so instead of "network error".
- A follow-up on a model with a small context window no longer fails after a long answer ("The latest observation exceeds…"). The earlier answer is shortened to fit, and when a step truly cannot fit the message says whether a page observation or the chat is too large.
- A task that stops because its tab was closed, or because Chrome's debugging bar was closed, says why under the Stopped notice.
- Images in a model's answer that point to other sites show as links. Rove never loads them, so they used to appear as broken pictures.
- A fresh chat on a new tab targets that page once it finishes loading, instead of staying on New Tab.
- Block site rules now also apply where a tab ends up. Before, opening a link that redirected to a blocked site, or a click that navigated there, sent that page's text and the automatic screenshot to the model. Both are now withheld, and the model is told the site is blocked.
- A saved API key is only sent to its own provider's server. Before, the model list in Settings refreshed as you typed a new base URL and sent the saved key to each address typed, including half-typed or mistyped ones; the connection check API did the same. A different server now gets no key unless you type one for it.

## 2.5.2 - 2026-10-21

### Added
- `npm run package` writes `release/rove-<version>.zip`, a ready-to-load copy of the extension for anyone installing without Node.js.
- `scripts/readme-screenshots.mjs` regenerates the README images from the real extension against a scripted demo model.

### Changed
- The README is now an install and tour page with screenshots; the detailed model, browsing, voice and storage notes moved to `docs/guide.md`. The unreferenced screenshots of older interface versions were removed.

## 2.5.1 - 2026-10-21

### Fixed
- The "Stopped · Edit & retry" pill is evenly padded and its text is centred, and your message bubbles have a little more room around the text.

## 2.5.0 - 2026-10-21

Rove no longer takes over your browser while it works.

### Added
- Background work. Rove opens and drives its tabs without switching to them, so you can keep using Chrome (or another app) while a task runs. Hidden tabs keep rendering at full speed during a task and go back to normal afterwards, and screenshots of them work without bringing them forward.
- Tab groups. Tabs Rove opens go into one Chrome tab group titled Rove per task, so you can see what it opened and close it together. Your own tabs are never grouped, and the group stays after the task so you can review it.
- Settings → Tools → Browsing, with switches for working in the background, grouping tabs, and keeping going when you close Chrome's debugging bar. All three are on by default and apply to the next browser action.
- Closing Chrome's debugging bar no longer ends a task by default. Rove reconnects on its next action (the bar returns with it). Chrome does not let an extension hide that bar; launching Chrome with `--silent-debugger-extension-api` does.

### Changed
- Starting a task, opening a new tab and taking a screenshot no longer switch to the tab. The "Work in the background" switch restores the old behavior.
- A browser command that times out no longer tells you to bring the tab to the foreground.

## 2.4.1 - 2026-10-21

### Removed
- The image mode button next to the attach button. Choose images always, never or from the endpoint in Settings → Model → Model abilities; the composer layout returns to its 2.3.0 spacing.

## 2.4.0 - 2026-10-21

Reasoning levels come back with several providers saved, any model can be inspected, and images can be switched off from the chat.

### Added
- Image mode switch next to the attach button. Text-only mode stops screenshots and images for the current model, hides the screenshot tool and tells the model to work from page text. It is saved per model and endpoint, and switching back to what the endpoint reports removes the override.
- A "Details for" model chooser in Settings → Model. Search any model the endpoint lists (useful for OpenRouter and TokenHarbor) to see what the endpoint reports and set its image and reasoning choices, not just the chat model's.

### Fixed
- The reasoning picker disappeared for every model, local, TokenHarbor and OpenRouter alike, once more than one provider was saved. Listing all providers' models left Rove remembering only the last one, so the chat model's details looked unknown.
- In text-only mode the default instructions no longer tell the model to use screenshots.
- In a narrow side panel the model name no longer shrinks to nothing. Below 460px the approval mode shows only its shield, and below 400px the chips drop their arrows, so every control stays on one line down to 320px.

## 2.3.0 - 2026-10-21

Better local-model support and more visibility into what each endpoint reports.

### Added
- Output speed in tokens per second on each answer, on every step in the trace and averaged in the usage popover.
- Time sent on every message, and a copy button on your messages and Rove's answers.
- Model abilities in Settings → Model: send images always or never for a given model, and replace its reasoning control with your own levels (each level is JSON merged into the request, with presets for llama.cpp, vLLM, DeepSeek, OpenAI and OpenRouter styles).
- Model details: what the endpoint reports for a model (context, max input and output, input and output types, tool calling, images, reasoning, price, accepted parameters, size and quantization when given) with "Not reported" where it is silent, plus the raw endpoint entry. Shown on the Model settings page, and as an info popover on every model in the picker and in the chat checklist.
- llama.cpp servers are detected: Rove reads the loaded context size, whether the model accepts images and whether it has a thinking switch.

### Changed
- Your message's time now sits at the right of the row under the bubble, with copy and edit to its left.
- A model that gets no images no longer takes automatic screenshots or sees the screenshot tool, and is told to rely on page snapshots.
- Edit and copy now sit outside the message bubble, under it, and appear on hover or focus.
- The recording indicator is a time-based waveform in the top-right of the message box, so the box no longer grows while you dictate.

## 2.2.0 - 2026-10-21

Closes the main gaps against other bring-your-own-model browser agents.

### Added
- Standing instructions in Settings, added to every task.
- Saved prompts: type `/` in the message box to search and insert one, with an optional start page.
- Site rules in Settings: Allow, Ask or Block per site (and its subdomains), overriding the approval mode. A blocked site is never opened.
- Attachments: add images, text files or a screenshot of the selected tab to a message.
- Several tasks at once (up to 3), each in its own tabs, with a strip showing what is running and which task needs you.
- Export a chat as a readable Markdown transcript, next to the JSON export.
- The agent can save text reports to Downloads/Rove.
- English, Simplified Chinese and Traditional Chinese, following Chrome by default and switchable in Settings.
- Alt+Shift+O shortcut for the toolbar action, and an MIT license.
- Info tooltips on the Tools page: every tool explains what it does, how risky it is, when it asks for approval and what inputs it takes. Group headings, the enabled count and site rules explain themselves too, and the approval prompt shows the same detail for the tool being approved.

### Changed
- Model and reasoning changes are allowed while other tasks run, and apply to the next task. Provider and endpoint changes still wait until no task is running.
- Auto-approve now applies per task, so switching it never approves another task's pending action.

## 2.1.0 - 2026-10-21

Rove is the new name for the app formerly called Relay. Your saved history, providers, keys and settings carry over.

### Added
- Voice input in the composer: free Chrome speech recognition, or any OpenAI-compatible transcription endpoint such as Groq. Live waveform, never auto-sends.
- Several providers at once, including OpenRouter, with every provider's models in one picker.
- "Models in chat" in Settings: tick which models each provider shows in the chat picker.
- Reasoning levels read from OpenRouter's model list, with an on/off switch for models that only allow toggling.
- Version number and this changelog, shown in Settings.

### Changed
- Redesigned Settings and the whole app around soft tonal panels: sliding section switch, pill controls, risk-grouped tools.
- The approval control reads Auto-approve or Ask first. The reasoning menu is hidden when a model has no levels.
- The chat picker shows all models by default instead of free models only.
- A task now stops on a debugger detach only when you cancel Chrome's debugging banner or the tab it is using is lost.
- Model and reasoning level cannot be switched while a task is running.
- A model request times out on silence rather than total duration.

### Fixed
- The panel could stay on "Working..." with no steps until reloaded after its event connection dropped. It now re-syncs against saved runs.
- Long runs slowed down because the whole run was copied for every streamed update.
- A model that ended with an empty reply showed as completed with no answer. It is now asked again, then reported clearly.
- Tool calls could be corrupted by gateways that repeat the call id and name on every stream chunk.
- Screenshots of background tabs hung until Chrome timed them out.
- Removing a provider now also removes its saved model list.

## 2.0.0 - 2026-10-20

First self-contained version: the agent, browser controller and interface all run inside the Chrome extension, with no local server.

### Added
- Side panel and full-tab workbench, bring-your-own OpenAI-compatible endpoint, model catalogue with context limits and prices.
- Browser tools: tabs, navigation, snapshots with element refs, screenshots, clicks, typing, scrolling, drag, dropdowns, dialogs, downloads and uploads.
- Streaming answers, full reasoning and request/response trace, run export, searchable history with edit-and-rerun.
- Auto-approve or ask-first approvals, usage ring with context and cost, light and dark themes.
