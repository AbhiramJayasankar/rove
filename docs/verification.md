# Verification

Rove v2 is tested as a self-contained unpacked Chrome extension. Node runs build/test tooling and deterministic fixture servers; production browser control, model requests and persistence run in the extension worker.

## Commands

```sh
npm install
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

`npm run build` checks TypeScript and generates the loadable `extension/` directory. `npm test` covers the browser core. `npm run test:e2e` loads that generated directory into an isolated persistent Chromium profile. Use the command's exit status and reports as the current result; counts change as cases are added.

## Coverage

| Suite                                  | Checks                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension-core/tests/agent.test.ts`   | Multi-step tool execution, approval changes/denial, cancellation, user questions, tab routing, screenshots, redaction, structured snapshots, array results and run configuration |
| `extension-core/tests/model.test.ts`   | Compatible endpoints, keys/errors, streaming reasoning/tool assembly, incomplete streams, generation parameters and function-call connection tests                               |
| `extension-core/tests/controls.test.ts` | Endpoint effort enums, model maxima, exact documented fallbacks, protocol selection, legacy-setting migration |
| `extension-core/tests/conversation.test.ts` | Saved chat reconstruction, retained reasoning and images, reused tool IDs, interrupted batches, same-ID follow-ups and monotonic steps |
| `extension-core/tests/usage.test.ts` | Per-chat totals across models, provider costs, pricing units, caches, unknown/interrupted usage and current context estimates |
| `extension-core/tests/context.test.ts` | Independent image budgets, intact tool groups, retained reasoning and bounded context                                                                                            |
| `extension-core/tests/browser.test.ts` | CSP-safe interpreted schemas, Unicode byte limits, hashed Chrome-storage profiles and durable pre-dispatch checkpoint failures                                                   |
| `extension-core/tests/browser-session.test.ts` | Stale attachments/dialogs, owned-client recovery, isolated iframe loss, intentional close, cancelled command deadlines and no mutation replay |
| `tests/extension/native.spec.ts`       | Actual worker/model/browser loop, streaming Stop, approvals/questions, worker restart recovery, lost debugger detection and fresh-task reconnection without replay |
| `tests/extension/tools.spec.ts`        | Cross-origin frames, refs/pagination, native pointer/keyboard operations, dialogs, navigation/history, screenshots and protected target rejection                                |
| `tests/extension/ui.spec.ts`           | Unsaved connection discovery, composer controls, custom keyboard menus, trace, history, light/dark persistence, 320/360/400/1280px layouts, full-browser credential persistence, key clearing, anchored menus/ring, chronological follow-ups and settings-return draft preservation                    |

The browser-core suite has been run successfully during implementation. The real extension suites use local pages and an OpenAI-compatible fixture, allowing reproducible checks without paid credentials. They exercise native browser effects and inspect the resulting page rather than substituting a fake browser transport.

## Manual handoff check

1. Load `extension/` using Chrome's **Load unpacked** control. Open Rove from its toolbar action and open Options for the full workbench.
2. Enter your endpoint/key, choose a tool-capable model, test it and save. Try a small task on an ordinary page.
3. Inspect the tool arguments/results, model request, response and screenshot. Check Stop and a task requiring a user answer.
4. Export a run and inspect its settings/history. The model API key must be absent. Check the settings contain only Model, Instructions and Tools.
5. Confirm browser/extension restart retains history and credentials, and marks an interrupted task failed without replaying it. Verify Clear key removes the credential after saving.

Chrome 125 is the minimum declared version; an automated run proves behavior on its installed Chromium version, not every supported release or website. Deterministic model fixtures prove protocol/execution behavior rather than the task quality of an arbitrary provider. Complex pages, suspended tabs, transformed frames, Chrome policy, CAPTCHA and native dialogs still need task-specific checks. Source rebuilds must be followed by extension reload before checking installed behavior.
## Voice input verification

- Current verification: typecheck, 85 unit tests, production build, and all 28 unpacked-extension browser tests. Light/dark settings, provider configuration/model lists, and a 320 px recording composer were visually inspected. Real microphone/service accuracy and live provider credentials remain manual checks.
- Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`.
- Unit coverage: multipart file/model/JSON response format, separate bearer credential, endpoint validation, no redirects/retries/fallbacks, 25 MB/empty audio/60-second OpenRouter guards, empty transcripts, network/timeout/cancellation and HTTP 401/403/429/413/408/504 errors. Provider error bodies are not echoed into UI or history.
- `tests/extension/voice.spec.ts` uses a mocked recognizer and microphone in an isolated unpacked extension: click-to-start/stop, live insertion at cursor, no auto-send/history, Escape rollback, denied-permission inline error and narrow-panel width. No live audio leaves the test browser.
- Manual real-device check: reload extension and reopen panel; choose Web Speech, click the mic, Allow if first-time permission setup appears, then speak inside Rove. Check the live waveform/interim text and stop from the composer; repeat and confirm no new window opens. Repeat with selected text, Escape, switching chats/settings, and a running agent. Check Enter/Shift+Enter after completion, focus, keyboard navigation, light/dark and reduced motion. Deny permission and verify recovery instructions; test a missing/busy mic. Chromium test builds may not include Google’s recognition service, so mocked tests cannot establish real speech accuracy or service availability.
- API check with your own key: save independent voice settings, dictate, stop, inspect the one multipart request to your endpoint and review the returned draft without sending. Verify the model key is untouched, keys/audio are absent from run exports, cancellation halts capture/upload, and no request reaches a different backend. Test OpenRouter with a paid transcription model and short clip. Quotas and provider credentials are not exercised by automated tests.

Implementation: recognition, recording and a Web Audio analyser waveform run directly in the composer. A permission-only page (`index.html?voice=<random session>`) is opened when microphone permission is still at prompt; it grants the extension origin access and closes. Its random extension-origin BroadcastChannel carries only the permission result. No recording windows open once permission is granted. Escape, pagehide and chat/view cleanup stop capture and release audio tracks/AudioContext. The dedicated voice settings/key remain outside agent settings and the run journal; manifest/CSP remain unchanged. Browser coverage includes inline capture without new windows, control order, waveform visibility, and first-time-only permission setup.
## Multiple provider verification

Provider-store unit tests cover migration of existing endpoint/key, independent credentials and remembered models across reloads, failed-write rollback, and removing one credential while retaining another. Browser tests combine two catalogues with identical model IDs, select models through the UI, check actual endpoint/bearer routing on consecutive messages, and verify keys are absent from state and run exports. They also exercise partial catalogue failures, adding the OpenRouter preset through Settings, saving its own key, persistence and narrow layouts. Fixture servers replace external providers; no paid credentials are required.
