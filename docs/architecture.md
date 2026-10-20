# Architecture

Rove v2 runs entirely inside Chrome. A Manifest V3 service worker composes the agent, model adapter, durable store and browser controller. The same React application serves the side panel and full options workbench. Up to three chats run concurrently, each with exclusive ownership of its tabs.

```mermaid
flowchart LR
  UI[React side panel / workbench] -->|Trusted runtime messages| Runtime[Extension service worker]
  Runtime --> Engine[Per-chat agent loops, maximum 3]
  Engine --> Model[Chat Completions adapter]
  Model --> Endpoint[User's model endpoint]
  Engine --> Tools[Interpreted schema / tool registry]
  Tools --> Browser[Shared serial queue / tab leases / Chrome CDP]
  Browser --> Tabs[Existing Chrome tabs]
  Engine --> Journal[IndexedDB event journal]
  Runtime -->|rove-events port| UI
  Runtime --> Storage[Chrome local / session storage]
```

## Boundaries

`extension-src/runtime.ts` owns trusted requests, event subscriptions, run admission, credentials and lifecycle. `store.ts` owns transactional settings/history persistence and interrupted-run recovery. `browser.js` owns Chrome permissions, debugger sessions, frame routing, transient refs and native input.

In `extension-core/`, `agent.ts` owns the conversation, approvals, cancellation and execution order. `conversation.ts` reconstructs a follow-up from the latest recorded request, completed response and tool outcomes. `model.ts` owns Chat Completions requests, streams and provider errors. `context.ts` manages token estimates and complete-group eviction. `tools.ts` defines the built-in browser tool schemas and dispatch through `BrowserTransport`. `catalogue.ts` normalizes endpoint metadata and persists credential-isolated learned limits. `provider-capabilities.ts` holds exact, sourced fallbacks for missing provider fields; endpoint metadata always wins. See [capability discovery](model-capabilities.md).

