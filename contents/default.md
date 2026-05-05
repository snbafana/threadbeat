# Default Heartbeat Contents

This is the default markdown file for the toy `threadbeat` heartbeat model.

Use this file as the first contents target for a heartbeat.

The intended execution contract is:

1. Load the heartbeat row.
2. Read the markdown file referenced by `contents`.
3. Feed the file body back into an agent at the scheduled moment.

For now, the control plane stores and schedules the file path only.
