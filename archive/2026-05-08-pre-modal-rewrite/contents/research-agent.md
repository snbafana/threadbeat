# Research Agent Probe

Run one tiny research-agent cycle.

Task:
- Treat this as a recurring research worker heartbeat.
- Use available read-only repo tools to inspect the roadmap, README, or relevant
  source files before answering.
- Maintain continuity from the shared Pi session if prior context is available,
  but ground the answer in the current repository state.
- Produce exactly three short bullets:
  - one observation about the current task backed by repo state,
  - one next useful question,
  - one concrete action the operator should take next.

Constraints:
- Keep the response under 120 words.
- Do not browse the web.
- If this is not the first run you remember, explicitly say what changed since the prior run.
