# Interface decisions

The redesign applies the current [Anthropic frontend-design skill](https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md), pulled directly from Anthropic's GitHub repository on 2026-10-20. The brief is a browser-control application: remove blue tones and unnecessary captions, expose automatic approval, and make the primary task easy to operate.

## Direction

The interface behaves like a compact desktop workspace. Its characteristic content is the actual browser page. The browser occupies the larger pane; conversation and a bottom-anchored prompt occupy the other. There is no promotional hero or simulated browser window.

Palette: canvas `#F5F4F0`, surface `#FFFFFF`, ink `#2B2C26`, secondary text `#74756B`, olive action `#526344`, and error `#A84B3E`. There are no blue UI tokens. Captured websites retain their actual colors.

Type uses the local Segoe UI family, keeping the interface native to the Windows browser workflow. Type is restrained: small operational headers, readable task text, monospace only for code. No external font request is necessary.

```text
Task history | Current task             Auto-approve  Stop  Model
             | Activity / Trace | Tab selector / browser controls
             | Pending decision | Actual page screenshot
             | Task conversation|
             | Prompt + Run     |
```

The first plan retained too much status chrome. The final plan removes the tagline, workspace breadcrumb, secondary captions, decorative browser dots, setup slogans, repeated safety cards, and raw model-event rows from the default activity. Runtime status and labels remain only where they support a decision.

## Interaction

- Auto-approve is next to Stop and works during a pending approval. Explicit questions still need answers.
- Decisions appear above the scrolling conversation; they cannot disappear beneath a long log.
- Activity pairs each tool call with its result. Trace preserves the complete inspectable event record.
- The prompt remains reachable at the bottom. Automatic log scrolling yields when the user scrolls upward.
- The browser follows the agent's target tab until the user selects another tab. A new task retains the last captured page instead of replacing it with an empty illustration.
- Narrow screens show Task and Browser tabs rather than stacking two tall workspaces. Settings use four short sections with one save action.
- Answers use safe Markdown rendering, including links and tables. Raw HTML is not enabled.

Keyboard focus, reduced motion, disabled states, and touch controls remain supported. Screenshot and interaction checks include desktop, phone, pending decisions, settings, and the live auto-approval transition.
