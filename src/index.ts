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

type HeartbeatStatus = "active" | "inactive";

type HeartbeatRow = {
  id: string;
  session_id: string;
  title: string;
  cadence: number;
  contents: string;
  last_tick: string | null;
  next_tick: string | null;
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

function computeNextTickAt(cadence: number, status: HeartbeatStatus): string | null {
  if (status !== "active") return null;
  return new Date(Date.now() + cadence * 1000).toISOString();
}

function normalizeCadence(value: number | undefined): number | null {
  if (value === undefined) return 60;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function normalizeContentsPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!trimmed.endsWith(".md")) return null;
  return trimmed.replace(/^\.\/+/, "");
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
         cadence,
         contents,
         last_tick,
         next_tick,
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
         cadence,
         contents,
         last_tick,
         next_tick,
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
       cadence,
       contents,
       last_tick,
       next_tick,
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
    cadence?: number;
    contents: string;
    status?: HeartbeatStatus;
  },
) {
  const cadence = normalizeCadence(input.cadence);
  if (cadence === null) return { error: "cadence must be a positive number" } as const;

  const contents = normalizeContentsPath(input.contents);
  if (!contents) {
    return { error: "contents must be a markdown file path ending in .md" } as const;
  }

  const id = randomId("hb");
  const status = input.status ?? "active";
  const nextTick = computeNextTickAt(cadence, status);

  await env.CONTROL_DB.prepare(
    `INSERT INTO heartbeats (
      id,
      session_id,
      title,
      cadence,
      contents,
      last_tick,
      next_tick,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.sessionId,
      input.title?.trim() || "heartbeat",
      cadence,
      contents,
      null,
      nextTick,
      status,
    )
    .run();

  return { heartbeat: await getHeartbeat(env, id) } as const;
}

async function updateHeartbeat(
  env: Env,
  heartbeatId: string,
  input: {
    title?: string;
    cadence?: number;
    contents?: string;
    status?: HeartbeatStatus;
  },
) {
  const current = await getHeartbeat(env, heartbeatId);
  if (!current) return null;

  const cadence =
    input.cadence === undefined ? current.cadence : normalizeCadence(input.cadence);
  if (cadence === null) return { error: "cadence must be a positive number" } as const;

  const contents =
    input.contents === undefined
      ? current.contents
      : normalizeContentsPath(input.contents);
  if (!contents) {
    return { error: "contents must be a markdown file path ending in .md" } as const;
  }

  const title = input.title?.trim() || current.title;
  const status = input.status ?? current.status;
  const nextTick = computeNextTickAt(cadence, status);

  await env.CONTROL_DB.prepare(
    `UPDATE heartbeats
     SET
       title = ?,
       cadence = ?,
       contents = ?,
       next_tick = ?,
       status = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(title, cadence, contents, nextTick, status, heartbeatId)
    .run();

  return { heartbeat: await getHeartbeat(env, heartbeatId) } as const;
}

async function tickHeartbeatById(env: Env, heartbeatId: string) {
  const current = await getHeartbeat(env, heartbeatId);
  if (!current) return null;

  const currentTime = nowIso();
  const nextTick = computeNextTickAt(current.cadence, current.status);

  await env.CONTROL_DB.prepare(
    `UPDATE heartbeats
     SET
       last_tick = ?,
       next_tick = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'active'`,
  )
    .bind(currentTime, nextTick, heartbeatId)
    .run();

  return await getHeartbeat(env, heartbeatId);
}

async function tickHeartbeatsBySession(env: Env, sessionId: string) {
  const currentTime = nowIso();
  const sessionHeartbeats = await listHeartbeats(env, sessionId);

  for (const heartbeat of sessionHeartbeats) {
    if (heartbeat.status !== "active") continue;
    await env.CONTROL_DB.prepare(
      `UPDATE heartbeats
       SET
         last_tick = ?,
         next_tick = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(
        currentTime,
        computeNextTickAt(heartbeat.cadence, heartbeat.status),
        heartbeat.id,
      )
      .run();
  }

  return await listHeartbeats(env, sessionId);
}

async function dueHeartbeats(env: Env) {
  const result = await env.CONTROL_DB.prepare(
    `SELECT
       id,
       session_id,
       title,
       cadence,
       contents,
       last_tick,
       next_tick,
       status,
       created_at,
       updated_at
     FROM heartbeats
     WHERE status = 'active'
       AND next_tick IS NOT NULL
       AND next_tick <= ?
     ORDER BY next_tick ASC`,
  )
    .bind(nowIso())
    .all<HeartbeatRow>();

  return result.results;
}

function renderHomePage() {
  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>threadbeat</title>
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
      input, select, button {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: #0d1117;
        color: var(--text);
        padding: 10px 12px;
        font: inherit;
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
      .note {
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>threadbeat</h1>
      <p>Heartbeats are minimal deterministic objects: title, cadence, contents path, status, last tick, next tick.</p>
      <p class="note">For this toy version, <code>contents</code> is a repo-relative markdown file path. The worker stores and schedules that pointer; a later executor or local broker will resolve and read the file body.</p>
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
          <label for="cadence">Cadence (seconds)</label>
          <input id="cadence" type="number" value="60" />
          <label for="contents">Contents (.md path)</label>
          <input id="contents" value="contents/default.md" />
          <label for="status">Status</label>
          <select id="status">
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
          <button id="create-heartbeat">Create heartbeat</button>
          <div class="status" id="create-heartbeat-status"></div>
        </section>
        <section class="card">
          <h2>Edit Heartbeat</h2>
          <label for="edit-heartbeat-id">Heartbeat ID</label>
          <input id="edit-heartbeat-id" placeholder="hb_..." />
          <label for="edit-heartbeat-title">Title</label>
          <input id="edit-heartbeat-title" placeholder="heartbeat title" />
          <label for="edit-cadence">Cadence (seconds)</label>
          <input id="edit-cadence" type="number" value="60" />
          <label for="edit-contents">Contents (.md path)</label>
          <input id="edit-contents" placeholder="contents/default.md" />
          <label for="edit-status">Status</label>
          <select id="edit-status">
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
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
        const [sessions, heartbeats, due] = await Promise.all([
          call("GET", "/api/sessions"),
          call("GET", "/api/heartbeats"),
          call("GET", "/api/heartbeats/due"),
        ]);
        stateEl.textContent = JSON.stringify({ sessions, heartbeats, due }, null, 2);
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
        const cadence = Number(document.getElementById("cadence").value || "60");
        const contents = document.getElementById("contents").value.trim();
        const status = document.getElementById("status").value;
        const result = await call("POST", "/api/heartbeats", {
          sessionId,
          title,
          cadence,
          contents,
          status,
        });
        createHeartbeatStatus.textContent = result.ok ? "Created " + result.heartbeat.id : result.error;
        if (result.ok) {
          document.getElementById("edit-heartbeat-id").value = result.heartbeat.id;
          document.getElementById("edit-heartbeat-title").value = result.heartbeat.title;
          document.getElementById("edit-cadence").value = String(result.heartbeat.cadence);
          document.getElementById("edit-contents").value = result.heartbeat.contents;
          document.getElementById("edit-status").value = result.heartbeat.status;
        }
        await refresh();
      });

      document.getElementById("update-heartbeat").addEventListener("click", async () => {
        const heartbeatId = document.getElementById("edit-heartbeat-id").value.trim();
        const result = await call("PATCH", "/api/heartbeats/" + heartbeatId, {
          title: document.getElementById("edit-heartbeat-title").value.trim(),
          cadence: Number(document.getElementById("edit-cadence").value || "60"),
          contents: document.getElementById("edit-contents").value.trim(),
          status: document.getElementById("edit-status").value,
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
        heartbeatShape: {
          title: "string",
          cadence: "seconds",
          contents: "repo-relative markdown path",
          status: ["active", "inactive"],
          last_tick: "timestamp | null",
          next_tick: "timestamp | null",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return json({ ok: true, sessions: await listSessions(env) });
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await parseJson<{ name?: string }>(request);
      if (!body?.name?.trim()) return badRequest("name is required");
      return json({ ok: true, session: await createSession(env, body.name.trim()) });
    }

    if (request.method === "GET" && url.pathname === "/api/heartbeats") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      return json({ ok: true, heartbeats: await listHeartbeats(env, sessionId) });
    }

    if (request.method === "GET" && url.pathname === "/api/heartbeats/due") {
      return json({ ok: true, heartbeats: await dueHeartbeats(env) });
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
        cadence?: number;
        contents?: string;
        status?: HeartbeatStatus;
      }>(request);

      if (!body?.sessionId) return badRequest("sessionId is required");
      if (!body.contents) return badRequest("contents is required");

      const created = await createHeartbeat(env, {
        sessionId: body.sessionId,
        title: body.title,
        cadence: body.cadence,
        contents: body.contents,
        status: body.status,
      });

      if ("error" in created) return badRequest(created.error ?? "invalid heartbeat");
      return json({ ok: true, heartbeat: created.heartbeat });
    }

    if (request.method === "PATCH" && /^\/api\/heartbeats\/[^/]+$/.test(url.pathname)) {
      const heartbeatId = heartbeatIdFromPath(url.pathname);
      if (!heartbeatId) return notFound();

      const body = await parseJson<{
        title?: string;
        cadence?: number;
        contents?: string;
        status?: HeartbeatStatus;
      }>(request);

      const updated = await updateHeartbeat(env, heartbeatId, {
        title: body?.title,
        cadence: body?.cadence,
        contents: body?.contents,
        status: body?.status,
      });

      if (!updated) return notFound();
      if ("error" in updated) return badRequest(updated.error ?? "invalid heartbeat");
      return json({ ok: true, heartbeat: updated.heartbeat });
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
      if (!body?.sessionId) return badRequest("sessionId is required");

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
