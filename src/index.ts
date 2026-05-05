type Env = {
  CONTROL_DB: D1Database;
  PROJECT_NAME: string;
};

type SessionRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type HeartbeatKind = "stake" | "review" | "watch" | "sweep";
type HeartbeatStatus = "active" | "paused" | "archived";

type HeartbeatRow = {
  id: string;
  session_id: string;
  title: string;
  kind: HeartbeatKind;
  cadence_seconds: number;
  prompt: string;
  last_tick_at: string | null;
  next_tick_at: string | null;
  status: HeartbeatStatus;
  created_at: string;
  updated_at: string;
};

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });

const html = (content: string, init?: ResponseInit) =>
  new Response(content, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });

const badRequest = (message: string) =>
  json({ ok: false, error: message }, { status: 400 });

const notFound = () => json({ ok: false, error: "not found" }, { status: 404 });

const nowIso = () => new Date().toISOString();

const randomId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function computeNextTickAt(
  cadenceSeconds: number,
  status: HeartbeatStatus,
): string | null {
  if (status !== "active") return null;
  return new Date(Date.now() + cadenceSeconds * 1000).toISOString();
}

async function parseJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function listSessions(env: Env) {
  const result = await env.CONTROL_DB.prepare(
    `SELECT id, name, status, created_at, updated_at
     FROM sessions
     ORDER BY created_at DESC`,
  ).all<SessionRow>();

  return result.results;
}

async function createSession(env: Env, name: string) {
  const id = randomId("ses");
  await env.CONTROL_DB.prepare(
    `INSERT INTO sessions (id, name, status)
     VALUES (?, ?, 'active')`,
  )
    .bind(id, name)
    .run();

  return { id, name, status: "active" };
}

async function listHeartbeats(env: Env, sessionId?: string) {
  const query = sessionId
    ? `SELECT
         id,
         session_id,
         title,
         kind,
         cadence_seconds,
         prompt,
         last_tick_at,
         next_tick_at,
         status,
         created_at,
         updated_at
       FROM heartbeats
       WHERE session_id = ?
       ORDER BY created_at DESC`
    : `SELECT
         id,
         session_id,
         title,
         kind,
         cadence_seconds,
         prompt,
         last_tick_at,
         next_tick_at,
         status,
         created_at,
         updated_at
       FROM heartbeats
       ORDER BY created_at DESC`;

  const statement = env.CONTROL_DB.prepare(query);
  const result = sessionId
    ? await statement.bind(sessionId).all<HeartbeatRow>()
    : await statement.all<HeartbeatRow>();

  return result.results;
}

async function getHeartbeat(env: Env, heartbeatId: string) {
  const result = await env.CONTROL_DB.prepare(
    `SELECT
       id,
       session_id,
       title,
       kind,
       cadence_seconds,
       prompt,
       last_tick_at,
       next_tick_at,
       status,
       created_at,
       updated_at
     FROM heartbeats
     WHERE id = ?`,
  )
    .bind(heartbeatId)
    .first<HeartbeatRow>();

  return result;
}

