# Execution workspace

Applied Anthropic's frontend-design skill, fetched from its official skills repository. The user's brief is a transparent browser agent: no blue, no ornamental captions, large usable context, visible reasoning, inspectable tools, and a model picker inside chat.

Palette: porcelain #F7F7F4, paper #FFFFFF, graphite #302D31, aubergine #59384E, copper #B54A2F, rule #DDDCD7. Trebuchet MS provides humanist interface text; Bahnschrift provides compact operational headings; Cascadia Code is reserved for actual code.

Layout: dark task history, a white conversation column, and a larger graphite browser surface. One expandable execution ledger groups model reasoning and tool calls by actual step. The prompt dock holds model/reasoning selection, context usage and Stop.

```
History | Current task                 Auto-approve / Stop
        | Task / execution ledger | Browser + real page
        | Answer                 | Screenshot
        | Model / Thinking       |
        | Prompt / Stop or Send  |
```

Critique before implementation: another pale rounded chat dashboard would repeat the rejected design. Removed floating outer cards and oversized empty-state copy. Distinction comes from the execution ledger, purposeful dark browser surround, actual step sequencing, and the compact model catalogue, rather than decorative gradients or status badges. All status, counts and reasoning must come from runtime records.
