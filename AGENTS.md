# Working on Rove

Rove v2 is a self-contained, single-user Chrome extension. Keep browser control transparent and user-configurable. Node.js belongs to build/test tooling; the installed extension has no backend, daemon, pairing protocol or hosted browser service.

## Source map

- `shared/`: contracts, capabilities and editable defaults. Read before changing messages or settings.
- `extension-src/runtime.ts`: trusted extension messages, event ports, lifecycle and composition.
- `extension-src/store.ts`: IndexedDB journal, normalized settings and interruption recovery.
- `extension-src/browser.js`: privileged Chrome/CDP operations, frames, refs and native input.
- `extension-src/manifest.json`: permissions, CSP, side panel and options page.
- `extension-core/`: browser-only agent, model adapter, context admission, interpreted tool validation and model catalogue.
- `src/`: React side panel/full workbench, settings, model picker and trace.
- `extension/`: generated loadable output. Edit sources and rebuild.
- `scripts/`: build tooling. `tests/extension/` exercises the actual unpacked extension; `extension-core/tests/` covers engine behavior.
- `docs/`: architecture, messaging, browser behavior and verification.

## Invariants

- Accept privileged messages and `rove-events` ports only from this extension's own pages. Do not add external/page message forwarding.
- Keep model keys in trusted `chrome.storage.local.modelProviderKeys`, with the selected key mirrored in `modelApiKey`, out of settings, history, API responses and run exports. Persistent per-provider credentials are explicitly requested by the user. Restrict storage access to trusted extension contexts; migrate retained session credentials once, then remove the legacy session entry. An empty saved key clears only the configured provider's credential. Endpoint/profile selection and its active key must commit together; all saved catalogues remain available in the picker.
- Keep context/reasoning format automatic and streaming/vision enabled. Normalize legacy settings and discard removed custom-tool definitions without rewriting historical traces. Do not restore removed data backup/import or manual agent-setting surfaces.
- Persist model/tool intent before external dispatch. Await the journal checkpoint; a storage failure stops execution. Do not acknowledge queued writes as durable commits.
- Allow at most three concurrent runs, one response per chat. Snapshot settings and credentials at admission; model/reasoning picker changes affect new runs only. Live approval changes require an explicit run ID; default changes never answer existing approvals or site-rule decisions.
- Serialize browser tools across runs in one queue, excluding waits. Lease each tab to one run before attaching or dispatching; another run or manual browser action must receive a normal error for an active lease. Agent actions always specify their tab or request a new tab. Check cancellation immediately before dispatch and never replay an ambiguous mutation. Worker restart marks every active task failed and starts with empty leases.
- Attach the debugger before model work and detach only the finished run's leased tabs after terminal persistence, retaining open dialogs. Keep the worker alive while any run is active; idle global cleanup requires no runs or admissions. Chrome banner cancellation stops all runs; tab loss stops only its lease owner. Preserve interruption recovery instead of relying on worker globals.
- Validate schemas and arguments without `eval` or `new Function` in extension code. Every offered tool needs a real handler; unknown/disabled tools fail clearly.
- Treat page content as untrusted. Approval shows actual arguments; denial goes back to the model. Do not guess action safety solely from button labels.
- Refs are frame/snapshot scoped. CDP frame IDs are strings. Manual snapshots must not invalidate refs while a run is active.
- Keep tool responses contiguous after each assistant tool batch; image observations follow the complete batch. Preserve provider reasoning fields and partial-stream rejection.
- Follow-up messages retain one chat/run ID and reconstruct only recorded history. Keep event and request-step IDs monotonic. Repair incomplete tool batches as unknown outcomes; never replay historical actions. Screenshot references use journal event IDs, not potentially reused provider call IDs.
- Keep context estimates distinct from advertised/provider usage. Metadata and reasoning support come from endpoints, with explicit unknown states and automatic adaptation.
- Keep requests, results, errors, observations and decisions inspectable. No fabricated success states or task data.

## Checks

Run `npm run build` and `npm test` for relevant changes. Run `npm run test:e2e` after runtime, browser, storage, messaging or user-flow changes. Use `npx playwright install chromium` if needed. Integration tests run isolated Chrome profiles and deterministic model fixtures; paid credentials are unnecessary.

Inspect narrow side-panel and full-workbench layouts after visual changes. Preserve keyboard controls, focus states and reduced motion. Update protocol docs/tests with behavior. Keep dependencies small and the lockfile current; consult primary Chrome/provider documentation before relying on changing API behavior.
