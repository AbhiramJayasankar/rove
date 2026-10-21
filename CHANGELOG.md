# Changelog

Rove follows [semantic versioning](https://semver.org). The version lives in `package.json`; the build copies it into the extension manifest and the app.

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
