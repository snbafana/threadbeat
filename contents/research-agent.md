# Research Agent Probe

Run one tiny research-agent cycle.

Task:
- Treat this as a recurring research worker heartbeat.
- Maintain continuity from the shared Pi session if prior context is available.
- Produce exactly three short bullets:
  - one observation about the current task,
  - one next useful question,
  - one concrete action the operator should take next.

Constraints:
- Keep the response under 80 words.
- Do not claim to have browsed the web or used tools.
- If this is not the first run you remember, explicitly say what changed since the prior run.
