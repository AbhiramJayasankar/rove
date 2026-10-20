# Extension messaging API

The `/api/...` names identify structured extension operations. They are not HTTP routes: Relay v2 exposes no localhost server. Only Relay's own extension pages may invoke them. Shared shapes are in `shared/types.ts`; dispatch and validation live in `extension-src/runtime.ts`.

```ts
const response = await chrome.runtime.sendMessage({
  type: "relay-api",
  path: "/api/runs",
  method: "POST",
  body: { prompt: "Read the current page title", tabId: 123 },
});
if (!response.ok) throw new Error(response.error);
const run = response.data;
```

Success is `{ok:true,data}`; failure is `{ok:false,error}`. `method` defaults to `GET`, and omitted body becomes `{}`. This small-message interface is useful for integration clients. These operations are unavailable to websites, content scripts or other extensions.

The workbench uses a trusted `relay-rpc` runtime port for the same operations. It serializes `{path,method,body?}` into `{type:"chunk",data:string}` messages of at most 1,000,000 characters, followed by `{type:"end"}`. The worker responds with the plain JSON result using the same chunks/end framing, or `{type:"error",error:string}`. This preserves complete large histories across Chrome's per-message size limit. A disconnected request is never automatically retried: its outcome may be unknown. `src/transport.ts` owns framing, cleanup and error propagation.

| Method | Operation                  | Behavior                                                                                         |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/api/health`              | Version and extension runtime identity                                                           |
| GET    | `/api/state`               | Settings, key-present flag, model metadata, tabs, run summaries, active run and tool catalogue   |
| GET    | `/api/tabs`                | Refresh Chrome tab inventory                                                                     |
| GET | `/api/settings` | Normalized saved settings, key-present flag, and selected model metadata; never the key |
| PUT    | `/api/settings`            | Full settings, optional `apiKey`; omit key to retain, empty string to clear; reject while active |
| PUT    | `/api/approval-mode`       | `{mode}`; persists and updates live approval behavior                                            |
| PUT    | `/api/run-options`         | Model and reasoning effort selection only; active run keeps its configuration snapshot |
| GET    | `/api/models`              | Endpoint catalogue and selected metadata; `?refresh` bypasses catalogue cache                    |
| POST | `/api/models` | Candidate `{baseUrl,apiKey?,refresh?}` catalogue lookup before saving; no settings or key changes and no saved-model broadcasts |
| POST   | `/api/model/test`          | Candidate settings/key; verify a harmless function call without saving settings                  |
| POST   | `/api/browser`             | `{action,args}` manual built-in tool; during a run only tabs/screenshots are allowed             |
| POST   | `/api/runs`                | `{prompt,tabId?}`; prepare a controllable tab and start one task                                 |
| GET    | `/api/runs/:id`            | Full run and persisted events                                                                    |
| GET    | `/api/runs/:id/export`     | Full run object; the UI creates the download                                                     |
| POST   | `/api/runs/:id/messages` | `{message,tabId?,editMessageId?}`; append a follow-up, or replace the specified user-message event and all later history. ID `0` edits the first prompt. `tabId:null` starts in a new tab. Earlier browser effects are not undone. |
| POST   | `/api/runs/:id/stop`       | Stop scheduling and abort waits/requests; no rollback                                            |
| POST   | `/api/runs/:id/approval`   | `{approvalId,approved}` resolves a specific pending decision                                     |
| POST   | `/api/runs/:id/reply`      | `{message}` answers a pending user question                                                      |

Model API keys persist in a dedicated trusted `chrome.storage.local` entry, separate from settings and history. Omit `apiKey` when saving settings to retain the saved key; provide an empty string to clear it. A one-time migration retains an existing session key when no persistent entry exists and removes the legacy session entry. Responses and logs never include the credential.

Candidate `POST /api/models` uses the supplied key, including an explicitly empty key for a keyless endpoint; omission uses the private saved key. Endpoint validation rejects non-HTTP(S) addresses and embedded credentials. It does not save candidate connection details or broadcast them as the active model. Settings always normalize automatic context and reasoning format, streaming and vision; removed legacy flags/definitions are discarded. Full history import/backup and manual learned-profile reset operations are no longer exposed; individual run export remains available.

## Live events

Open a trusted runtime port rather than an EventSource:

```ts
const port = chrome.runtime.connect({ name: "relay-events" });
port.onMessage.addListener(({ type, data }) => {
  // Apply state, run, event and status updates by run/event ID.
});
```

Messages are `{type,data}`. The worker sends fresh `state` on connection, followed by `bridge`, `run`, `event`, `run_status`, `settings`, `model_info` and `browser_notice` updates. `bridge` is the retained browser-status shape, not a network connection. `event` contains `{runId,event}` with increasing IDs within a run. `run_status` contains `{id,status,updatedAt}`. Browser notices include debugger detachments and dialogs.

The UI reconnects ports and retrieves full runs when required. It merges events by ID so an older request response cannot erase newer live events. Terminal persistence and history recovery belong to the worker, independent of an open panel.

Tool names, schemas and browser behavior are documented in [browser tools](browser-tools.md). Privileged messages are checked against both the extension ID and extension-page URL; the runtime registers no external or page-message forwarding surface. See [architecture](architecture.md) for checkpoints, storage and restart behavior.
## Multiple provider catalogues

State/settings responses include `providers` (id, name, baseUrl, model, hasApiKey) and `activeProviderId`. All saved profiles participate in discovery; active identifies the model/credential used for the next task, not an enable/disable flag.

- `POST /api/providers` with `{name, baseUrl}` adds a profile and selects it for configuration. Existing profiles remain available.
- `PUT /api/providers` with `{id, model?}` selects a saved connection. `DELETE` with `{id}` removes it; one profile must remain. These operations require an idle engine.
- `PUT /api/settings` additionally accepts `providerName` and `providerId`; the latter rejects saves from a stale configuration window. The existing `apiKey` input updates only the selected profile. Settings, selected profile and active credential commit together.
- `GET /api/models` combines saved catalogues; `POST` still accepts unsaved connection discovery parameters and overrides only the configured profile while combining the others. Entries retain original model IDs and add `providerId`/`providerName`. Duplicate IDs across providers stay distinct. Partial discovery failures return `warnings` without hiding successful catalogues.
- `PUT /api/run-options` accepts `providerId` with `model`; model selection routes to that profile's endpoint/key. Already-running work retains its original settings/key snapshot. No automatic provider fallback occurs.

Provider credentials live only in trusted storage (`modelProviderKeys`, plus the active `modelApiKey` mirror) and are never returned by these APIs or included in journal/export settings. Existing single-provider settings migrate automatically.
