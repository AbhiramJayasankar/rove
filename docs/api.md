# Extension messaging API

The `/api/...` names identify structured extension operations. They are not HTTP routes: Rove v2 exposes no localhost server. Only Rove's own extension pages may invoke them. Shared shapes are in `shared/types.ts`; dispatch and validation live in `extension-src/runtime.ts`.

```ts
const response = await chrome.runtime.sendMessage({
  type: "rove-api",
  path: "/api/runs",
  method: "POST",
  body: { prompt: "Read the current page title", tabId: 123 },
});
if (!response.ok) throw new Error(response.error);
const run = response.data;
```

Success is `{ok:true,data}`; failure is `{ok:false,error}`. `method` defaults to `GET`, and omitted body becomes `{}`. This small-message interface is useful for integration clients. These operations are unavailable to websites, content scripts or other extensions.

The workbench uses a trusted `rove-rpc` runtime port for the same operations. It serializes `{path,method,body?}` into `{type:"chunk",data:string}` messages of at most 1,000,000 characters, followed by `{type:"end"}`. The worker responds with the plain JSON result using the same chunks/end framing, or `{type:"error",error:string}`. This preserves complete large histories across Chrome's per-message size limit. A disconnected request is never automatically retried: its outcome may be unknown. `src/transport.ts` owns framing, cleanup and error propagation.

