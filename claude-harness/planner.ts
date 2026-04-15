import { readFile } from "fs/promises";
import { join } from "path";
import { PLANNER_SYSTEM_PROMPT, PLANNER_SPECS_DIR_SYSTEM_PROMPT } from "../shared/prompts.ts";
import { CLAUDE_MODEL, CLAUDE_MAX_TURNS } from "../shared/config.ts";
import { log, logError } from "../shared/logger.ts";
import { runClaude } from "../shared/claude-cli.ts";
import { recordClaudeResult } from "../shared/usage.ts";

export async function runPlanner(userPrompt: string, workDir: string, appDir?: string): Promise<string> {
  log("PLANNER", `Starting planning for: "${userPrompt}"`);

  const existingContext = appDir
    ? `\n\nIMPORTANT: You are planning work on an EXISTING codebase located at ${appDir}. Before writing the spec, use Glob and Grep to explore and understand the existing project structure, tech stack, and current features. Your spec should describe what already exists AND what needs to be added or changed based on the user request below. Do NOT plan to recreate things that already exist.`
    : "";

  const fullPrompt = `IMPORTANT: Your working directory is ${workDir}. Write spec.md inside this directory only. Do NOT write files elsewhere.${existingContext}\n\n${userPrompt}`;

  let fullResponse = "";
  let completed = false;

  for await (const msg of runClaude({
    prompt: fullPrompt,
    cwd: workDir,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    tools: appDir ? ["Read", "Write", "Glob", "Grep"] : ["Read", "Write"],
    model: CLAUDE_MODEL,
    maxTurns: CLAUDE_MAX_TURNS,
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        }
      }
    } else if (msg.type === "result") {
      recordClaudeResult("PLANNER", msg);
      completed = true;
      log("PLANNER", `Planning complete (session: ${msg.session_id?.slice(0, 8)}...)`);
    }
  }

  if (!completed) {
    logError("PLANNER", "Planner query did not complete");
    throw new Error("Planner failed to produce output");
  }

  // The planner may have written spec.md via the Write tool instead of returning text.
  // Try to read from disk as the primary source.
  if (!fullResponse) {
    try {
      fullResponse = await readFile(join(workDir, "spec.md"), "utf-8");
      log("PLANNER", "Read spec from file written by planner agent");
    } catch {
      logError("PLANNER", "No text response and no spec.md on disk");
      throw new Error("Planner completed but produced no spec");
    }
  }

  log("PLANNER", "Product specification generated");
  return fullResponse;
}

export async function runPlannerFromSpecsDir(specsDir: string, workDir: string, appDir?: string): Promise<void> {
  log("PLANNER", `Building spec from directory: ${specsDir}`);

  const existingContext = appDir
    ? `\n\nThe target codebase is at ${appDir}. You may use this context to infer the tech stack and add technical detail when expanding spec criteria.`
    : "";

  const prompt = `IMPORTANT: Your working directory is ${workDir}. Write spec.md inside this directory only. Do NOT write files elsewhere.

The specs directory is at: ${specsDir}

Discover all .md files in that directory (including subdirectories) using Glob. Check for a roadmap file (roadmap.md or ROADMAP.md) and use it to determine sprint order if present. Produce spec.md in ${workDir}.${existingContext}`;

  let completed = false;

  for await (const msg of runClaude({
    prompt,
    cwd: workDir,
    systemPrompt: PLANNER_SPECS_DIR_SYSTEM_PROMPT,
    tools: ["Read", "Write", "Glob"],
    model: CLAUDE_MODEL,
    maxTurns: CLAUDE_MAX_TURNS,
  })) {
    if (msg.type === "result") {
      recordClaudeResult("PLANNER/specs-dir", msg);
      completed = true;
      log("PLANNER", `Spec assembly complete (session: ${msg.session_id?.slice(0, 8)}...)`);
    }
  }

  if (!completed) {
    logError("PLANNER", "Specs-dir planner did not complete");
    throw new Error("Planner failed to assemble spec from directory");
  }

  log("PLANNER", "Spec assembled from specs directory");
}
