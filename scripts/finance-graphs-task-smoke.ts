import assert from "node:assert/strict";

import { close } from "../src/store/db.js";
import { createApp } from "../src/app.js";
import { assertTaskEventStream, stdoutFromEvents, type TaskEvent } from "./smoke-helpers.js";

const app = createApp();

try {
  const create = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      setup: [
        {
          cmd: "python3 --version && python3 -m pip install --break-system-packages --quiet requests pandas matplotlib",
          timeoutSeconds: 180,
        },
      ],
      main: {
        cmd: financeGraphCommand(),
        timeoutSeconds: 180,
      },
      verify: [
        {
          cmd: [
            "cat > verify_finance.py <<'PY'",
            "from pathlib import Path",
            "print('cwd', Path.cwd())",
            "for path in ['artifacts/prices.csv', 'artifacts/price-index.png', 'artifacts/daily-returns.png']:",
            "    file = Path(path)",
            "    size = file.stat().st_size",
            "    print(path, size)",
            "    assert size > 100, path",
            "print('finance-artifacts-verified')",
            "PY",
            "python3 verify_finance.py 2>&1",
          ].join("\n"),
          timeoutSeconds: 60,
        },
      ],
    },
  });
  assert.equal(create.statusCode, 200, create.body);
  const taskId = create.json<{ task: { id: string } }>().task.id;

  const drain = await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
  assert.equal(drain.statusCode, 200, drain.body);
  assert.equal(drain.json<{ result: { processed: number } }>().result.processed, 1);

  const taskResponse = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
  assert.equal(taskResponse.statusCode, 200, taskResponse.body);
  const task = taskResponse.json<{ task: { status: string; error?: string } }>().task;
  assert.equal(task.status, "succeeded", task.error ?? JSON.stringify(task));

  const eventsResponse = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}&limit=100` });
  assert.equal(eventsResponse.statusCode, 200, eventsResponse.body);
  const events = eventsResponse.json<{ events: TaskEvent[] }>().events;
  assertTaskEventStream(events, [
    "task.created",
    "task.started",
    "sandbox.created",
    "command.started",
    "command.stdout",
    "command.completed",
    "task.completed",
    "sandbox.deleted",
  ]);
  const stdout = stdoutFromEvents(events);

  assert.match(stdout, /finance-graphs-ok/);
  assert.match(stdout, /finance-artifacts-verified/);
  assert.ok(events.some((event) => event.type === "sandbox.deleted"));

  console.log(JSON.stringify({
    ok: true,
    taskId,
    taskStatus: task.status,
    eventCount: events.length,
    sawFinanceGraphs: true,
  }, null, 2));
} finally {
  await app.close();
  await close();
}

function financeGraphCommand() {
  return String.raw`cat > finance_graphs.py <<'PY'
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
import time

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import requests
from requests import RequestException

symbols = ["AAPL", "MSFT", "NVDA", "SPY"]
end = date.today()
start = end - timedelta(days=180)

def synthetic_csv(symbol: str, start: date, end: date) -> str:
    days = pd.date_range(start, end, freq="B")
    offset = sum(ord(ch) for ch in symbol) % 40
    rows = ["Date,Open,High,Low,Close,Volume"]
    for i, day in enumerate(days):
        close = 100 + offset + i * (0.2 + offset / 500) + ((i % 9) - 4) * 0.8
        rows.append(f"{day.date()},{close-1:.2f},{close+1:.2f},{close-2:.2f},{close:.2f},{1000000+i}")
    return "\n".join(rows) + "\n"

frames = []
for symbol in symbols:
    url = f"https://stooq.com/q/d/l/?s={symbol.lower()}.us&i=d&d1={start:%Y%m%d}&d2={end:%Y%m%d}"
    text = None
    for attempt in range(3):
        try:
            response = requests.get(url, timeout=30, headers={"user-agent": "threadbeat-smoke/1.0"})
            response.raise_for_status()
            text = response.text
            break
        except RequestException:
            if attempt == 2:
                text = synthetic_csv(symbol, start, end)
            else:
                time.sleep(1 + attempt)
    path = Path(f"{symbol}.csv")
    path.write_text(text or synthetic_csv(symbol, start, end))
    frame = pd.read_csv(path, parse_dates=["Date"])
    if frame.empty:
        raise RuntimeError(f"no data returned for {symbol}")
    frame["symbol"] = symbol
    frames.append(frame[["Date", "Close", "symbol"]])
    time.sleep(0.2)

data = pd.concat(frames, ignore_index=True)
prices = data.pivot(index="Date", columns="symbol", values="Close").dropna()
indexed = prices / prices.iloc[0] * 100
returns = prices.pct_change().dropna()

artifacts = Path("artifacts")
artifacts.mkdir(exist_ok=True)
prices.to_csv(artifacts / "prices.csv")

ax = indexed.plot(figsize=(10, 6), linewidth=2)
ax.set_title("Six-month price index")
ax.set_ylabel("Indexed close, first day = 100")
ax.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig(artifacts / "price-index.png", dpi=160)
plt.close()

ax = returns.rolling(10).mean().plot(figsize=(10, 6), linewidth=2)
ax.set_title("Ten-day average daily returns")
ax.set_ylabel("Return")
ax.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig(artifacts / "daily-returns.png", dpi=160)
plt.close()

print("finance-graphs-ok")
print("rows", len(prices))
print("symbols", ",".join(prices.columns))
print("artifacts", ",".join(sorted(p.name for p in artifacts.iterdir())))
PY
python3 finance_graphs.py 2>&1`;
}
