# Reporting — how this skill and the API get better

`report_issue` files a structured report on the user's device and, when they allow it, sends a redacted copy to {{name}}. Reports are clustered by what went wrong and ranked by how often, how badly and how widely it happens. They decide what gets fixed next — which makes an honest report the most useful thing you can do after a failure.

## When to report

- **api-gap** — you needed a capability no verb, path or patch expresses (painting pixels, reordering a grade node's effects, tracking an object…).
- **api-bug** — a command did something other than its description, or failed internally.
- **docs-mismatch** — this skill or a reference was wrong, stale, or missing something you needed.
- **agent-mistake** — you misread the request, misused a tool, or produced something you had to undo. Yes, report your own mistakes: they show where guidance is unclear.
- **app-bug** — a render or behaviour that is broken (a black frame, a console error tied to your action).
- **feature-request** — the user asked for something the product does not do.

Do not report: a user changing their mind, a provider outage (the app tracks those), or the same problem twice in one chat.

## How to write one

| Field | Write |
|---|---|
| `title` | under 80 chars, specific: "No verb to reorder the effects inside a grade node" |
| `tried` | what you were doing, one sentence |
| `happened` | what actually happened — the gap, the wrong output, your mistake |
| `expected` | the result the user wanted |
| `suggestion` | the fix in API or skill terms: "a `grade.move {nodeId, effectId, index}` verb", "motion.md should say stagger is per-unit, not total" |
| `fault` | `ours-api` · `ours-docs` · `ours-app` · `model` (you) · `user` · `provider` · `unknown` |
| `severity` | 1 cosmetic · 2 minor detour · 3 had to work around it · 4 result is noticeably worse · 5 could not do the task |
| `command`, `error` | the command and exact error text, when there was one |

Never put the user's content, file names or personal details in a report beyond what is needed to describe the problem. Tell the user in one line that you reported it, then carry on with what you can do.
