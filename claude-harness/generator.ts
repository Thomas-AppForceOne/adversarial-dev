import { GENERATOR_SYSTEM_PROMPT, GENERATOR_EXISTING_SYSTEM_PROMPT } from "../shared/prompts.ts";
import { CLAUDE_MAX_TURNS } from "../shared/config.ts";
import { log } from "../shared/logger.ts";
import { runClaude } from "../shared/claude-cli.ts";
import { recordClaudeResult } from "../shared/usage.ts";
import type { SprintContract, EvalResult } from "../shared/types.ts";

export async function runGenerator(
  workDir: string,
  appDir: string,
  spec: string,
  contract: SprintContract,
  model: string,
  previousFeedback?: EvalResult,
): Promise<{ response: string; sessionId?: string }> {
  const sprint = contract.sprintNumber;
  const attempt = previousFeedback ? "retry" : "initial";
  const isExisting = appDir !== `${workDir}/app` && appDir !== workDir + "/app";
  log("GENERATOR", `Sprint ${sprint} (${attempt}) - Building: ${contract.features.join(", ")}`);

  let prompt = isExisting
    ? `IMPORTANT: You are working on an existing codebase at ${appDir}. Read and understand the existing code before making changes. Your harness state directory is ${workDir} (where spec.md and contracts live).\n\n## Product Spec\n\n${spec}\n\n## Sprint Contract\n\n${JSON.stringify(contract, null, 2)}`
    : `IMPORTANT: Your working directory is ${workDir}. All code MUST be created inside ${appDir}/. Do NOT create files outside of ${workDir}.\n\n## Product Spec\n\n${spec}\n\n## Sprint Contract\n\n${JSON.stringify(contract, null, 2)}`;

  if (previousFeedback) {
    prompt += `\n\n## Evaluation Feedback (MUST ADDRESS)\n\n${JSON.stringify(previousFeedback, null, 2)}`;
    prompt += `\n\nThe previous attempt failed evaluation. Address every issue in the feedback above.`;
  } else if (isExisting) {
    prompt += `\n\nExplore the existing codebase at ${appDir} first, then implement the features listed in this sprint contract.`;
  } else {
    prompt += `\n\nImplement the features listed in this sprint contract. Work in the \`app/\` directory.`;
  }

  let fullResponse = "";
  let sessionId: string | undefined;

  for await (const msg of runClaude({
    prompt,
    cwd: isExisting ? appDir : workDir,
    systemPrompt: isExisting ? GENERATOR_EXISTING_SYSTEM_PROMPT : GENERATOR_SYSTEM_PROMPT,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model,
    maxTurns: CLAUDE_MAX_TURNS,
    role: `GENERATOR/sprint ${sprint}${previousFeedback ? " retry" : ""}`,
    timingsDir: workDir,
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        } else if (block.type === "tool_use") {
          log("GENERATOR", `  Tool: ${block.name}`);
        }
      }
    } else if (msg.type === "result") {
      recordClaudeResult(
        `GENERATOR/sprint ${sprint} ${previousFeedback ? `retry ${attempt}` : "initial"}`,
        msg,
      );
      sessionId = msg.session_id;
      log("GENERATOR", `Sprint ${sprint} build complete (session: ${sessionId?.slice(0, 8)}...)`);
    }
  }

  if (!fullResponse) {
    log("GENERATOR", `Sprint ${sprint} completed (agent used tools only, no text output)`);
  }

  return { response: fullResponse, sessionId };
}
