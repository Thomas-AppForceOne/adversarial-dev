# Adversarial Dev

A GAN-inspired three-agent harness that separates **planning**, **building**, and **evaluation** into distinct AI agents with distinct contexts. The evaluator's job is to **break** what the generator builds -- creating adversarial tension that drives quality far beyond what a single agent can achieve. Built with both the **Claude Agent SDK** and **Codex SDK** so you can run the same architecture on either platform.

Based on Anthropic's engineering article: [Harness Design for Long-Running Application Development](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## What This Demonstrates

Most AI coding agents fail on complex tasks not because the model is bad, but because nobody separated the work into specialized roles. A single agent that plans, builds, and evaluates its own work will reliably praise its own mediocre output. This is called **self-evaluation bias**, and it's the quiet killer of ambitious AI coding projects.

This project implements the fix: three agents, each with a focused job and its own context window.

| Agent | Role | Analogy |
|-------|------|---------|
| **Planner** | Expands a short prompt into a full product spec with sprints | Product manager |
| **Generator** | Builds one feature at a time, commits to git | Software engineer |
| **Evaluator** | Actively tries to break what the generator built, scores ruthlessly | Adversarial QA |

The evaluator doesn't just review code -- it's an adversary. It runs the application, probes for failures, tests edge cases the generator didn't think of, and scores each criterion on a 1-10 scale with a hard pass threshold. If any criterion fails, the sprint goes back to the generator with detailed, unforgiving feedback. The generator has to fight its way past the evaluator to advance. This adversarial pressure is what turns AI-generated code from "looks right" into "actually works."

## Installation

### 1. Prerequisites

