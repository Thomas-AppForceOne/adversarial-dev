import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

type AgentRole = "HARNESS" | "PLANNER" | "GENERATOR" | "EVALUATOR" | "CLAUDE-CLI";

const COLORS: Record<AgentRole, string> = {
  HARNESS: "\x1b[36m",     // cyan
  PLANNER: "\x1b[35m",     // magenta
  GENERATOR: "\x1b[32m",   // green
  EVALUATOR: "\x1b[33m",   // yellow
  "CLAUDE-CLI": "\x1b[90m", // grey (infra layer, not an agent)
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function formatMessage(role: AgentRole, message: string): string {
  return `${DIM}${timestamp()}${RESET} ${COLORS[role]}[${role}]${RESET} ${message}`;
}

export function log(role: AgentRole, message: string): void {
  console.log(formatMessage(role, message));
}

export function logError(role: AgentRole, message: string): void {
  console.error(formatMessage(role, `\x1b[31m${message}${RESET}`));
}

export function logDivider(): void {
  console.log(`\n${DIM}${"─".repeat(60)}${RESET}\n`);
}

/**
 * Thrown by `runClaude` when a `tool_use` block has no matching `tool_result`
 * within `CLAUDE_TOOL_TIMEOUT_MS`. The claude subprocess is SIGKILL'd before
 * this error is thrown, so the caller can safely catch + report + proceed
 * (typically by failing the sprint and letting the retry loop re-attempt).
 */
export class ToolTimeoutError extends Error {
  constructor(
    public readonly tool: string,
    public readonly toolUseId: string,
    public readonly elapsedMs: number,
    public readonly timeoutMs: number,
  ) {
    super(
      `Tool '${tool}' (id ${toolUseId}) exceeded ${timeoutMs}ms wall-clock ` +
      `timeout (ran for ${elapsedMs}ms) — subprocess killed.`,
    );
    this.name = "ToolTimeoutError";
  }
}

/**
 * Append one JSONL record per completed tool call to
 * `<workDir>/tool-timings.jsonl`. Intended for offline analysis of tool-call
 * wall-clock distributions so the default timeout can be calibrated from data.
 *
 * Best-effort: failures to write are swallowed to keep the hot path fast.
 */
export function logToolTiming(
  workDir: string,
  entry: {
    role: string;
    sessionId?: string;
    tool: string;
    durationMs: number;
    timedOut?: boolean;
  },
): void {
  try {
    const path = join(workDir, "tool-timings.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + "\n";
    appendFileSync(path, line, { encoding: "utf-8", mode: 0o644 });
  } catch {
    /* ignore — this is observability, not correctness */
  }
}
