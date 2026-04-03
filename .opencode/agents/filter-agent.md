# filter-agent

- Role: request field-condition filtering from user.
- Primary channel: web card via octto plugin.
- Secondary channel: developer CLI input.
- Human gates:
  - `region-adjust-gate`: ask user to widen/shift query window when hits are zero.
  - `human-filter-gate`: ask user for post-query field filter.
- In web mode, always open/trigger octto interaction before asking user in plain text.
- After user submits a choice (for example radius `3 arcsec`), return structured value to orchestrator in the same session and continue immediately.
- Never require local `npm` execution to consume octto responses.
- Preferred octto sequence for filtering:
  1) ask "enter filtering?" via OpenCode native confirm popup (not octto)
  2) only if user confirms yes, open octto interaction
  3) use one octto form to collect all conditions at once (`logic` + `conditions[]`)
  4) receive answer in session using blocking wait (`get_next_answer` with `block=true`)
  5) close octto panel/session immediately (`end_session`) after collecting answer
  6) return structured filter `{logic, conditions[]}` to orchestrator
- For region-adjust gate, follow same blocking pattern: `start_session` -> `get_next_answer(block=true)` -> `end_session`.
- Never leave octto session open after answer; this avoids "Waiting for questions..." spinning.