The worker uses browser APIs only. Tool schemas are interpreted by [@cfworker/json-schema](https://github.com/cfworker/cfworker/tree/master/packages/json-schema), avoiding runtime code generation under extension CSP. Advanced JavaScript executes explicitly in the selected page, rather than inside the worker. Removed custom-tool definitions are discarded from legacy settings; historical run events remain intact.

## Lifecycle and durability

1. Validate a task and reserve a slot before asynchronous admission. Count active runs plus admissions against the fixed limit of three; reject excess requests without queuing. Reject a second response for the same chat, including simultaneous edits/continuations. Lease and prepare the selected tab and attach a debugger before model work. Explicit New Tab mode (`tabId:null`) needs no tab until navigation.
2. Snapshot settings and the selected provider's credential synchronously in `begin()`. Record configuration and model metadata. Combine the base policy, editable instructions, task and selected-tab context. Each run owns its controller, history, pending input, selected/owned tabs and approval mode.
3. Record the model request, flush the durable journal checkpoint, then request/stream the provider response. Partial tool calls never execute.
4. Validate tools and arguments; pause for required approval or a user answer. Record intent and commit a checkpoint before dispatch. Execute each run's tools in order through one global browser queue, checking cancellation and tab leases immediately before dispatch. Waits bypass the queue so another run can progress. New navigation tabs are leased before attach/navigation, even if navigation later fails. First explicit use of an unleased tab acquires it. A collision becomes a tool error in the requesting conversation, not a failed run. Tab inventories mark other active owners with `busyWithAnotherTask:true`. Agent actions never fall back to a remembered or focused tab; only manual calls and admission can select a focused tab.
5. Capture passive screenshots after browser actions. Image events back the UI; supported model image inputs are selected automatically. Preserve valid structured snapshots, frame refs and pagination when bounding results.
6. Persist terminal state and learned limits, then release only this run's leased debugger sessions, skipping open dialogs until dismissal. Stop aborts requests/waits and prevents further dispatch; already-dispatched actions may finish. Cleanup rechecks ownership because a follow-up may already have started. Global detach requires no active runs, no admissions and no pending dialogs; startup recovery separately releases orphaned clients.

Active debugger sessions keep extension workers alive in supported Chrome versions. Rove also maintains one keep-alive interval whenever the engine's active-run set is nonempty, including New Tab mode before navigation. Completing one run cannot clear it while another is active, following Chrome's [worker lifecycle guidance](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). This does not replace crash recovery: on worker initialization, every previously running or awaiting run becomes failed with an interruption event. Startup releases debugger sessions left attached by the previous worker and starts with an empty in-memory lease map; Chrome scopes detach to the calling extension. Actions are never replayed automatically.

Debugger preflight uses `Target.getTargetInfo`, which does not wait for a renderer blocked by a JavaScript dialog. A new task can reset a stale owned attachment before dispatch. Orphaned clients are verified using an extension-scoped command and reset to rebuild frame subscriptions; clients belonging to DevTools or other extensions are not detached. Closing a tab intentionally first releases its session. Session cancellation clears outstanding command deadlines so old work cannot later detach a new session. Lost iframe sessions invalidate that frame's references, without detaching the root tab.

Chrome's root `onDetach` notification has no session generation. Rove confirms ownership with a bounded, read-only probe before clearing the tracked client; dispatch waits for that check. A delayed notification from an old client cannot delete a healthy replacement during initialization. Chrome banner cancellation (`canceled_by_user`) stops all active runs. `target_closed` and `connection_lost` stop only the active lease owner, even if it has selected another tab. Command timeouts and other detach reasons surface through that run's tool errors, without stopping unrelated tasks or replaying actions. See the [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) for tab routing and detach notifications.

Explicit task admission activates the selected tab before enabling renderer domains. Background/discarded renderers can accept a debugger client while failing to answer `Page.enable` until awakened. Initialization preserves that command's original error and stops immediately; it must not swallow the timeout and issue `Runtime.enable` against the disposed client. The command timeout settles before session cancellation so its precise cause is retained.

Task admission uses a counter and chat reservations, separate from the settings mutex. Reservations become active runs synchronously, before releasing a slot, so racing requests cannot exceed the cap. Admission waits for earlier settings transactions; endpoint/profile and credential commits remain coherent. Provider administration and full settings/key saves require no active runs or admissions. The model/reasoning picker remains available during runs because each response uses its own snapshot. Approval changes with a run ID affect only that response; without one they persist the default for new responses and never resolve existing pending input. Locked site-rule approvals always require an explicit decision.

Context admission reserves output capacity, accounts for images independently of base64 transport size, and retains complete assistant/tool groups. Advertised limits, estimates and provider usage stay distinct. Structured context failures permit bounded recovery of the model request; successful reduced input/image budgets are learned without replaying browser mutations.

## Chat continuation

A chat retains one run ID across user turns. POST messages appends a user_message event and re-enters the serialized agent loop. Steps and event IDs remain monotonic. Reconstruction uses the latest context-admitted request and subsequent confirmed results; it never re-dispatches historical tools. Missing results in an interrupted batch become explicit unknown-outcome tool responses. Image observations reference screenshot event IDs, so reused provider call IDs cannot substitute the wrong image. Legacy ambiguous image references are omitted with a fresh-observation instruction. Current system instructions replace the historical system message. Worker restart still marks an in-flight response failed; the user can explicitly send a follow-up afterward.

Editing a message explicitly replaces history from that turn onward. The retained prefix commits atomically in IndexedDB, and the chat revision increases so UI caches cannot merge removed events back into the edited chat. Event IDs remain monotonic within each revision. Existing browser effects are not undone. Questions and replies render together inside the tool step that requested input, including when viewing saved history; returned `user_question.callId` and `user_reply.questionId` also link the raw events.

The UI renders turns chronologically and keeps the chat mounted while settings is open. Per-chat drafts and scroll state remain available on return. History orders chats by their latest activity. Model search, effort and approval controls share anchored popover behavior. shared/usage.ts totals response usage across model changes and keeps current context, reservations, cumulative input/output, cached/reasoning tokens and cost separate. Unreported/interrupted usage is never represented as complete zero-cost usage.

## Storage

| Data                                 | Location                         | Lifetime                                                                              |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------- |
| Normalized settings | `chrome.storage.local` | Persistent extension data; automatic context/reasoning format, streaming and vision |
| Learned model limits                 | `chrome.storage.local`           | Persistent, indexed by endpoint/credential SHA-256 and model                          |
| Model API key | Dedicated trusted `chrome.storage.local.modelApiKey` | Persists across worker/browser/extension restarts until explicitly cleared or the extension is uninstalled |
| Run metadata and events              | IndexedDB                        | Persistent history; event records append by run/event ID                              |

Run metadata and new events commit in one IndexedDB transaction. `save` queues writes; `checkpoint`/`flush` awaits completion before requests or actions. Storage failures stop dispatch. The UI loads run summaries first and retrieves complete history when needed. Chunked `rove-rpc` transfers avoid Chrome's per-message size limit for large histories. Event IDs reconcile live updates; a reconnected `rove-events` port receives fresh state.

Credentials never enter settings, history, run exports or API responses. Startup restricts local/session storage to trusted extension contexts, migrates a retained legacy session credential only if no persistent credential exists, then removes the old session entry. Saving an empty key clears the persistent credential; omitting it retains the existing one. Individual runs remain exportable; whole-history backup/import is removed.

## Trust and permissions

Only pages with this extension's identity and URL may call the privileged runtime or open event ports. There are no external-message listeners, page-content relays, HTTP listeners or pairing tokens. The manifest grants debugger, tabs, storage, downloads and side-panel capabilities plus HTTP(S) host access for browser tasks and chosen endpoints.

Model requests reject redirects. Text traces redact the configured model key; screenshot pixels cannot be reliably redacted. Web observations sent to the model go to the selected provider. Generic evaluation, raw CDP and file uploads begin disabled. Prompts guide behavior, while permissions, validation, scoped routing and approval decisions provide enforceable boundaries. Candidate model catalogue lookups validate unsaved endpoint/key inputs without saving or broadcasting them as the active configuration.

## Keeping the panel in sync

The worker pushes events over a long-lived port, but a port can drop or stall and nothing replays what it missed. The panel therefore reconciles against stored state: on every (re)connect, when it regains focus, and every 4 s while a task is active it compares `/api/state` summaries (status, revision, `lastEventId`) with its own copy and re-fetches any run that differs. `tests/extension/resync.spec.ts` covers a port that never delivers.

Clients reconcile `activeRunIds` as a set. `activeRunId` remains the newest active ID for compatibility. Status updates add only the identified running/awaiting chat, or remove only the identified terminal chat; another task finishing must never clear all activity. Settings/state broadcasts carry the same active IDs. A model request times out on silence rather than total duration; an empty final reply is retried twice before the task fails. Model/reasoning selection affects subsequent responses, while existing responses retain their snapshots.