| Method | Operation                  | Behavior                                                                                         |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/api/health`              | Version and extension runtime identity                                                           |
| GET    | `/api/state`               | Settings, key-present flag, model metadata, tabs, run summaries, `activeRunIds`, compatibility `activeRunId` and tool catalogue |
| GET    | `/api/tabs`                | Refresh Chrome tab inventory                                                                     |
| GET | `/api/settings` | Normalized saved settings, key-present flag, and selected model metadata; never the key |
| PUT    | `/api/settings`            | Full settings, optional `apiKey`; omit key to retain, empty string to clear; reject while active |
| PUT    | `/api/approval-mode`       | `{mode,runId?}`; with a run ID changes only that active response; otherwise persists the default for new responses |
| PUT    | `/api/run-options`         | Model and reasoning effort selection only; active run keeps its configuration snapshot |
| GET    | `/api/models`              | Endpoint catalogue and selected metadata; `?refresh` bypasses catalogue cache                    |
| POST | `/api/models` | Candidate `{baseUrl,apiKey?,refresh?}` catalogue lookup before saving; no settings or key changes and no saved-model broadcasts |
| POST   | `/api/model/test`          | Candidate settings/key; verify a harmless function call without saving settings                  |
| POST   | `/api/browser`             | `{action,args}` manual built-in tool; allowed on tabs without an active lease, including while other tasks run |
| POST   | `/api/runs`                | `{prompt,tabId?:number\|null,attachments?}`; start a task, up to three concurrent tasks; `null` selects New Tab mode without creating a tab |
| GET    | `/api/runs/:id`            | Full run and persisted events                                                                    |
| GET    | `/api/runs/:id/export`     | Full run object; the UI creates the download                                                     |
| POST   | `/api/runs/:id/messages` | `{message,tabId?,editMessageId?,attachments?}`; append a follow-up, or replace the specified user-message event and all later history. ID `0` edits the first prompt. `tabId:null` starts in a new tab. Earlier browser effects are not undone. Attachments may only accompany an append. |
| POST   | `/api/runs/:id/stop`       | Stop scheduling and abort waits/requests; no rollback                                            |
| POST   | `/api/runs/:id/approval`   | `{approvalId,approved}` resolves a specific pending decision                                     |
| POST   | `/api/runs/:id/reply`      | `{message}` answers a pending user question                                                      |

Model API keys persist in a dedicated trusted `chrome.storage.local` entry, separate from settings and history. Omit `apiKey` when saving settings to retain the saved key; provide an empty string to clear it. A one-time migration retains an existing session key when no persistent entry exists and removes the legacy session entry. Responses and logs never include the credential.

## Message attachments

Both message operations accept up to five attachments. Each has a nonempty `name` (trimmed and truncated to 120 characters for display), a nonnegative integer byte `size`, `mime`, and `kind`. Image attachments use `kind:"image"`, MIME `image/png`, `image/jpeg`, `image/webp` or `image/gif`, and a matching base64 `dataUrl` of at most 6,000,000 characters. Text attachments use `kind:"text"`, a string MIME, and `text` of at most 200,000 characters. Invalid input returns the ordinary error envelope before admission. Supplying attachments with `editMessageId` is rejected.

The journal records one `attachment` event per file, in input order, with data `{name,kind,mime,size,dataUrl?,text?}`. Image events carry only `dataUrl`; text events carry only `text`. These events and the model request intent pass the durable checkpoint before dispatch. Readable fields use the existing credential redaction; image data URLs remain intact.

The user turn starts with the prompt and browser context, then adds fenced, explicitly untrusted text files and image captions immediately followed by image parts. Captions are `[Rove attachment <eventId>] Image attached by the user: <name>`. Text-only models retain captions without image pixels. Request traces omit base64, and continuation restores each image from its caption's journal ID, alongside the existing screenshot references. Attachments and screenshots share the image budget; omitted images leave their captions and the existing omission note. Editing retains attachments before the cut and drops attachments at or after it. Markdown exports list names beneath the associated message as `- Attached: <name>`, without file contents.

## Concurrent tasks and panel contract

`POST /api/runs` and `POST /api/runs/:id/messages` return a `RunRecord` (`id`, `prompt`, `status`, `createdAt`, `updatedAt`, `events`, optional `revision`/`lastEventId`). Other active chats do not block admission. Requests exceeding the fixed cap fail with `Up to 3 tasks can run at once.`; there is no task queue. Admission reservations count toward the cap, including racing requests. A continuation/edit of an already active or admitting chat fails with `Stop the current response before continuing this chat.`. A tab leased by another active/admitting task rejects admission before resetting its debugger. Omitted `tabId` permits focused-tab selection at admission; `null` chooses New Tab mode. Agent tools always target an explicit tab or navigate with `newTab:true`.

`GET /api/state` returns `AppState` with fields `providers`, `activeProviderId`, `settings`, `modelInfo`, `hasApiKey`, `bridge`, `runs`, `activeRunIds`, `activeRunId`, `tools`. `runs` contains summaries with empty `events` and `lastEventId` for reconciliation. `activeRunIds:string[]` is ordered by admission, oldest first; it contains both `running` and `awaiting_approval` responses. `activeRunId:string|null` is its last member or `null`. Track all active chats with the array/set, not the compatibility singleton.

`GET /api/settings`, successful settings/provider/run-options mutations and `settings` broadcasts return `{providers,activeProviderId,settings,hasApiKey,modelInfo,activeRunIds,activeRunId}`. `PUT /api/approval-mode` accepts `mode:"always"|"risky"|"never"`. With `runId:string` it requires that response to be active, emits a journal `approval_mode_changed` event with `{mode}`, and additionally returns/broadcasts `{runId,approvalMode:mode}`. It leaves the saved default unchanged. Without `runId` it saves only the new-run default; existing runs and pending decisions are untouched. Only a targeted change to `never` may auto-answer that run's unlocked pending approval. Site-rule approvals stay locked; user questions never auto-resolve. Read a response's original approval mode from `run_configuration.data.settings.approvalMode`, then apply its `approval_mode_changed` events.

`PUT /api/run-options` accepts `{providerId?:string,model?:string,reasoningEffort?:string}` and remains available during active runs. Settings and provider selection/key changes serialize through a separate settings mutex. New responses snapshot the resulting settings/key; existing responses keep theirs. `PUT /api/settings` and `POST/PUT/DELETE /api/providers` reject while any run/admission is active with `Stop the active tasks before changing settings.`. Candidate model discovery and `POST /api/model/test` do not change run snapshots or detach active clients.

Connection probes hold idle browser cleanup until they finish, but do not consume any of the three task slots. Admission enters the settings mutex again at `begin()` so an overlapping picker save finishes before the new response snapshots its endpoint and key.

`browser_tabs` tool results contain the ordinary tab fields plus `busyWithAnotherTask:boolean`, relative to the requesting run. Its own tabs are false; another active task's tabs are true. `bridge.tabs` uses the same marker relative to manual callers. Manual `/api/browser` calls, including screenshots/snapshots, cannot touch any active lease. A model tool collision produces `tool_result` with `{callId,name,result:null,error:string}` and a matching tool response in the conversation; the run continues. First explicit use of an unleased tab acquires it; navigation claims new tabs before dispatch. Terminal cleanup releases only that run's clients, retaining open dialogs until dismissal.

`GET /api/tabs` also includes `busyWithAnotherTask`, relative to manual callers. Admission, manual calls and model tools use the same lease-collision error: `Tab <tabId> is owned by another task. Choose an unleased tab or navigate with newTab:true.`. Approving or changing the mode of an inactive response fails with `Run is not active.`; an active response rejects an obsolete or different response's approval ID with `This approval is no longer pending.`. Errors use the standard `{ok:false,error}` envelope; model tool errors stay inside that run's conversation.

Candidate `POST /api/models` uses the supplied key, including an explicitly empty key for a keyless endpoint; omission uses the private saved key. Endpoint validation rejects non-HTTP(S) addresses and embedded credentials. It does not save candidate connection details or broadcast them as the active model. Settings always normalize automatic context and reasoning format and streaming; the vision flag follows the endpoint and the per-model override below; removed legacy flags/definitions are discarded. Full history import/backup and manual learned-profile reset operations are no longer exposed; individual run export remains available.

`PUT /api/model-override` `{ baseUrl, model, override }` saves, or with `override: null` clears, the user's choices for one model on one endpoint (stored in `chrome.storage.local` under `rove.modelOverrides.v1`, independent of the API key). `override.images` is `"on"` or `"off"`; `override.reasoning` is up to 8 levels `{ value, label, body }` listed lowest first, where `body` is a JSON object merged into the chat request and may not set `model`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options`, `max_tokens` or `max_completion_tokens`. The returned and broadcast `modelInfo` (the chat model) carries `override`, `customReasoning`, `endpointVision` (what the endpoint said) and the effective `supportsVision`; the response's `model` is the saved model itself with the same fields, or `null` if no listed catalogue on that endpoint has it. A llama.cpp server (`owned_by: "llamacpp"`) is probed at `/props` for image support and a thinking template; `meta.n_ctx` supplies the context window.

## Live events

Open a trusted runtime port rather than an EventSource:

```ts
const port = chrome.runtime.connect({ name: "rove-events" });
port.onMessage.addListener(({ type, data }) => {
  // Apply state, run, event and status updates by run/event ID.
});
```

Messages are `{type,data}`. The worker sends fresh `state` (`AppState`) on connection, followed by `bridge`, `run`, `event`, `run_status`, `settings`, `model_info` and `browser_notice` updates. `bridge` is the retained browser-status shape, not a network connection. `event` contains `{runId,event:{id,time,type,data}}` with increasing IDs within each run. `run_status` contains `{id,status,updatedAt,activeRunIds,activeRunId}`. Add `id` to the active set for `running`/`awaiting_approval`; remove only `id` for `completed`/`failed`/`stopped`. The included active array and newest ID reflect membership after that transition and can replace the local set. In particular, a terminal status for one chat must not clear another chat's activity. State on reconnect repairs missed events. Browser notices include debugger detachments and dialogs; Chrome banner cancellation stops all runs, while lost/closed tabs stop only their active lease owner.

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
