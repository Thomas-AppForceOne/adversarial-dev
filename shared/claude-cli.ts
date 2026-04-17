/**
 * Thin wrapper around the `claude -p` subprocess.
 *
 * We use this instead of @anthropic-ai/claude-agent-sdk so that the real
 * `claude` binary handles authentication itself. That means Anthropic sees
 * legitimate Claude Code traffic (no OAuth impersonation, no ToS grey area),
 * and token refresh is handled by Claude Code for free.
 *
 * The shape of messages yielded here mirrors the Claude Code stream-json
 * format so call sites can iterate over assistant/tool-use/result blocks
 * the same way they did with the SDK.
 *
 * Quota-aware retry:
 *   If `claude -p` emits a result with an error subtype that looks like a
 *   rate/quota issue, `runClaude` waits for the reset window and retries
 *   the entire subprocess transparently. Callers only see messages from
 *   the successful (or final) attempt.
 */

import { log, logError, logToolTiming, ToolTimeoutError } from "./logger.ts";
import { CLAUDE_TOOL_TIMEOUT_MS } from "./config.ts";

export { ToolTimeoutError };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

export type ClaudeMessage =
  | { type: "system"; subtype: string; session_id?: string; [k: string]: unknown }
  | {
      type: "assistant";
      message: { id?: string; role: "assistant"; content: ContentBlock[] };
      session_id?: string;
    }
  | { type: "user"; message: { role: "user"; content: ContentBlock[] }; session_id?: string }
  | {
      type: "result";
      subtype: string;
      session_id?: string;
      total_cost_usd?: number;
      is_error?: boolean;
      [k: string]: unknown;
    };

export interface RunClaudeOptions {
  /** The user prompt. Sent via stdin so newlines/special chars don't need escaping. */
  prompt: string;
  /** Working directory for the claude process. */
  cwd: string;
  /** System prompt that REPLACES Claude Code's default persona. */
  systemPrompt: string;
  /**
   * Restrict the agent to this list of built-in tools. Pass ["*"] or omit
   * for all tools. Empty string in --tools means "no tools".
   */
  tools?: string[];
  /** Model slug, e.g. "claude-sonnet-4-6". */
  model: string;
  /** Max agent turns before claude stops the loop. */
  maxTurns?: number;
  /**
   * Per-tool-call wall-clock timeout in milliseconds. Defaults to
   * `CLAUDE_TOOL_TIMEOUT_MS` (15 min unless `ADEV_TOOL_TIMEOUT_SEC` is set).
   * When a tool_use has no matching tool_result within this window, the
   * subprocess is SIGKILL'd and a `ToolTimeoutError` is thrown.
   */
  toolCallTimeoutMs?: number;
  /**
   * Role label for tool-timing log lines (e.g. "PLANNER", "GENERATOR/sprint
   * 1"). Used only for observability; safe to omit.
   */
  role?: string;
  /**
   * Directory where `tool-timings.jsonl` is appended. Usually
   * `config.workDir`. If unset, per-tool timings are still measured and
   * logged to stdout but not persisted.
   */
  timingsDir?: string;
}

// ---- Quota / rate-limit detection & retry ----

/** Max times we'll retry on quota exhaustion before giving up. */
const QUOTA_MAX_RETRIES = Number(process.env.ADEV_QUOTA_MAX_RETRIES ?? 3);

/**
 * Fallback wait when we detect a quota issue but can't determine the
 * exact reset time from rate_limit_info.resets_at (default: 5 minutes).
 * Set to 0 to disable quota retry entirely.
 */
const QUOTA_FALLBACK_WAIT_MS = Number(process.env.ADEV_QUOTA_WAIT_MS ?? 5 * 60 * 1000);

/** Small buffer added to the computed wait so we don't hit the edge. */
const QUOTA_BUFFER_MS = 5_000;

/**
 * Extract rate-limit info from a result message.
 *
 * Claude Code stream-json result messages include:
 *   rate_limit_info: {
 *     status: string,           // e.g. "rate_limited", "allowed", ...
 *     resets_at: number,        // Unix epoch SECONDS when tokens replenish
 *   }
 *
 * Returns { isLimited, resetsAtMs } or null if no rate_limit_info is present.
 */
function extractRateLimitInfo(msg: ClaudeMessage): {
  isLimited: boolean;
  resetsAtMs: number | null;
} | null {
  if (msg.type !== "result") return null;

  const info = (msg as any).rate_limit_info;
  if (!info) return null;

  // "allowed" means we're within limits. Anything else = limited.
  const isLimited = info.status !== "allowed";
  const resetsAtMs =
    typeof info.resets_at === "number" ? info.resets_at * 1000 : null;

  return { isLimited, resetsAtMs };
}

/**
 * Heuristic: does this result message look like a rate-limit or quota error
 * (vs. a logic error, max-turns, budget limit, etc.)?
 *
 * Uses rate_limit_info if present (most reliable). Falls back to keyword
 * scanning for older claude versions that might not include it.
 *
 * Subtypes observed in the claude binary:
 *   success, error, error_during_execution, error_max_turns,
 *   error_max_budget_usd, error_max_structured_output_retries
 */
