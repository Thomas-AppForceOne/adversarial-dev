import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { HarnessConfig } from "./types.ts";

// Valid Claude model identifiers
export const CLAUDE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

// Valid Codex/OpenAI model identifiers
export const CODEX_MODELS = [
  "gpt-5.4",
  "gpt-4o",
  "gpt-4o-mini",
  "o4-mini",
  "o3",
  "o3-mini",
] as const;

export type CodexModel = (typeof CODEX_MODELS)[number];

// Default models (used when no --model flag and no config file entry)
export const CLAUDE_MODEL: ClaudeModel = "claude-sonnet-4-6";
export const CODEX_MODEL: CodexModel = "gpt-5.4";

export const CLAUDE_MAX_TURNS = 50;
export const CODEX_NETWORK_ACCESS = true;

/**
 * Per-tool-call wall-clock timeout in milliseconds.
 *
 * When a `tool_use` block is emitted by the claude subprocess and no matching
 * `tool_result` arrives within this window, the subprocess is killed. This
 * prevents generator/evaluator agents from deadlocking on hung subprocesses
 * (e.g. pathological Pollard's rho inputs, orphaned uvicorn servers, wedged
 * vite dev servers).
 *
 * Default: 15 minutes. Long enough that legitimate slow tools (fresh
 * `npm install`, `pytest` on large suites, cold-venv `pip install`) complete
 * comfortably, short enough to catch real hangs before they waste hours.
 *
 * Override via `ADEV_TOOL_TIMEOUT_SEC` (seconds).
 */
function parsePositiveSeconds(envValue: string | undefined, defaultSec: number): number {
  if (!envValue) return defaultSec * 1000;
  const n = Number(envValue);
  if (!Number.isFinite(n) || n <= 0) return defaultSec * 1000;
  return Math.round(n * 1000);
}
export const CLAUDE_TOOL_TIMEOUT_MS = parsePositiveSeconds(
  process.env.ADEV_TOOL_TIMEOUT_SEC,
  900,
);

export const DEFAULT_CONFIG: Omit<
  HarnessConfig,
  "userPrompt" | "workDir" | "modelHigh" | "modelLow"
> = {
  maxSprints: 10,
  maxRetriesPerSprint: 3,
  passThreshold: 7,
};

// ---- Config file loading ----
// Reads .adev/config.json from /project first (the mounted host project), then
// from cwd/.adev/config.json (harness-level fallback).
//
// Structure supports two tiers per provider:
//   { "claudeModel": "...",         // shorthand, sets both tiers to the same model
//     "claudeModelHigh": "...",     // high-effort tier (Generator)
//     "claudeModelLow": "...",      // low-effort tier (Planner, Contract, Evaluator)
//     "codexModel": "...",
//     "codexModelHigh": "...",
//     "codexModelLow": "..." }

interface AdevFileConfig {
  claudeModel?: string;
  claudeModelHigh?: string;
  claudeModelLow?: string;
  codexModel?: string;
  codexModelHigh?: string;
  codexModelLow?: string;
}

function loadFileConfig(): AdevFileConfig {
  const candidates = [
    "/project/.adev/config.json",
    join(process.cwd(), ".adev", "config.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as AdevFileConfig;
      } catch {
        // ignore parse errors, try next candidate
      }
    }
  }
  return {};
}

// ---- Validation helpers ----

function validateModel(
  model: string,
  valid: readonly string[],
  source: string,
  provider: string,
): void {
  if (!valid.includes(model)) {
    console.error(`Error: unknown ${provider} model "${model}" (from ${source})`);
    console.error(`Valid models: ${valid.join(", ")}`);
    process.exit(1);
  }
}

// ---- Model resolvers ----
// Two-tier resolution. Priority (highest first):
//   1. Tier-specific CLI flag (--model-high / --model-low)
//   2. Shared CLI flag (--model)
//   3. Tier-specific config key (claudeModelHigh / claudeModelLow)
//   4. Shared config key (claudeModel)
//   5. Built-in default

export interface ModelTiers {
  /** Generator uses this. Heavy code reasoning. */
  high: string;
  /** Planner, contract negotiation, evaluator use this. */
  low: string;
}

export function resolveClaudeModels(
  cliShared?: string,
  cliHigh?: string,
  cliLow?: string,
): ModelTiers {
  const valid = CLAUDE_MODELS as readonly string[];
  const file = loadFileConfig();

  const high =
    cliHigh ??
    cliShared ??
    file.claudeModelHigh ??
    file.claudeModel ??
    CLAUDE_MODEL;
  const low =
    cliLow ??
    cliShared ??
    file.claudeModelLow ??
    file.claudeModel ??
    CLAUDE_MODEL;

  validateModel(high, valid, "high-effort tier", "Claude");
  validateModel(low, valid, "low-effort tier", "Claude");

  return { high, low };
}

export function resolveCodexModels(
  cliShared?: string,
  cliHigh?: string,
  cliLow?: string,
): ModelTiers {
  const valid = CODEX_MODELS as readonly string[];
  const file = loadFileConfig();

  const high =
    cliHigh ??
    cliShared ??
    file.codexModelHigh ??
    file.codexModel ??
    CODEX_MODEL;
  const low =
    cliLow ??
    cliShared ??
    file.codexModelLow ??
    file.codexModel ??
    CODEX_MODEL;

  validateModel(high, valid, "high-effort tier", "Codex");
  validateModel(low, valid, "low-effort tier", "Codex");

  return { high, low };
}
