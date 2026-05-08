# Future Agent OS Notes

These notes capture a separate future direction for Threadbeat. They are not
part of the immediate v0.4/v0.5 implementation gates. Treat them as a research
and product thesis to prioritize separately.

## Core Thesis

Long-running agents become useful when they are managed like versioned,
stateful services rather than chat sessions.

The deeper primitive is:

```text
durable agent state
+ event wakeups
+ sandboxed execution
+ versioned history
+ skill promotion
```

An agent does not need to be a process running forever. It can be a persistent
identity with durable state, a repo or volume, a task queue, memory/checkpoint
files, skills/tools, wakeup policy, and a history of actions and commits.
Compute can spin up and down around that durable identity.

## Chaotic Manager as Proposer

One idea is to use a high-variance, intentionally strange model as a proposer,
not an executor.

The model should generate weird interventions, reminders, task decompositions,
escalation ideas, and "what if we try X?" moves. It should not directly execute
high-blast-radius actions.

The shape:

```text
heartbeat / scheduler
  -> chaotic proposer model
  -> proposal queue
  -> risk + reversibility scorer
  -> narrow skill agents
  -> action ledger
  -> outcome feedback
```

The chaotic model's job is to disturb the system:

- Ping this person.
- Split this task.
- Ask for missing evidence.
- Reassign stale work.
- Try a weird source.
- Kill a dead branch.
- Force a synthesis checkpoint.
- Escalate because no progress happened in several runs.

Execution belongs to narrow agents with typed tools, durable action logs, and
risk gates.

A useful scoring shape:

```text
score =
  novelty
  + expected_value
  + urgency
  - cost
  - irreversibility
  - user_risk
  - external_blast_radius
```

The research framing is not "train a dumb crazy model." It is:

> Train a proposal model whose objective is high-variance, non-redundant,
> useful idea generation, while a separate verifier/action layer handles
> correctness and safety.

## Personalized Quality-Diversity

The stronger research idea is to train a population of personalized proposal
modules on real non-AI human traces, sample many diverse candidates, then use a
separate value model to identify which ideas have actual marginal usefulness.

The shape:

```text
personal non-AI corpus
  -> cluster into modes / domains / styles
  -> train or condition K specialized modules
  -> each module generates M variants
  -> pool K*M candidates
  -> dedupe / cluster / score
  -> value model selects high-upside, non-obvious, personally relevant ideas
```

The modules should preserve different personal generative modes:

- How the user brainstorms.
- How the user writes when serious.
- How the user makes investing theses.
- How the user notices social/work obligations.
- How the user identifies neglected tasks.
- How the user phrases uncomfortable but useful thoughts.
- How the user connects old projects.
- How the user decides something is actually worth doing.

A possible generated-value scoring function:

```text
generated_value =
  personal_fit
  + novelty_vs_user_history
  + novelty_vs_other_samples
  + actionability
  + downstream_expected_value
  + specificity
  + timing_relevance
  - genericness
  - incoherence
  - risk
  - redundancy
```

The key set-level question:

> Given 100 candidate thoughts, which 5 expand the user's option space?

This differs from normal RLHF because normal RLHF often collapses toward the
answer that seems broadly acceptable. This would reward candidates that are
unusually useful inside a personal context.

Possible research framing:

- Personalized Quality-Diversity for Agentic Ideation.
- Training Models to Generate Non-Obvious Useful Ideas from Personal Data.
- Diversity-Preserving Proposal Models for Long-Horizon Agent Control.

## Temporal Retrieval and Citation Weighting

Long-running agents need temporal epistemology. They need to know not only
"what do I know?" but:

- When did I know it?
- How stale is it?
- What proved it useful?
- Which skill should trust it now?

Retrieval should not only select the nearest chunk. It should retrieve the best
currently valid evidence for the question.

Every memory or evidence unit should carry time and outcome metadata:

```json
{
  "content_id": "...",
  "source": "...",
  "text": "...",
  "created_at": "...",
  "event_time": "...",
  "observed_at": "...",
  "last_verified_at": "...",
  "valid_until": "...",
  "source_type": "official_doc | local_db | prior_memory | web | user_pref",
  "task_tags": ["cued", "api_docs", "personal_preference"],
  "outcomes": {
    "used": 12,
    "accepted": 8,
    "corrected": 2,
    "superseded": 1
  }
}
```

Ranking should combine:

```text
final_score =
  semantic_similarity
  * task_fit
  * source_authority
  * freshness
  * last_verified_boost
  * user_preference_boost
  * historical_success_rate
  * contradiction_penalty
```

Different evidence types need different half-lives. CEOs, package docs, API
models, weather, and pricing decay fast. Math, source-code facts, stable user
preferences, and old project history decay slowly. Skills should declare their
own freshness policies.

## Persistent Alpha Generation

The deeply human alpha-generation task is not just "agent does research." It is:

> Persistent alpha generation through open-ended intake, synthesis, and
> self-directed update loops.

