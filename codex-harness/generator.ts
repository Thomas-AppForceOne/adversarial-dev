import { Codex } from "@openai/codex-sdk";
import { GENERATOR_SYSTEM_PROMPT, GENERATOR_EXISTING_SYSTEM_PROMPT } from "../shared/prompts.ts";
import { CODEX_MODEL, CODEX_NETWORK_ACCESS } from "../shared/config.ts";
import { log, logError } from "../shared/logger.ts";
import type { SprintContract, EvalResult } from "../shared/types.ts";

export async function runGenerator(
  workDir: string,
  appDir: string,
  spec: string,
  contract: SprintContract,
  previousFeedback?: EvalResult,
): Promise<{ response: string }> {
  const sprint = contract.sprintNumber;
  const attempt = previousFeedback ? "retry" : "initial";
  const isExisting = appDir !== `${workDir}/app` && appDir !== workDir + "/app";
  log("GENERATOR", `Sprint ${sprint} (${attempt}) - Building: ${contract.features.join(", ")}`);

  let taskPrompt = isExisting
    ? `IMPORTANT: You are working on an existing codebase at ${appDir}. Read and understand the existing code before making changes. Your harness state directory is ${workDir} (where spec.md and contracts live).\n\n## Product Spec\n\n${spec}\n\n## Sprint Contract\n\n${JSON.stringify(contract, null, 2)}`
    : `## Product Spec\n\n${spec}\n\n## Sprint Contract\n\n${JSON.stringify(contract, null, 2)}`;

  if (previousFeedback) {
    taskPrompt += `\n\n## Evaluation Feedback (MUST ADDRESS)\n\n${JSON.stringify(previousFeedback, null, 2)}`;
    taskPrompt += `\n\nThe previous attempt failed evaluation. Address every issue in the feedback above.`;
  } else if (isExisting) {
    taskPrompt += `\n\nExplore the existing codebase at ${appDir} first, then implement the features listed in this sprint contract.`;
  } else {
    taskPrompt += `\n\nImplement the features listed in this sprint contract. Work in the \`app/\` directory.`;
  }

  const systemPrompt = isExisting ? GENERATOR_EXISTING_SYSTEM_PROMPT : GENERATOR_SYSTEM_PROMPT;
  const fullPrompt = `${systemPrompt}\n\n---\n\n${taskPrompt}`;

  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: isExisting ? appDir : workDir,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: CODEX_NETWORK_ACCESS,
    approvalPolicy: "never",
    model: CODEX_MODEL,
  });

  // Use streaming for generator to get visibility into long builds
  const { events } = await thread.runStreamed(fullPrompt);

  let fullResponse = "";

  for await (const event of events) {
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        fullResponse += item.text;
      } else if (item.type === "command_execution" && typeof item.command === "string") {
        log("GENERATOR", `  Command: ${item.command}`);
      }
    } else if (event.type === "turn.completed") {
      const turnEvent = event as { usage?: { input_tokens?: number; output_tokens?: number } };
      const usage = turnEvent.usage;
      if (usage) {
        log("GENERATOR", `  Tokens: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`);
      }
      log("GENERATOR", `Sprint ${sprint} build complete`);
      break; // Critical: break on turn.completed to prevent 90s timeout
    } else if (event.type === "error") {
      const errorEvent = event as { message?: string };
      logError("GENERATOR", `Stream error: ${errorEvent.message ?? "unknown"}`);
    }
  }

  if (!fullResponse) {
    log("GENERATOR", `Sprint ${sprint} completed (no text output - agent used tools only)`);
  }

  return { response: fullResponse };
}