async function createHeartbeat(
  env: Env,
  input: {
    sessionId: string;
    title?: string;
    kind?: HeartbeatKind;
    cadenceSeconds?: number;
    prompt: string;
    status?: HeartbeatStatus;
  },
) {
  const id = randomId("hb");
  const cadenceSeconds = input.cadenceSeconds ?? 60;
  const status = input.status ?? "active";
  const nextTickAt = computeNextTickAt(cadenceSeconds, status);

  await env.CONTROL_DB.prepare(
    `INSERT INTO heartbeats (
      id,
      session_id,
      title,
      kind,
      cadence_seconds,
      prompt,
      last_tick_at,
      next_tick_at,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.sessionId,
      input.title ?? "heartbeat",
       input.kind ?? "stake",
      cadenceSeconds,
      input.prompt,
      null,
      nextTickAt,
      status,
    )
    .run();

  return await getHeartbeat(env, id);
}

async function updateHeartbeat(
  env: Env,
  heartbeatId: string,
  input: {
    title?: string;
    kind?: HeartbeatKind;
    cadenceSeconds?: number;
    prompt?: string;
    status?: HeartbeatStatus;
  },
) {
  const current = await getHeartbeat(env, heartbeatId);
  if (!current) return null;

  const title = input.title ?? current.title;
  const kind = input.kind ?? current.kind;
  const cadenceSeconds = input.cadenceSeconds ?? current.cadence_seconds;
  const prompt = input.prompt ?? current.prompt;
  const status = input.status ?? current.status;
  const nextTickAt =
    status === "active"
      ? computeNextTickAt(cadenceSeconds, status)
      : null;

  await env.CONTROL_DB.prepare(
    `UPDATE heartbeats
     SET
       title = ?,
       kind = ?,
       cadence_seconds = ?,
       prompt = ?,
       next_tick_at = ?,
       status = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(
      title,
      kind,
      cadenceSeconds,
      prompt,
      nextTickAt,
      status,
      heartbeatId,
    )
    .run();

  return await getHeartbeat(env, heartbeatId);
}

async function tickHeartbeatById(env: Env, heartbeatId: string) {
  const current = await getHeartbeat(env, heartbeatId);
  if (!current) return null;

  const nextTickAt = computeNextTickAt(
    current.cadence_seconds,
    current.status,
  );

  await env.CONTROL_DB.prepare(
    `UPDATE heartbeats
     SET
       last_tick_at = ?,
       next_tick_at = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'active'`,
  )
    .bind(nowIso(), nextTickAt, heartbeatId)
    .run();

  return await getHeartbeat(env, heartbeatId);
}

async function dueHeartbeats(env: Env) {
  const result = await env.CONTROL_DB.prepare(
    `SELECT
       id,
       session_id,
       title,
       kind,
       cadence_seconds,
       prompt,
       last_tick_at,
       next_tick_at,
       status,
       created_at,
       updated_at
     FROM heartbeats
     WHERE status = 'active'
       AND next_tick_at IS NOT NULL
       AND next_tick_at <= ?
     ORDER BY next_tick_at ASC`,
  )
    .bind(nowIso())
    .all<HeartbeatRow>();

  return result.results;
}

async function tickHeartbeatsBySession(env: Env, sessionId: string) {
  const currentTime = nowIso();
  const sessionHeartbeats = await listHeartbeats(env, sessionId);

  for (const heartbeat of sessionHeartbeats) {
    if (heartbeat.status !== "active") continue;
    await env.CONTROL_DB.prepare(
      `UPDATE heartbeats
       SET
         last_tick_at = ?,
         next_tick_at = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(
        currentTime,
        computeNextTickAt(heartbeat.cadence_seconds, heartbeat.status),
        heartbeat.id,
      )
      .run();
  }

  return await listHeartbeats(env, sessionId);
}

function renderHomePage() {
  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>codexmux</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1117;
        --panel: #161b22;
        --border: #30363d;
        --text: #e6edf3;
        --muted: #8b949e;
        --accent: #58a6ff;
        --accent-2: #1f6feb;
      }
      body {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: linear-gradient(180deg, #0d1117 0%, #111827 100%);
        color: var(--text);
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1, h2 {
        margin: 0 0 12px;
      }
      p {
        margin: 0 0 16px;
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 16px;
        margin: 24px 0;
      }
      .card {
        background: rgba(22, 27, 34, 0.92);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 16px;
      }
      label {
        display: block;
        margin: 10px 0 6px;
        font-size: 12px;
        color: var(--muted);
      }
      input, textarea, select, button {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: #0d1117;
        color: var(--text);
        padding: 10px 12px;
        font: inherit;
      }
      textarea {
        min-height: 120px;
        resize: vertical;
      }
      button {
        background: var(--accent);
        color: #081018;
        border: none;
        font-weight: 600;
        cursor: pointer;
        margin-top: 12px;
      }
      .secondary {
        background: var(--accent-2);
        color: #fff;
      }
      pre {
        background: #0b0f14;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px;
        overflow: auto;
        white-space: pre-wrap;
      }
      .row {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      .status {
        margin: 12px 0 0;
        min-height: 20px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>codexmux</h1>
      <p>Heartbeats are first-class prompt objects: typed, editable, and scheduled to be fed back into an agent at a deterministic moment.</p>
      <div class="grid">
        <section class="card">
          <h2>Create Session</h2>
          <label for="session-name">Session name</label>
          <input id="session-name" value="web-session" />
          <button id="create-session">Create session</button>
          <div class="status" id="session-status"></div>
        </section>
        <section class="card">
          <h2>Create Heartbeat</h2>
          <label for="session-id">Session ID</label>
          <input id="session-id" placeholder="ses_..." />
          <label for="heartbeat-title">Title</label>
          <input id="heartbeat-title" value="daily stake check" />
          <label for="heartbeat-kind">Kind</label>
          <select id="heartbeat-kind">
            <option value="stake">stake</option>
            <option value="review">review</option>
            <option value="watch">watch</option>
            <option value="sweep">sweep</option>
          </select>
          <label for="cadence-seconds">Cadence seconds</label>
          <input id="cadence-seconds" type="number" value="60" />
          <label for="prompt">Prompt</label>
          <textarea id="prompt">Current objective: keep this thread alive and inject determinism through time.</textarea>
          <button id="create-heartbeat">Create heartbeat</button>
          <div class="status" id="create-heartbeat-status"></div>
        </section>
        <section class="card">
          <h2>Edit Heartbeat</h2>
          <label for="edit-heartbeat-id">Heartbeat ID</label>
          <input id="edit-heartbeat-id" placeholder="hb_..." />
          <label for="edit-heartbeat-title">Title</label>
          <input id="edit-heartbeat-title" placeholder="heartbeat title" />
          <label for="edit-heartbeat-kind">Kind</label>
          <select id="edit-heartbeat-kind">
            <option value="stake">stake</option>
            <option value="review">review</option>
            <option value="watch">watch</option>
            <option value="sweep">sweep</option>
          </select>
          <label for="edit-heartbeat-status">Status</label>
          <select id="edit-heartbeat-status">
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="archived">archived</option>
          </select>
          <label for="edit-cadence-seconds">Cadence seconds</label>
          <input id="edit-cadence-seconds" type="number" value="60" />
          <label for="edit-prompt">Prompt</label>
          <textarea id="edit-prompt" placeholder="updated heartbeat prompt"></textarea>
          <button id="update-heartbeat">Update heartbeat</button>
          <button id="tick-heartbeat" class="secondary">Tick heartbeat</button>
          <button id="tick-session" class="secondary">Tick session heartbeats</button>
          <div class="status" id="edit-heartbeat-status-output"></div>
        </section>
      </div>
      <section class="card">
        <div class="row">
          <h2 style="margin:0;">Current State</h2>
          <button id="refresh" class="secondary" style="max-width:180px;margin-top:0;">Refresh</button>
        </div>
        <pre id="state">Loading...</pre>
      </section>
    </div>
    <script>
      const stateEl = document.getElementById("state");
      const sessionStatus = document.getElementById("session-status");
      const createHeartbeatStatus = document.getElementById("create-heartbeat-status");
      const editHeartbeatStatus = document.getElementById("edit-heartbeat-status-output");

      async function call(method, path, body) {
        const res = await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        return await res.json();
      }

      async function refresh() {
        const [sessions, heartbeats] = await Promise.all([
          call("GET", "/api/sessions"),
          call("GET", "/api/heartbeats"),
        ]);
        stateEl.textContent = JSON.stringify({ sessions, heartbeats }, null, 2);
      }

      document.getElementById("create-session").addEventListener("click", async () => {
        const name = document.getElementById("session-name").value.trim();
        const result = await call("POST", "/api/sessions", { name });
        sessionStatus.textContent = result.ok ? "Created " + result.session.id : result.error;
        if (result.ok) {
          document.getElementById("session-id").value = result.session.id;
        }
        await refresh();
      });

      document.getElementById("create-heartbeat").addEventListener("click", async () => {
        const sessionId = document.getElementById("session-id").value.trim();
        const title = document.getElementById("heartbeat-title").value.trim();
        const kind = document.getElementById("heartbeat-kind").value;
        const cadenceSeconds = Number(document.getElementById("cadence-seconds").value || "60");
        const prompt = document.getElementById("prompt").value;
        const result = await call("POST", "/api/heartbeats", {
          sessionId,
          title,
          kind,
          cadenceSeconds,
          prompt,
        });
        createHeartbeatStatus.textContent = result.ok ? "Created " + result.heartbeat.id : result.error;
        if (result.ok) {
          document.getElementById("edit-heartbeat-id").value = result.heartbeat.id;
          document.getElementById("edit-heartbeat-title").value = result.heartbeat.title;
          document.getElementById("edit-heartbeat-kind").value = result.heartbeat.kind;
          document.getElementById("edit-heartbeat-status").value = result.heartbeat.status;
          document.getElementById("edit-cadence-seconds").value = String(result.heartbeat.cadence_seconds);
          document.getElementById("edit-prompt").value = result.heartbeat.prompt;
        }
        await refresh();
      });

      document.getElementById("update-heartbeat").addEventListener("click", async () => {
        const heartbeatId = document.getElementById("edit-heartbeat-id").value.trim();
        const result = await call("PATCH", "/api/heartbeats/" + heartbeatId, {
          title: document.getElementById("edit-heartbeat-title").value.trim(),
          kind: document.getElementById("edit-heartbeat-kind").value,
          status: document.getElementById("edit-heartbeat-status").value,
          cadenceSeconds: Number(document.getElementById("edit-cadence-seconds").value || "60"),
          prompt: document.getElementById("edit-prompt").value,
        });
        editHeartbeatStatus.textContent = result.ok ? "Updated " + result.heartbeat.id : result.error;
        await refresh();
      });

      document.getElementById("tick-heartbeat").addEventListener("click", async () => {
        const heartbeatId = document.getElementById("edit-heartbeat-id").value.trim();
        const result = await call("POST", "/api/heartbeats/" + heartbeatId + "/tick");
        editHeartbeatStatus.textContent = result.ok ? "Ticked " + result.heartbeat.id : result.error;
        await refresh();
      });

      document.getElementById("tick-session").addEventListener("click", async () => {
        const sessionId = document.getElementById("session-id").value.trim();
        const result = await call("POST", "/api/heartbeat/tick", { sessionId });
        editHeartbeatStatus.textContent = result.ok ? "Ticked session " + result.sessionId : result.error;
        await refresh();
      });

      document.getElementById("refresh").addEventListener("click", refresh);
      refresh();
    </script>
  </body>
</html>`);
}

function heartbeatIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/heartbeats\/([^/]+)(?:\/tick)?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return renderHomePage();
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        project: env.PROJECT_NAME,
        stack: {
          workers: true,
          d1: true,
          queueProvisioned: true,
          browserRunProvisioned: true,
          localBroker: false,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return json({ ok: true, sessions: await listSessions(env) });
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await parseJson<{ name?: string }>(request);
      if (!body?.name) return badRequest("name is required");
      return json({ ok: true, session: await createSession(env, body.name) });
    }

    if (request.method === "GET" && url.pathname === "/api/heartbeats") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      return json({
        ok: true,
        heartbeats: await listHeartbeats(env, sessionId),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/heartbeats/due") {
      return json({
        ok: true,
        heartbeats: await dueHeartbeats(env),
      });
    }

    if (request.method === "GET" && /^\/api\/heartbeats\/[^/]+$/.test(url.pathname)) {
      const heartbeatId = heartbeatIdFromPath(url.pathname);
      if (!heartbeatId) return notFound();

      const heartbeat = await getHeartbeat(env, heartbeatId);
      if (!heartbeat) return notFound();
      return json({ ok: true, heartbeat });
    }

    if (request.method === "POST" && url.pathname === "/api/heartbeats") {
      const body = await parseJson<{
        sessionId?: string;
        title?: string;
        kind?: HeartbeatKind;
        cadenceSeconds?: number;
        prompt?: string;
        status?: HeartbeatStatus;
      }>(request);

      if (!body?.sessionId || !body.prompt) {
        return badRequest("sessionId and prompt are required");
      }

      return json({
        ok: true,
        heartbeat: await createHeartbeat(env, {
          sessionId: body.sessionId,
          title: body.title,
          kind: body.kind,
          cadenceSeconds: body.cadenceSeconds,
          prompt: body.prompt,
          status: body.status,
        }),
      });
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/heartbeats/")) {
      const heartbeatId = heartbeatIdFromPath(url.pathname);
      if (!heartbeatId) return notFound();

      const body = await parseJson<{
        title?: string;
        kind?: HeartbeatKind;
        cadenceSeconds?: number;
        prompt?: string;
        status?: HeartbeatStatus;
      }>(request);

      const heartbeat = await updateHeartbeat(env, heartbeatId, {
        title: body?.title,
        kind: body?.kind,
        cadenceSeconds: body?.cadenceSeconds,
        prompt: body?.prompt,
        status: body?.status,
      });

      if (!heartbeat) return notFound();
      return json({ ok: true, heartbeat });
    }

    if (request.method === "POST" && /^\/api\/heartbeats\/[^/]+\/tick$/.test(url.pathname)) {
      const heartbeatId = heartbeatIdFromPath(url.pathname);
      if (!heartbeatId) return notFound();

      const heartbeat = await tickHeartbeatById(env, heartbeatId);
      if (!heartbeat) return notFound();
      return json({ ok: true, heartbeat });
    }

    if (request.method === "POST" && url.pathname === "/api/heartbeat/tick") {
      const body = await parseJson<{ sessionId?: string }>(request);
      if (!body?.sessionId) {
        return badRequest("sessionId is required");
      }

      const heartbeats = await tickHeartbeatsBySession(env, body.sessionId);
      return json({
        ok: true,
        updated: true,
        sessionId: body.sessionId,
        heartbeats,
      });
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