- [Bun](https://bun.sh) runtime
- [Docker](https://www.docker.com) (Desktop or Engine) — must be running when you use `adev`
- Claude CLI installed and authenticated:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude auth login
  ```
- Codex CLI installed and authenticated (only needed for the Codex harness):
  ```bash
  npm install -g @openai/codex
  codex auth login
  ```

### 2. Clone and install

```bash
git clone https://github.com/Thomas-AppForceOne/adversarial-dev.git
cd adversarial-dev
bun install
```

### 3. Put `adev` on your PATH

```bash
# Create ~/.local/bin if it doesn't exist
mkdir -p ~/.local/bin

# Symlink — always points at the current repo, no copy needed
ln -s "$(pwd)/adev" ~/.local/bin/adev
```

If `~/.local/bin` is not already on your PATH, add it to your shell config:

```bash
# bash (~/.bashrc or ~/.bash_profile)
export PATH="$HOME/.local/bin:$PATH"

# zsh (~/.zshrc)
export PATH="$HOME/.local/bin:$PATH"
```

Then reload your shell (`source ~/.zshrc` or open a new terminal).

### 4. Build the Docker image

The first `adev` run builds the image automatically, but you can do it upfront:

```bash
docker build -t adversarial-dev .
```

### 5. Verify the install

```bash
adev --models
```

You should see the list of available Claude and Codex models. If this works, you're ready.

## Running the harness

There are two ways to run: the `adev` CLI wrapper (recommended, runs inside Docker) or directly with `bun run` (no Docker, harness repo must be local).

### `adev` CLI (Docker, recommended)

Run from inside any project directory. The project is mounted read-write; the harness repo is baked into the image.

```bash
# From inside your project directory:
adev "Add dark mode and CSV export"
adev --file prompt.md
adev --spec ./SPEC.md
adev --specs ./specs/
adev --target ~/projects/myapp "Refactor auth to use JWT"
adev --resume                        # continue an interrupted run
```

Use `ADEV_HARNESS=codex` to switch to the Codex SDK:

```bash
ADEV_HARNESS=codex adev "Build a REST API"
```

Auth is auto-detected: if `ANTHROPIC_API_KEY` is set it uses the API key, otherwise it reads OAuth credentials from the macOS Keychain (requires a prior `claude` login on the host).

### `bun run` (direct, no Docker)

```bash
bun run claude-harness/index.ts "Build a personal task manager"
bun run claude-harness/index.ts --file prompt.md

bun run codex-harness/index.ts "Build a personal task manager"
```

Both harnesses write output to `workspace/claude/` and `workspace/codex/` respectively. The built application lives in `workspace/{harness}/app/`.

## Authentication

The `adev` CLI supports two auth modes, selected automatically from your environment.

### API key (recommended for long or concurrent runs)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
adev "Build a task manager"
```

API keys are not one-time-use and are safe to share between multiple concurrent processes.

### Subscription (OAuth, via the Claude Keychain entry)

If `ANTHROPIC_API_KEY` is unset, `adev` extracts OAuth credentials from the `Claude Code-credentials` Keychain entry (on macOS) or `~/.claude/.credentials.json` (on Linux). You must have logged in once via `claude` on the host for this to work.

When Claude Code inside the container refreshes its OAuth access token, the mounted credentials file is updated; `adev` syncs those rotated tokens back to the Keychain when the container exits cleanly.

### The OAuth concurrency trap

OAuth refresh tokens are **one-time-use**. When anyone — host Claude Code session, IDE extension, or adev container — refreshes its token, the previous refresh token is consumed server-side. Any other client holding a stale copy of the consumed token gets `401 Unauthorized` on its next refresh.

Known failure modes:

1. **Host `claude` session running concurrently with `adev`.** Either side's refresh consumes the shared token; the other side fails on its next refresh. Symptom: 401 mid-run in either the host IDE or the adev container.
2. **Two `adev` invocations running concurrently.** The second container's `extract_subscription_creds` runs before the first syncs back, so the second container starts with creds that may be invalidated while it runs.
3. **A long adev run (hours) while you resume host Claude Code work.** Same as #1.

Mitigations, ordered by robustness:

| Mitigation | How | Trade-off |
|---|---|---|
| Use `ANTHROPIC_API_KEY` | `export ANTHROPIC_API_KEY=sk-ant-...` before `adev` | Bills per-request; no subscription involvement |
| Close host Claude Code sessions | IDE extension, VS Code, terminal `claude` | Disruptive, but reliable |
| Run `adev` runs sequentially | One at a time | Can't parallelize work |
| Re-authenticate on 401 | Run `claude` on the host once to complete a fresh OAuth flow | Doesn't prevent the problem — just recovers |

If you're doing long or high-stakes adev runs (anything over an hour, or anything you don't want interrupted by a token refresh race), **use `ANTHROPIC_API_KEY`**.

## Model selection

The harness uses **two model tiers** so you can pay for reasoning power only where it matters:

| Tier | Agents | Why |
|------|--------|-----|
| **high** | Generator | Heavy code reasoning, tool use, multi-step implementation. Quality here avoids retry cost. |
| **low** | Planner, contract negotiation, Evaluator | Structured thinking, test-running, judgment. Strong mid-tier models are plenty. |

Setting `low` to a cheaper model (e.g. Sonnet) while keeping `high` on your strongest (e.g. Opus) can cut costs ~30% on typical runs without compromising output quality. The generator stays strong, the evaluator still catches bugs, and the planner/contract work is simple enough that the smaller model handles it fine.

### List available models

```bash
adev --models

# Or directly:
bun run claude-harness/index.ts --models
bun run codex-harness/index.ts --models
```

### Override model for a single run

Use the same model for both tiers:

```bash
adev --model claude-opus-4-6 "Build a REST API"
```

Or split tiers explicitly:

```bash
adev --model-high claude-opus-4-6 --model-low claude-sonnet-4-6 "Build a REST API"
ADEV_HARNESS=codex adev --model-high gpt-4o --model-low gpt-4o-mini "Build a REST API"
```

All model names are validated against the list of known models for the active harness. An invalid name exits immediately with the valid options listed.

### Set a default model per project

Run once from inside your project directory:

```bash
# Shorthand — both tiers set to the same model:
adev --set-model claude-opus-4-6

# Split tiers (recommended for cost efficiency):
adev --set-model-high claude-opus-4-6
adev --set-model-low  claude-sonnet-4-6
```

This writes `.adev/config.json` in the current directory:

```json
{
  "claudeModelHigh": "claude-opus-4-6",
  "claudeModelLow": "claude-sonnet-4-6"
}
```

Priority order (highest wins):

1. Tier-specific CLI flag (`--model-high` / `--model-low`)
2. Shared CLI flag (`--model`)
3. Tier-specific config key (`claudeModelHigh` / `claudeModelLow`)
4. Shared config key (`claudeModel`)
5. Built-in default

Add `.adev/` to your project's `.gitignore` if you don't want to commit model preferences, or commit it to share a default across a team.

### Valid models

| Harness | Models | Default (both tiers) |
|---------|--------|----------------------|
| Claude | `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229` | `claude-sonnet-4-6` |
| Codex | `gpt-5.4`, `gpt-4o`, `gpt-4o-mini`, `o4-mini`, `o3`, `o3-mini` | `gpt-5.4` |

## Configuration

Harness behaviour defaults are in `shared/config.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxSprints` | 10 | Maximum number of sprints |
| `maxRetriesPerSprint` | 3 | Max evaluation retries before failing a sprint |
| `passThreshold` | 7 | Minimum score (out of 10) for each criterion |

## How It Works

When you run a harness, here's what happens step by step:

### 1. Planning Phase
The planner takes your short prompt and generates a comprehensive product specification with features organized into sprints, a design language, and tech stack decisions. This spec is written to `spec.md`.

### 2. Contract Negotiation (per sprint)
The generator proposes what it will build and how success should be measured. The evaluator reviews the criteria, making them more specific, adding edge cases, and raising the bar. They iterate until locked in. The contract is saved as JSON.

### 3. Build Phase (per sprint)
The generator reads the spec and contract, then implements features one at a time with git commits after each. It has full access to create files, run commands, install dependencies, and test code.

### 4. Evaluation Phase (per sprint)
The evaluator reads the contract criteria, examines the code, **runs the application**, and tries to break it. It scores each criterion on a 1-10 scale. If all criteria pass (score >= 7/10), the sprint survives. If any fail, detailed feedback goes back to the generator -- with file paths, line numbers, and exact failure descriptions.

### 5. Retry Loop
The generator reads the adversarial feedback, decides whether to refine or pivot, and rebuilds. This cycles up to 3 times per sprint. If a sprint can't survive the evaluator after all retries, the harness stops.

### 6. Completion
Once all sprints pass, you have a working application built incrementally with quality gates at every step -- every feature tested by an agent whose job was to break it.

## The Architecture

```
User Prompt (1-4 sentences)
         |
         v
   +-----------+
   |  PLANNER  |  --> writes spec.md (features, sprints, design language)
   +-----------+
         |
         v  (for each sprint)
   +---------------------+
   | CONTRACT NEGOTIATION |  Generator proposes criteria,
   | Generator <-> Eval   |  Evaluator tightens the screws,
   +---------------------+  both lock in "done"
         |
         v
   +-----------+     fail + feedback     +------------+
   | GENERATOR | <---------------------- | EVALUATOR  |
   | (build)   | ----------------------> | (attack)   |
   +-----------+     implementation      +------------+
         |                                      |
         v              pass                    |
    Next Sprint <-------------------------------+
```

### Sprint Contracts

Before any code is written, the generator and evaluator negotiate a **sprint contract**: a JSON document defining exactly what "done" means. Each criterion is specific and testable -- not "works well" but "PUT /frames/reorder returns 200 and reorders frames in the database."

The evaluator uses contract negotiation to set traps -- adding edge cases, tightening thresholds, and demanding specifics that force the generator to build robust code from the start. This is directly from Anthropic's approach. They found that JSON contracts work better than markdown because models are less likely to tamper with structured JSON.

### File-Based Communication

Agents communicate through files, not shared conversation history. This keeps each agent's context focused on its role:
- `spec.md` -- Product specification from the planner
- `contracts/sprint-{n}.json` -- Sprint contracts
- `feedback/sprint-{n}-round-{m}.json` -- Evaluator feedback per attempt
- `progress.json` -- Harness state tracking

## The GAN Connection

This architecture is inspired by **Generative Adversarial Networks** (GANs), where a generator creates outputs and a discriminator tries to reject them, iterating until quality emerges from the tension between the two.

| GANs | This Harness |
|------|-------------|
| Generator vs. discriminator | **Generator vs. evaluator** |
| Gradient descent | **Hard pass/fail thresholds** |
| Two networks | **Three agents** (adds planner) |
| Continuous training | **Sprint-based iteration** |
| Zero-sum game | **Asymmetric adversarial** -- evaluator tries to break, generator tries to survive |

The core insight is the same: **separate generation from evaluation, then pit them against each other**. A generator that evaluates its own work converges on mediocrity. A separate evaluator with the explicit mandate to find failures creates the adversarial pressure that forces quality upward. The generator doesn't just build -- it builds knowing an adversary is waiting.

## Why This Is the Future of AI Coding

We're at an inflection point. In 2025, the focus was on making individual agents smarter. In 2026, the focus has shifted to **harness design** -- the scaffolding around agents that makes them reliable.

Here's the key principle from Anthropic's article:

> "Every component in a harness encodes an assumption about what the model can't do on its own."

As models improve, harnesses simplify. When Opus 4.5 shipped, Anthropic removed context resets from their harness because the model could maintain coherence natively. When Opus 4.6 shipped with 1M tokens, they removed sprint decomposition entirely because the model could sustain coherent work across two-hour builds.

But the frontier doesn't shrink -- it moves. Better models make previous scaffolding unnecessary while opening new possibilities for harnesses that achieve more complex tasks. The **pattern** of separating planning, building, and evaluation is durable even as the implementation details evolve.

Two principles that matter most:
1. **Separate evaluation from generation.** Don't let the agent grade its own homework.
2. **Define "done" before you start.** Sprint contracts are how you turn vibing into engineering.

## Project Structure

```
adversarial-dev/
├── adev                 # CLI wrapper — runs the harness inside Docker
├── shared/              # Shared types, config, prompts, utilities
│   ├── types.ts         # TypeScript interfaces
│   ├── config.ts        # Model lists, defaults, and resolver functions
│   ├── prompts.ts       # Agent system prompts (identical for both SDKs)
│   ├── logger.ts        # Colored console output
│   └── files.ts         # File I/O for specs, contracts, feedback
├── claude-harness/      # Claude Agent SDK implementation
│   ├── index.ts         # CLI entry point
│   ├── harness.ts       # Orchestration loop
│   ├── planner.ts       # Planner agent
│   ├── generator.ts     # Generator agent
│   └── evaluator.ts     # Evaluator agent
├── codex-harness/       # Codex SDK implementation
│   ├── index.ts         # CLI entry point
│   ├── harness.ts       # Orchestration loop
│   ├── planner.ts       # Planner agent
│   ├── generator.ts     # Generator agent
│   └── evaluator.ts     # Evaluator agent
└── workspace/           # Runtime output (gitignored)
    ├── claude/          # Claude harness working directory
    └── codex/           # Codex harness working directory
```

Per-project configuration lives in the **project directory** (not the harness repo):

```
your-project/
└── .adev/
    └── config.json      # Default model (written by `adev --set-model`)
```

Both harnesses share the same prompts, types, and orchestration flow. The only differences are the SDK-specific agent implementations -- `query()` async generators for Claude, `Codex` threads for Codex.
