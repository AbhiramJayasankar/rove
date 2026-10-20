# Changelog

Rove follows [semantic versioning](https://semver.org). The version lives in `package.json`; the build copies it into the extension manifest and the app.

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
