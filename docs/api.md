# Local API

Default base: `http://127.0.0.1:4789`. Browser clients must use this app's Origin. Writes require `Content-Type: application/json`. Errors return `{ "error": "Actionable message" }`. Shared shapes are in `shared/types.ts`.

| Method | Path                     | Behavior                                                                                                                                                               |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`            | Version and readiness                                                                                                                                                  |
| GET    | `/api/state`             | Settings, key-present flag, bridge/tabs, runs, active run, built-in tool catalog                                                                                       |
| GET    | `/api/events`            | Server-sent event stream, initial full state and incremental updates                                                                                                   |
| PUT    | `/api/settings`          | Full `Settings` plus optional `apiKey`; omit key to retain, empty string to clear. Reject while active.                                                                |
| PUT    | `/api/approval-mode`     | `{mode}` updates current and future runs. `never` resumes a pending tool approval; `risky` reviews interactions; `always` reviews every tool. Questions remain paused. |
| POST   | `/api/model/test`        | Optional connection fields, verifies harmless function call; does not change settings                                                                                  |
| GET    | `/api/pairing`           | Secret pairing token, local URL and extension folder                                                                                                                   |
| POST   | `/api/pairing/rotate`    | Rotate token and disconnect bridge; reject while active                                                                                                                |
| GET    | `/api/tabs`              | Refresh Chrome tab list                                                                                                                                                |
| POST   | `/api/browser`           | `{action, args}` manual built-in command; while active, only tabs/screenshot allowed                                                                                   |
| POST   | `/api/runs`              | `{prompt, tabId?}` starts a task and returns its record immediately                                                                                                    |
| GET    | `/api/runs/:id`          | Full persisted record and events                                                                                                                                       |
| GET    | `/api/runs/:id/export`   | JSON attachment                                                                                                                                                        |
| POST   | `/api/runs/:id/stop`     | Abort active run, prevent further dispatch                                                                                                                             |
| POST   | `/api/runs/:id/approval` | `{approvalId, approved}` resolves that specific pending decision                                                                                                       |
| POST   | `/api/runs/:id/reply`    | `{message}` resumes a pending user question                                                                                                                            |

`state`, `bridge`, `run`, `event`, `run_status`, `settings` and `browser_notice` are named SSE events. `event` is `{runId,event}` with monotonically increasing event IDs within each run. `run_status` is `{id,status,updatedAt}`. Chrome notices include debugger detachment and JavaScript dialogs. On reconnect the stream sends a fresh complete `state` so missed events are recovered.

Agent-friendly example, after pairing and model setup:

```sh
curl -H "Content-Type: application/json" -d '{"prompt":"Read the current page title and summarize it","tabId":123}' http://127.0.0.1:4789/api/runs
```

The API is intentionally local. A native local process can access it as the current OS user; web Origins are constrained. Do not forward this port or deploy it as a public service without adding an appropriate authentication and browser-isolation design.

## Model catalogue and run options

`GET /api/models` retrieves the configured endpoint's `/models` catalogue through the backend, with its memory-held key. Entries contain `id`, `name`, optional `contextWindow`, and an ID-derived `free` tag. Results are cached for one minute per endpoint/key. The picker defaults to free-tagged IDs; it does not infer pricing from an unknown provider. Manual ID entry remains available when listing is unsupported.

`PUT /api/run-options` accepts optional `model`, `reasoningEffort` and `contextWindow` fields. Changes persist for the next task, including when a different run is active. They do not mutate that run's captured configuration.

Settings also accept `contextWindow`, `maxOutputTokens`, `maxImages`, `reasoningEffort` (`default`, `none`, `low`, `medium`, `high`), `reasoningFormat` (`auto`, `reasoning_effort`, `thinking`), `stream`, and `modelTimeoutSeconds`. Auto format uses binary thinking for MiMo; it does not invent low/medium/high support for that model. Non-default reasoning settings require endpoint support.

`context_usage` journals the estimated prompt size, configured budget, output reserve, and compaction counts. `model_delta` carries incremental returned content/reasoning; `model_response` contains the completed message, usage, elapsed time and provider request ID when available. Cancellation keeps already-delivered deltas, aborts the upstream stream, and prevents additional dispatch.

## Extension transport

The extension opens `ws://127.0.0.1:4789/bridge?token=...`, announces `{type:"hello",browser:"Chrome",tabs:[...]}`, and exchanges a ping every 20 seconds. Backend commands are `{type:"command",id,action,args}`. Replies are `{type:"result",id,result}` or `{type:"result",id,error}`. Tabs and browser notices are pushed separately. Command IDs are UUID strings; a 45-second backend timeout rejects unresolved calls without retrying them. Transport failures never silently replay commands.
