# Competitive Landscape & Positioning

Complements [`kuflow-comparison.md`](kuflow-comparison.md) (the method-by-method
KuFlow SDK comparison) with a market map and an honest read of where Flowstile
fits among the alternatives.

## Where Flowstile sits

Flowstile is the **human-in-the-loop layer for Temporal, authored as code by the
developer's own coding agent** — not a visual/no-code BPM suite, and not an
AI-agent runtime. The defensible combination is: code-first, *autonomous*
agent authoring to a tested green state, Temporal-native durability, self-hosted,
no engine lock-in — aimed at **developers**.

## The competitor map

- **Most direct — KuFlow.** A Temporal-based human-task SDK with nearly identical
  positioning (SDKs that wrap Temporal and add human-task features). The head-to-
  head rival; see `kuflow-comparison.md`.
- **The real default — "DIY on Temporal."** Most teams build the inbox / forms /
  RBAC / visibility themselves on Temporal (which ships its own human-in-the-loop
  cookbook). This — not a vendor — is what Flowstile has to out-value: *"don't
  rebuild the human layer yourself."*
- **Incumbent category — Camunda 8** (plus legacy Flowable / Bonita / jBPM, and
  Orkes Conductor). BPMN modeling, a drag-and-drop form builder, Tasklist. The
  philosophical split: *Camunda = the visual business-process planner; Temporal /
  Flowstile = the code-first distributed-systems engineer.*
- **Adjacent, different buyer:** durable-execution engines (Restate, Inngest,
  Hatchet, Trigger.dev, Windmill) compete with *Temporal*, not the human layer;
  internal-tool builders (Retool, Appsmith, Superblocks) nail the human UI but
  lack durable orchestration; no-code automation (Zapier, n8n, Make, Workato) is a
  different segment (non-developers, SaaS connectors).

## Camunda's AI — two axes (the frontier)

Camunda's "AI" is two distinct products; only one overlaps Flowstile.

1. **Runtime agentic orchestration — AI agents as process participants.** In 8.8:
   an *AI Agent Connector* (process↔LLM, tool-calling from the BPMN toolbox), a
   revitalized *ad-hoc subprocess* (scopes the toolbox + tool-call semantics), and
   a *Vector DB connector* (agent memory / RAG). The LLM decides which tools to
   call; Camunda executes the BPMN activities, stores state, coordinates user
   tasks. This is Camunda's biggest investment ("the agents are there; what's
   missing is orchestration"). **Flowstile does not play here** — an AI agent is
   just a Temporal activity.
2. **BPMN Copilot — AI authors the process.** Generates a working process — steps,
   decisions, connectors, **and forms** — from a natural-language description, then
   refines iteratively in the Web Modeler (FEEL logic in 8.8; code→BPMN too).
   **This overlaps Flowstile's agent-authoring directly.**

## Where Flowstile fits — and what it isn't

- **Agent-authoring isn't unique; the *how* is.** Camunda ships a credible BPMN
  Copilot, so "an AI builds the process" is no longer a standalone claim. The
  distinction is the *how*: code-first output (version control, tests, full
  Temporal power), an **autonomous** agent that authors and drives a process to a
  tested **e2e-green** state (not a GUI copilot draft), running on **your** Temporal
  (no per-instance pricing or engine lock-in), inside the **developer's** own
  toolchain.

- **Runtime agentic orchestration is out of scope.** AI agents as first-class
  process *participants* — Camunda's biggest investment — is a different product
  axis. Flowstile keeps agent and automated work as ordinary Temporal activities
  (surfaced, if needed, via the proposed case-event log in `design-decisions.md`).

- **The defensible position:** the human-in-the-loop layer for **developers** on
  Temporal, where the developer's own coding agent authors and tests the process
  **as code** — versus Camunda's business-analyst, visual, managed-engine approach.
  Different audience, artifact, and pricing, on durable Temporal with no lock-in.

## Sources

- KuFlow on Temporal — https://kuflow.com/blog/en/kuflow-as-temporal-interface/
- Temporal human-in-the-loop cookbook — https://docs.temporal.io/ai-cookbook/human-in-the-loop-python
- Camunda human workflow — https://camunda.com/solutions/human-workflow/
- Camunda agentic orchestration (8.8) — https://docs.camunda.io/docs/components/agentic-orchestration/ai-agents/
- Camunda "hype to impact" (agentic) — https://camunda.com/blog/2025/10/hype-to-impact-lessons-learned-making-agentic-orchestration-work/
- Camunda BPMN Copilot — https://docs.camunda.io/docs/components/early-access/alpha/bpmn-copilot/
- Camunda NL process features (CIO) — https://www.cio.com/article/2110581/camunda-simplifies-process-automation-with-new-ai-powered-natural-language-features.html
- Temporal vs Conductor vs Camunda — https://medium.com/@easwaranvijayakumar/workflow-orchestration-showdown-temporal-io-vs-orkes-conductor-vs-camunda-e59fd79c2b65
