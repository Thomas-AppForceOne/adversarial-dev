import { Codex } from "@openai/codex-sdk";
import { PLANNER_SYSTEM_PROMPT, PLANNER_SPECS_DIR_SYSTEM_PROMPT } from "../shared/prompts.ts";
import { CODEX_NETWORK_ACCESS } from "../shared/config.ts";
import { log, logError } from "../shared/logger.ts";

export async function runPlanner(userPrompt: string, workDir: string, appDir: string | undefined, model: string): Promise<string> {
  log("PLANNER", `Starting planning for: "${userPrompt}"`);

  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: workDir,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: CODEX_NETWORK_ACCESS,
    approvalPolicy: "never",
    model,
  });

  const existingContext = appDir
    ? `\n\nIMPORTANT: You are planning work on an EXISTING codebase located at ${appDir}. Before writing the spec, explore and understand the existing project structure, tech stack, and current features. Your spec should describe what already exists AND what needs to be added or changed based on the user request below. Do NOT plan to recreate things that already exist.`
    : "";

  const fullPrompt = `${PLANNER_SYSTEM_PROMPT}\n\n---\n\nUser Request: ${userPrompt}${existingContext}`;

  const turn = await thread.run(fullPrompt);

  if (!turn.finalResponse) {
    logError("PLANNER", "Planner produced no output");
    throw new Error("Planner failed to produce output");
  }

  log("PLANNER", "Product specification generated");
  return turn.finalResponse;
}

export async function runPlannerFromSpecsDir(specsDir: string, workDir: string, appDir: string | undefined, model: string): Promise<void> {
  log("PLANNER", `Building spec from directory: ${specsDir}`);

  const existingContext = appDir
    ? `\n\nThe target codebase is at ${appDir}. You may use this context to infer the tech stack and add technical detail when expanding spec criteria.`
    : "";

  const prompt = `${PLANNER_SPECS_DIR_SYSTEM_PROMPT}

---

IMPORTANT: Your working directory is ${workDir}. Write spec.md inside this directory only.

The specs directory is at: ${specsDir}

Discover all .md files in that directory (including subdirectories). Check for a roadmap file (roadmap.md or ROADMAP.md) and use it to determine sprint order if present. Produce spec.md in ${workDir}.${existingContext}`;

  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: workDir,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: CODEX_NETWORK_ACCESS,
    approvalPolicy: "never",
    model,
  });

  const turn = await thread.run(prompt);

  if (!turn.finalResponse) {
    throw new Error("Planner failed to assemble spec from directory");
  }

  log("PLANNER", "Spec assembled from specs directory");
}
