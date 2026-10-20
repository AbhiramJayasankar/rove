# Changelog

Rove follows [semantic versioning](https://semver.org). The version lives in `package.json`; the build copies it into the extension manifest and the app.

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
- Alt+Shift+N shortcut for the toolbar action, and an MIT license.

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