function looksLikeQuotaError(msg: ClaudeMessage): boolean {
  if (msg.type !== "result") return false;

  // Definitive: rate_limit_info says we're limited.
  const rli = extractRateLimitInfo(msg);
  if (rli?.isLimited) return true;

  // success or agent-limit subtypes — never quota related.
  if (
    msg.subtype === "success" ||
    msg.subtype === "error_max_turns" ||
    msg.subtype === "error_max_budget_usd" ||
    msg.subtype === "error_max_structured_output_retries"
  ) {
    return false;
  }

  // Fallback: keyword scan for older claude versions.
  const haystack = JSON.stringify(msg).toLowerCase();
  return (
    haystack.includes("rate limit") ||
    haystack.includes("rate_limit") ||
    haystack.includes("ratelimit") ||
    haystack.includes("quota") ||
    haystack.includes("overloaded") ||
    haystack.includes("429") ||
    haystack.includes("too many requests") ||
    haystack.includes("usage limit") ||
    haystack.includes("capacity")
  );
}

/**
 * Compute how long to wait before retrying, using the reset time from
 * rate_limit_info.resets_at if available, otherwise the fallback value.
 */
function computeQuotaWaitMs(resultMsg: ClaudeMessage): number {
  const rli = extractRateLimitInfo(resultMsg);
  if (rli?.resetsAtMs) {
    const waitMs = rli.resetsAtMs - Date.now() + QUOTA_BUFFER_MS;
    if (waitMs > 0) return waitMs;
  }
  return QUOTA_FALLBACK_WAIT_MS;
}

// ---- Core subprocess runner ----

/**
 * Run a single `claude -p` subprocess to completion.
 * Returns all collected messages + the exit code.
 */
async function execClaude(
  opts: RunClaudeOptions,
): Promise<{ messages: ClaudeMessage[]; sawResult: boolean; exitCode: number; stderr: string }> {
  const args: string[] = [
    "--print",
    "--verbose", // required by claude when --output-format=stream-json with --print
    "--output-format", "stream-json",
    "--input-format", "text",
    "--system-prompt", opts.systemPrompt,
    "--dangerously-skip-permissions",
    "--model", opts.model,
  ];

  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", opts.tools.join(","));
  }
  if (typeof opts.maxTurns === "number") {
    args.push("--max-turns", String(opts.maxTurns));
  }

  log("CLAUDE-CLI", `spawning claude -p in cwd=${opts.cwd} with tools=${opts.tools?.join(",") ?? "all"}`);

  const proc = Bun.spawn(["claude", ...args], {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  try {
    (proc.stdin as any).write(opts.prompt);
    await (proc.stdin as any).end();
  } catch (e) {
    throw new Error(`Failed to pipe prompt to claude stdin: ${e}`);
  }

  const messages: ClaudeMessage[] = [];
  let sawResult = false;
  const decoder = new TextDecoder();
  let buffer = "";

  // ---- Per-tool-call timeout state ----
  // Each entry tracks one in-flight tool_use. When the matching tool_result
  // arrives we clear the timer and emit a timing record. If the timer fires
  // first, we SIGKILL the subprocess so `proc.exited` resolves and the stream
  // loop exits; the outer try/finally then sees `timedOutTool` and throws.
  const timeoutMs = opts.toolCallTimeoutMs ?? CLAUDE_TOOL_TIMEOUT_MS;
  type PendingTool = {
    name: string;
    startedAtMs: number;
    timer: ReturnType<typeof setTimeout>;
  };
  const openTools = new Map<string, PendingTool>();
  // Wrap the "timed out" signal in a box so TS doesn't narrow a bare `let`
  // variable to `null` (it can't see across the setTimeout callback).
  const timeoutRef: {
    value: { name: string; toolUseId: string; elapsedMs: number } | null;
  } = { value: null };
  let latestSessionId: string | undefined;

  const fireTimeout = (toolUseId: string, name: string, startedAtMs: number) => {
    const elapsedMs = Date.now() - startedAtMs;
    timeoutRef.value = { name, toolUseId, elapsedMs };
    logError(
      "CLAUDE-CLI",
      `tool '${name}' (id ${toolUseId.slice(0, 12)}) exceeded ${timeoutMs}ms — killing subprocess`,
    );
    if (opts.timingsDir) {
      logToolTiming(opts.timingsDir, {
        role: opts.role ?? "unknown",
        sessionId: latestSessionId,
        tool: name,
        durationMs: elapsedMs,
        timedOut: true,
      });
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      /* process may already be dead */
    }
  };

  const handleToolUse = (block: Extract<ContentBlock, { type: "tool_use" }>) => {
    // Defensive: if we somehow see a duplicate tool_use id, reset the timer.
    const existing = openTools.get(block.id);
    if (existing) clearTimeout(existing.timer);
    const startedAtMs = Date.now();
    const timer = setTimeout(() => fireTimeout(block.id, block.name, startedAtMs), timeoutMs);
    openTools.set(block.id, { name: block.name, startedAtMs, timer });
  };

  const handleToolResult = (block: Extract<ContentBlock, { type: "tool_result" }>) => {
    const pending = openTools.get(block.tool_use_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    openTools.delete(block.tool_use_id);
    const durationMs = Date.now() - pending.startedAtMs;
    if (opts.timingsDir) {
      logToolTiming(opts.timingsDir, {
        role: opts.role ?? "unknown",
        sessionId: latestSessionId,
        tool: pending.name,
        durationMs,
      });
    }
  };

  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as ClaudeMessage;
          if (parsed.type === "result") sawResult = true;
          if (parsed.type === "system" && parsed.subtype === "init") {
            latestSessionId = (parsed as any).session_id;
            log(
              "CLAUDE-CLI",
              `claude session init: cwd=${(parsed as any).cwd ?? "?"} session=${latestSessionId?.slice(0, 8) ?? "?"}`,
            );
          }
          // Track tool_use → tool_result for timeouts + per-tool timings.
          if (parsed.type === "assistant") {
            for (const block of parsed.message.content) {
              if (block.type === "tool_use") handleToolUse(block);
            }
          } else if (parsed.type === "user") {
            for (const block of parsed.message.content) {
              if (block.type === "tool_result") handleToolResult(block);
            }
          }
          messages.push(parsed);
        } catch (e) {
          logError("CLAUDE-CLI", `failed to parse stream-json line: ${line.slice(0, 200)}`);
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        const parsed = JSON.parse(tail) as ClaudeMessage;
        if (parsed.type === "result") sawResult = true;
        messages.push(parsed);
      } catch {
        /* ignore trailing noise */
      }
    }
  } finally {
    // Cancel every pending timer; otherwise they'd fire after we return and
    // try to kill a subprocess that may have already been reused (or, worse,
    // nothing, keeping the event loop alive).
    for (const p of openTools.values()) clearTimeout(p.timer);
    openTools.clear();
  }

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (timeoutRef.value) {
    throw new ToolTimeoutError(
      timeoutRef.value.name,
      timeoutRef.value.toolUseId,
      timeoutRef.value.elapsedMs,
      timeoutMs,
    );
  }

  return { messages, sawResult, exitCode, stderr };
}