A human can follow a rabbit hole for hours, but gets tired, loses threads,
forgets weak signals, and cannot fan out across many adjacent trails. A
persistent agent can do the boring impossible part: keep crawling, keep a live
map, preserve weak signals, and repeatedly ask whether the lead is still
interesting.

The system shape:

```text
seed thesis / person / market / question
  -> scout agents crawl one source at a time
  -> extractor pulls people, claims, institutions, links, dates
  -> synthesizer updates the live thesis map
  -> novelty/value scorer ranks leads
  -> coordinator provisions next work
  -> status agent emits updates only when state meaningfully changes
```

The important object is not the final report. It is the living state:

- Current thesis.
- Key claims.
- Important people.
- New leads.
- Contradictions.
- Open questions.
- Source graph.
- Confidence changes.
- Why this matters now.
- Next rabbit holes.

## Provisioning Own Updates

Status updates should be state-change events, not time-based summaries.

A dumb system reports every 30 minutes. A better system decides whether a user
should be interrupted based on meaningful state changes:

- High-value person found.
- Thesis changed materially.
- Contradiction discovered.
- Lead graph expanded beyond a threshold.
- Source quality improved.
- Agent is stuck for several cycles.
- User taste judgment is required.

Example policy:

```json
{
  "notify_if": {
    "new_person_score_above": 0.82,
    "thesis_delta_above": 0.35,
    "contradiction_severity_above": "medium",
    "new_source_cluster_size_above": 5,
    "stuck_cycles": 4
  },
  "otherwise": "continue_silently"
}
```

## Orchestrator and Persistent Agents

The orchestrator agent's job is not to research deeply. Its job is to maintain
the world model:

- What agents exist?
- What are they responsible for?
- What are they currently doing?
- What state do they own?
- What repo/version are they on?
- What inputs have arrived?
- What needs to wake up?
- What should be killed?
- What deserves user attention?

Architecture:

```text
User / poke / events
  -> Orchestrator agent
      -> reads global state
      -> decides what should run
      -> starts/stops task agents
      -> routes updates
      -> manages sandboxes/repos
      -> writes action ledger
      -> commits state changes
  -> Persistent agents
      -> own long-lived domains
      -> maintain their own repos/volumes
      -> request subagents/tools
      -> emit status events
  -> Ephemeral task agents
      -> do bounded work
      -> write artifacts
      -> terminate
```

Taxonomy:

- Permanent agents: long-lived domain owners such as sports investing
  researcher, Cued relationship follow-up agent, personal writing memory agent,
  or biosecurity literature scout.
- Persistent tasks: objectives like monitor this company weekly, crawl this
  rabbit hole for six hours, or keep enriching this dataset.
- Ephemeral sandboxes: spun up for a specific run, clone a repo/version, do
  work, commit outputs, then shut down.
- Inputs and interrupts: user pokes, cron, webhooks, email/message/calendar
  listeners, file changes, external source changes, and agent-to-agent
  requests.

## Versioned Sandboxes

Every sandbox should be versioned. Without git history, the system loses the
causal history of what the agent actually did.

A sandbox should contain:

```text
repo/
  state.md
  task.md
  findings/
  data/
  logs/
  skills/
  artifacts/
  .agent/
    manifest.json
    run_log.jsonl
    decisions.jsonl
```

Every meaningful transition gets committed:

```text
2026-05-08 10:14 scout: added 12 source leads
2026-05-08 10:47 synth: revised thesis after source cluster
2026-05-08 11:22 people-ranker: promoted 4 people to watchlist
2026-05-08 12:05 orchestrator: paused crawl, spawned verifier
```

This makes the system reverse-readable:

- Why did this agent believe X?
- What sources caused the thesis to change?
- What was tried and abandoned?
- Which subagent produced this artifact?
- When did the task become stale?

## Minimal API Primitive

The control-plane API can stay small:

```text
createAgent(...)
pokeAgent(agentId, message | event)
spawnTask(agentId, taskSpec)
pauseTask(taskId)
resumeTask(taskId)
getState(agentId)
listRuns(agentId)
checkoutSandbox(runId | commit)
promoteSkill(fromRunId, skillSpec)
subscribe(agentId, eventType)
```

The strongest loop:

```text
agent does work
  -> commits state
  -> orchestrator reads diff
  -> decides if update is meaningful
  -> maybe pokes user
  -> maybe spawns next task
  -> maybe promotes repeated behavior into a skill
```

Repeated successful sandbox behavior should be promotable into a callable skill.

## Near-Term Implication for Threadbeat

Do not jump straight to full agent spin-up/spin-down infrastructure before
sandbox isolation is real.

The next durable direction should separate:

- Agent identity from compute process.
- Scheduler events from task execution.
- Shared Pi session from sandboxed task workers.
- Operator notifications from raw time-based heartbeat summaries.
- Agent state from unversioned process memory.

The near-term implementation path should keep v0.4 focused on the hosted
singular agent, then use v0.5/v0.6 to introduce task rows, durable runtime
abstractions, and sandbox-backed execution.
