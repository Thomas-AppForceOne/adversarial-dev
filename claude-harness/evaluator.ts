import { EVALUATOR_SYSTEM_PROMPT } from "../shared/prompts.ts";
import { CLAUDE_MAX_TURNS } from "../shared/config.ts";
import { log, logError } from "../shared/logger.ts";
import { runClaude } from "../shared/claude-cli.ts";
import { recordClaudeResult } from "../shared/usage.ts";
import type { SprintContract, EvalResult } from "../shared/types.ts";

export async function runEvaluator(
  workDir: string,
  appDir: string,
  contract: SprintContract,
  passThreshold: number,
  model: string,
): Promise<EvalResult> {
  const sprint = contract.sprintNumber;
  log("EVALUATOR", `Evaluating sprint ${sprint} against ${contract.criteria.length} criteria`);

  const prompt = `IMPORTANT: The application code is at ${appDir}. Your harness state directory is ${workDir}.

## Sprint Contract to Evaluate Against

${JSON.stringify(contract, null, 2)}

## Pass Threshold

Each criterion must score at least ${passThreshold}/10 to pass.

## Instructions

Examine the application at ${appDir}. Read the code, run it if possible, and score each criterion. Output ONLY the JSON evaluation object.`;

  let fullResponse = "";

  for await (const msg of runClaude({
    prompt,
    cwd: appDir,
    systemPrompt: EVALUATOR_SYSTEM_PROMPT,
    tools: ["Read", "Bash", "Glob", "Grep"],
    model,
    maxTurns: CLAUDE_MAX_TURNS,
    role: `EVALUATOR/sprint ${sprint}`,
    timingsDir: workDir,
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        } else if (block.type === "tool_use") {
          log("EVALUATOR", `  Tool: ${block.name}`);
        }
      }
    } else if (msg.type === "result") {
      recordClaudeResult(`EVALUATOR/sprint ${sprint}`, msg);
      log("EVALUATOR", `Evaluation complete for sprint ${sprint}`);
    }
  }

  const evalResult = parseEvalResult(fullResponse, contract, passThreshold);

  const passedCount = evalResult.feedback.filter((f) => f.score >= passThreshold).length;
  const totalCount = evalResult.feedback.length;
  const verdict = evalResult.passed ? "PASSED" : "FAILED";
  log("EVALUATOR", `Sprint ${sprint}: ${verdict} (${passedCount}/${totalCount} criteria passed)`);

  for (const item of evalResult.feedback) {
    const status = item.score >= passThreshold ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    log("EVALUATOR", `  [${status}] ${item.criterion}: ${item.score}/10 - ${item.details.slice(0, 100)}`);
  }

  return evalResult;
}

function parseEvalResult(
  response: string,
  contract: SprintContract,
  passThreshold: number,
): EvalResult {
  // Try multiple strategies to extract JSON from the response
  const candidates: string[] = [];

  // Strategy 1: Look for the LAST JSON code block (most likely the final answer)
  const codeBlocks = [...response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of codeBlocks.reverse()) {
    if (match[1]) candidates.push(match[1].trim());
  }

  // Strategy 2: Find the largest {...} block in the raw response
  const braceMatch = response.match(/\{[\s\S]*"passed"[\s\S]*"feedback"[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);

  // Strategy 3: Raw response as-is
  candidates.push(response.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as EvalResult;
      if (parsed.feedback && Array.isArray(parsed.feedback)) {
        // Recalculate passed based on threshold
        parsed.passed = parsed.feedback.every((f) => f.score >= passThreshold);
        return parsed;
      }
    } catch {
      // Try next candidate
    }
  }

  logError("EVALUATOR", "Failed to parse evaluation JSON from any extraction strategy");
  return {
    passed: false,
    scores: {},
    feedback: contract.criteria.map((c) => ({
      criterion: c.name,
      score: 0,
      details: "Evaluator failed to produce parseable output",
    })),
    overallSummary: "Evaluation parsing failed. Raw response: " + response.slice(0, 500),
  };
}