// ---- Public API ----

/**
 * Spawn `claude -p`, yield parsed stream-json messages, and handle
 * quota/rate-limit failures with automatic wait + retry.
 *
 * On a temporary rate limit, Claude Code handles the retry internally
 * (429 → backoff). On hard quota exhaustion (plan cap), Claude Code
 * gives up and we detect it here, wait ADEV_QUOTA_WAIT_MS, and retry
 * the entire subprocess.
 *
 * Callers see only messages from the successful (or final) attempt.
 */
export async function* runClaude(opts: RunClaudeOptions): AsyncGenerator<ClaudeMessage> {
  let attempt = 0;

  while (true) {
    const { messages, sawResult, exitCode, stderr } = await execClaude(opts);
    attempt++;

    // Check for quota/rate-limit errors that warrant a retry.
    const resultMsg = messages.find((m) => m.type === "result");
    const isQuotaError = resultMsg && looksLikeQuotaError(resultMsg);

    if (isQuotaError && attempt <= QUOTA_MAX_RETRIES) {
      const waitMs = computeQuotaWaitMs(resultMsg!);
      if (waitMs <= 0) break; // ADEV_QUOTA_WAIT_MS=0 disables retry

      const rli = extractRateLimitInfo(resultMsg!);
      const resetTime = rli?.resetsAtMs
        ? new Date(rli.resetsAtMs).toLocaleTimeString()
        : null;
      const waitMin = (waitMs / 60_000).toFixed(1);

      log(
        "CLAUDE-CLI",
        resetTime
          ? `Quota exhausted — tokens replenish at ${resetTime} (attempt ${attempt}/${QUOTA_MAX_RETRIES}). Waiting ${waitMin} min...`
          : `Quota/rate-limit detected (attempt ${attempt}/${QUOTA_MAX_RETRIES}). Waiting ${waitMin} min...`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue; // discard this attempt's messages, retry fresh
    }

    // Not a quota error, or we've exhausted retries — yield messages.
    for (const msg of messages) {
      yield msg;
    }

    // Handle exit code.
    if (exitCode !== 0) {
      const detail = stderr.trim() || `(no stderr, exit ${exitCode})`;
      if (sawResult) {
        log(
          "CLAUDE-CLI",
          `claude exited ${exitCode} after delivering result — continuing (${detail.slice(0, 200)})`,
        );
      } else {
        logError("CLAUDE-CLI", `claude exited ${exitCode}: ${detail.slice(0, 500)}`);
        throw new Error(`claude -p failed with exit ${exitCode}: ${detail.slice(0, 500)}`);
      }
    }

    break; // done — yielded messages from this attempt
  }
}
