/**
 * Token + cost accounting for claude -p subprocess runs.
 *
 * Every claude -p invocation emits a `result` message at the end of the
 * stream that contains a `usage` block and a `total_cost_usd` value. The
 * harness records one entry per such message via `recordClaudeResult()`,
 * keyed by a human-readable role label. At the end of the run the harness
 * calls `formatUsageReport()` to print a grouped summary.
 */

import type { ClaudeMessage } from "./claude-cli.ts";

export interface UsageEntry {
  role: string;             // e.g. "PLANNER", "GENERATOR/sprint 1 attempt 1"
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

const entries: UsageEntry[] = [];

/**
 * Record usage from a `result` message yielded by `runClaude(...)`.
 * Silently ignores messages that aren't result-typed or lack a usage block.
 */
export function recordClaudeResult(role: string, msg: ClaudeMessage): void {
  if (msg.type !== "result") return;

  const m = msg as unknown as {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    total_cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
  };

  const usage = m.usage ?? {};
  entries.push({
    role,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    costUsd: m.total_cost_usd ?? 0,
    durationMs: m.duration_ms ?? 0,
    numTurns: m.num_turns ?? 0,
  });
}

/** Remove all recorded entries. Useful for tests. */
export function resetUsage(): void {
  entries.length = 0;
}

/** Snapshot of all recorded entries, in call order. */
export function getUsageEntries(): readonly UsageEntry[] {
  return entries.slice();
}

/**
 * Roll entries up by a grouping key extracted from `role`. By default
 * groups by the first "/" segment (so "GENERATOR/sprint 1 attempt 1"
 * rolls up to "GENERATOR").
 */
function groupBy(entries: readonly UsageEntry[], keyOf: (e: UsageEntry) => string) {
  const groups = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    const k = keyOf(e);
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  }
  return groups;
}

function sumGroup(list: UsageEntry[]): Omit<UsageEntry, "role"> {
  return list.reduce(
    (acc, e) => ({
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + e.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + e.cacheReadTokens,
      costUsd: acc.costUsd + e.costUsd,
      durationMs: acc.durationMs + e.durationMs,
      numTurns: acc.numTurns + e.numTurns,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
    },
  );
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * Render a formatted multi-line usage report suitable for printing at
 * the end of a harness run. Groups by top-level role, shows per-call
 * detail, and adds a grand total row.
 */
export function formatUsageReport(): string {
  if (entries.length === 0) {
    return "No token usage recorded.";
  }

  const lines: string[] = [];
  lines.push("Token usage & cost:");
  lines.push("");

  const grouped = groupBy(entries, (e) => e.role.split("/")[0] ?? e.role);
  const groupOrder = ["PLANNER", "CONTRACT", "GENERATOR", "EVALUATOR"];
  const sortedKeys = [...grouped.keys()].sort((a, b) => {
    const ia = groupOrder.indexOf(a);
    const ib = groupOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  // Header.
  const header =
    "  " +
    "role".padEnd(38) +
    "input".padStart(10) +
    "output".padStart(10) +
    "cache_r".padStart(11) +
    "cache_w".padStart(11) +
    "cost".padStart(10) +
    "turns".padStart(7);
  lines.push(header);
  lines.push("  " + "-".repeat(header.length - 2));

  const grand = sumGroup(entries);

  for (const key of sortedKeys) {
    const list = grouped.get(key)!;
    const sum = sumGroup(list);
    lines.push(formatRow(key, sum, list.length));

    // Per-call detail for groups with more than one call.
    if (list.length > 1) {
      for (const e of list) {
        const detailLabel = "    " + (e.role.split("/")[1] ?? e.role);
        lines.push(formatRow(detailLabel, e, 1, true));
      }
    }
  }

  lines.push("  " + "-".repeat(header.length - 2));
  lines.push(formatRow("TOTAL", grand, entries.length));

  lines.push("");
  lines.push(
    `  ${entries.length} claude calls, ` +
      `${fmtNum(grand.inputTokens + grand.outputTokens)} billable tokens, ` +
      `${fmtNum(grand.cacheReadTokens)} cache reads, ` +
      `${fmtCost(grand.costUsd)} total`,
  );

  return lines.join("\n");
}

function formatRow(
  label: string,
  sum: Omit<UsageEntry, "role">,
  _callCount: number,
  dim = false,
): string {
  const dimOn = dim ? "\x1b[2m" : "";
  const dimOff = dim ? "\x1b[0m" : "";
  return (
    "  " +
    dimOn +
    label.padEnd(38) +
    fmtNum(sum.inputTokens).padStart(10) +
    fmtNum(sum.outputTokens).padStart(10) +
    fmtNum(sum.cacheReadTokens).padStart(11) +
    fmtNum(sum.cacheCreationTokens).padStart(11) +
    fmtCost(sum.costUsd).padStart(10) +
    String(sum.numTurns).padStart(7) +
    dimOff
  );
}
