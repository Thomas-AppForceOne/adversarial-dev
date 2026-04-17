import { join } from "path";
import { readFile } from "fs/promises";
import {
  CONTRACT_NEGOTIATION_GENERATOR_PROMPT,
  CONTRACT_NEGOTIATION_EVALUATOR_PROMPT,
} from "../shared/prompts.ts";
import { runClaude, ToolTimeoutError } from "../shared/claude-cli.ts";
import { recordClaudeResult, formatUsageReport } from "../shared/usage.ts";
import { log, logError, logDivider } from "../shared/logger.ts";
import {
  initWorkspace,
  writeSpec,
  readSpec,
  writeContract,
  readContract,
  writeFeedback,
  writeProgress,
  readProgress,
} from "../shared/files.ts";
import type {
  HarnessConfig,
  SprintContract,
  EvalResult,
  HarnessProgress,
  HarnessResult,
  SprintResult,
} from "../shared/types.ts";

import { runPlanner, runPlannerFromSpecsDir } from "./planner.ts";
import { runGenerator } from "./generator.ts";
import { runEvaluator } from "./evaluator.ts";

export async function runHarness(config: HarnessConfig): Promise<HarnessResult> {
  const startTime = Date.now();
  const results: SprintResult[] = [];

  const appDir = config.appDir ?? join(config.workDir, "app");
  const mode = config.appDir ? "existing codebase" : "greenfield";

  log("HARNESS", "Initializing Claude Code subprocess harness");
  log("HARNESS", `Work directory: ${config.workDir}`);
  log("HARNESS", `App directory:  ${appDir} (${mode})`);
  log("HARNESS", `Max sprints: ${config.maxSprints} | Max retries: ${config.maxRetriesPerSprint} | Threshold: ${config.passThreshold}/10`);
  if (config.resume) log("HARNESS", "RESUME MODE — reusing existing spec + skipping completed sprints");

  await initWorkspace(
    config.workDir,
    config.appDir,
    !!(config.specFile || config.specsDir),
    config.resume,
  );

  // ---- Resume: load previous progress if available ----
  let resumedProgress: HarnessProgress | null = null;
  let startSprint = 1;

  if (config.resume) {
    try {
      resumedProgress = await readProgress(config.workDir);
      startSprint = resumedProgress.completedSprints + 1;
      if (startSprint > 1) {
        log("HARNESS", `Previous run completed ${resumedProgress.completedSprints} sprints — resuming from sprint ${startSprint}`);
        // Populate results for already-completed sprints so the final
        // report is accurate.
        for (let s = 1; s < startSprint; s++) {
          results.push({ sprintNumber: s, passed: true, attempts: 1 });
        }
      }
    } catch {
      log("HARNESS", "No previous progress found — starting from scratch");
    }
  }

  // ---- Phase 1: Planning ----
  logDivider();

  let spec: string;

  // On resume, try to reuse the existing spec.md first.
  if (config.resume) {
    try {
      spec = await readSpec(config.workDir);
      log("HARNESS", "PHASE 1: PLANNING (reusing existing spec.md)");
    } catch {
      log("HARNESS", "PHASE 1: PLANNING (spec.md not found, re-running planner)");
      spec = await planFromScratch(config, config.modelLow);
    }
  } else {
    log("HARNESS", "PHASE 1: PLANNING");
    spec = await planFromScratch(config, config.modelLow);
  }

  logDivider();

  const progress: HarnessProgress = {
    status: "planning",
    currentSprint: resumedProgress?.currentSprint ?? 0,
    totalSprints: resumedProgress?.totalSprints ?? 0,
    completedSprints: resumedProgress?.completedSprints ?? 0,
    retryCount: 0,
  };

  // Parse sprint count from spec - look for "Sprint N" patterns
  const sprintNumbers = Array.from(spec.matchAll(/sprint\s+(\d+)/gi))
    .map((m) => parseInt(m[1]!, 10))
    .filter((n) => n > 0 && n <= config.maxSprints);
  const totalSprints = sprintNumbers.length > 0
    ? Math.min(Math.max(...sprintNumbers), config.maxSprints)
    : 3; // Default to 3 if no sprint numbers found

  progress.totalSprints = totalSprints;
  await writeProgress(config.workDir, progress);

  if (startSprint > totalSprints) {
    log("HARNESS", "All sprints already completed in previous run!");
    return { success: true, sprints: results, totalDurationMs: Date.now() - startTime };
  }

  log("HARNESS", `Spec has ${totalSprints} sprints${startSprint > 1 ? ` (starting from sprint ${startSprint})` : ""}`);

  // ---- Phase 2-4: Sprint Loop ----
  for (let sprint = startSprint; sprint <= totalSprints; sprint++) {
    logDivider();
    log("HARNESS", `SPRINT ${sprint}/${totalSprints}`);
    logDivider();

    // Phase 2: Contract Negotiation — reuse saved contract on resume if available
    progress.status = "negotiating";
    progress.currentSprint = sprint;
    progress.retryCount = 0;
    await writeProgress(config.workDir, progress);

    let contract: SprintContract;
    if (config.resume) {
      try {
        contract = await readContract(config.workDir, sprint);
        log("HARNESS", `Reusing saved contract: ${contract.criteria.length} criteria for ${contract.features.length} features`);
      } catch {
        log("HARNESS", "No saved contract for this sprint — negotiating...");
        contract = await negotiateContract(config.workDir, spec, sprint, config.modelLow);
        await writeContract(config.workDir, contract);
        log("HARNESS", `Contract agreed: ${contract.criteria.length} criteria for ${contract.features.length} features`);
      }
    } else {
      log("HARNESS", "Negotiating sprint contract...");
      contract = await negotiateContract(config.workDir, spec, sprint, config.modelLow);
      await writeContract(config.workDir, contract);
      log("HARNESS", `Contract agreed: ${contract.criteria.length} criteria for ${contract.features.length} features`);
    }

    // Phase 3-4: Build-Evaluate Loop
    let passed = false;
    let lastEval: EvalResult | undefined;
    let attempts = 0;

    for (let retry = 0; retry <= config.maxRetriesPerSprint; retry++) {
      attempts = retry + 1;

      // Build
      progress.status = "building";
      progress.retryCount = retry;
      await writeProgress(config.workDir, progress);

      try {
        await runGenerator(config.workDir, appDir, spec, contract, config.modelHigh, lastEval);

        // Evaluate
        progress.status = "evaluating";
        await writeProgress(config.workDir, progress);

        lastEval = await runEvaluator(config.workDir, appDir, contract, config.passThreshold, config.modelLow);
        await writeFeedback(config.workDir, sprint, retry, lastEval);
      } catch (err) {
        // Tool timeouts are an expected failure mode — they mean a generated
        // subprocess hung. Treat the attempt as failed and let the retry
        // loop re-attempt. Everything else still propagates.
        if (!(err instanceof ToolTimeoutError)) throw err;

        logError(
          "HARNESS",
          `Sprint ${sprint} attempt ${attempts} hit tool timeout: ${err.message}`,
        );
        lastEval = {
          passed: false,
          scores: {},
          feedback: [
            {
              criterion: "tool_timeout",
              score: 0,
              details:
                `Tool '${err.tool}' exceeded ${err.timeoutMs}ms wall-clock timeout ` +
                `(ran ${err.elapsedMs}ms) during this attempt. The claude subprocess was ` +
                `killed. Retry will start from a fresh session.`,
            },
          ],
          overallSummary: `Attempt ${attempts} aborted by per-tool timeout on '${err.tool}'.`,
        };
        await writeFeedback(config.workDir, sprint, retry, lastEval);
      }

      if (lastEval && lastEval.passed) {
        passed = true;
        log("HARNESS", `Sprint ${sprint} PASSED on attempt ${attempts}`);
        break;
      }

      if (retry < config.maxRetriesPerSprint) {
        log("HARNESS", `Sprint ${sprint} failed attempt ${attempts}, retrying...`);
      } else {
        logError("HARNESS", `Sprint ${sprint} FAILED after ${attempts} attempts`);
      }
    }

    results.push({
      sprintNumber: sprint,
      passed,
      attempts,
      evalResult: lastEval,
    });

    if (passed) {
      progress.completedSprints++;
    } else {
      progress.status = "failed";
      await writeProgress(config.workDir, progress);
      logError("HARNESS", `Harness stopped: sprint ${sprint} could not pass evaluation`);
      break;
    }
  }

  // Final status
  const allPassed = results.every((r) => r.passed);
  progress.status = allPassed ? "complete" : "failed";
  await writeProgress(config.workDir, progress);

  const totalDuration = Date.now() - startTime;
  logDivider();
  log("HARNESS", `Harness ${allPassed ? "COMPLETED" : "FAILED"} in ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
  log("HARNESS", `Sprints: ${results.filter((r) => r.passed).length}/${results.length} passed`);

  // Print token usage + cost summary collected across every claude -p call.
  logDivider();
  for (const line of formatUsageReport().split("\n")) {
    log("HARNESS", line);
  }

  return { success: allPassed, sprints: results, totalDurationMs: totalDuration };
}

async function planFromScratch(config: HarnessConfig, model: string): Promise<string> {
  if (config.specFile) {
    log("HARNESS", `Using provided spec: ${config.specFile}`);
    const spec = await readFile(config.specFile, "utf-8");
    await writeSpec(config.workDir, spec);
    return spec;
  } else if (config.specsDir) {
    log("HARNESS", `Assembling spec from directory: ${config.specsDir}`);
    await runPlannerFromSpecsDir(config.specsDir, config.workDir, config.appDir, model);
    return readSpec(config.workDir);
  } else {
    const plannerResponse = await runPlanner(config.userPrompt, config.workDir, config.appDir, model);
    try {
      return await readSpec(config.workDir);
    } catch {
      log("HARNESS", "Planner returned spec as text, writing to spec.md");
      await writeSpec(config.workDir, plannerResponse);
      return plannerResponse;
    }
  }
}

async function negotiateContract(
  workDir: string,
  spec: string,
  sprintNumber: number,
  model: string,
): Promise<SprintContract> {
  // Generator proposes contract
  const proposalPrompt = `## Product Spec\n\n${spec}\n\n## Sprint Number: ${sprintNumber}\n\nPropose a sprint contract for this sprint.`;

  let proposalText = "";
  for await (const msg of runClaude({
    prompt: proposalPrompt,
    cwd: workDir,
    systemPrompt: CONTRACT_NEGOTIATION_GENERATOR_PROMPT,
    tools: ["Read"],
    model,
    maxTurns: 10,
    role: `CONTRACT/sprint ${sprintNumber} propose`,
    timingsDir: workDir,
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          proposalText += block.text;
        }
      }
    } else if (msg.type === "result") {
      recordClaudeResult(`CONTRACT/sprint ${sprintNumber} propose`, msg);
    }
  }

  // Evaluator reviews contract
  const reviewPrompt = `## Proposed Sprint Contract\n\n${proposalText}\n\nReview this contract.`;

  let reviewText = "";
  for await (const msg of runClaude({
    prompt: reviewPrompt,
    cwd: workDir,
    systemPrompt: CONTRACT_NEGOTIATION_EVALUATOR_PROMPT,
    tools: ["Read"],
    model,
    maxTurns: 10,
    role: `CONTRACT/sprint ${sprintNumber} review`,
    timingsDir: workDir,
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          reviewText += block.text;
        }
      }
    } else if (msg.type === "result") {
      recordClaudeResult(`CONTRACT/sprint ${sprintNumber} review`, msg);
    }
  }

  // Bail early if neither agent produced anything useful (e.g. model error).
  if (!proposalText.includes("{") && !reviewText.includes("{")) {
    const detail = proposalText || reviewText || "(empty response)";
    throw new Error(`Contract negotiation failed — agents returned no JSON. Response: ${detail.slice(0, 300)}`);
  }

  // "APPROVED" means use the proposal as-is. Accept minor variations (trailing
  // punctuation, case differences) to avoid fragile exact-string matching.
  const isApproved = /^approved[.!]?$/i.test(reviewText.trim());
  const contractSource = isApproved ? proposalText : reviewText;

  const contract = parseContract(contractSource, sprintNumber, proposalText);
  return contract;
}

function parseContract(text: string, sprintNumber: number, fallbackText?: string): SprintContract {
  // Try multiple extraction strategies across the primary text and an optional fallback
  const sources = fallbackText ? [text, fallbackText] : [text];
  const candidates: string[] = [];

  for (const src of sources) {
    const codeBlocks = [...src.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    for (const match of codeBlocks.reverse()) {
      if (match[1]) candidates.push(match[1].trim());
    }
    const braceMatch = src.match(/\{[\s\S]*"criteria"[\s\S]*\}/);
    if (braceMatch) candidates.push(braceMatch[0]);
    candidates.push(src.trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as SprintContract;
      if (parsed.criteria && Array.isArray(parsed.criteria)) {
        parsed.sprintNumber = sprintNumber;
        return parsed;
      }
    } catch {
      // Try next candidate
    }
  }

  {
    logError("HARNESS", "Failed to parse contract JSON, creating default");
    logError("HARNESS", `Primary response (${text.length} chars): ${text.slice(0, 300)}`);
    if (fallbackText) logError("HARNESS", `Fallback response (${fallbackText.length} chars): ${fallbackText.slice(0, 300)}`);
    return {
      sprintNumber,
      features: [`Sprint ${sprintNumber} features`],
      criteria: [
        {
          name: "basic_functionality",
          description: "Core features for this sprint are implemented and working",
          threshold: 7,
        },
        {
          name: "code_quality",
          description: "Code is clean, well-structured, and follows best practices",
          threshold: 7,
        },
        {
          name: "error_handling",
          description: "Errors are handled gracefully with appropriate user feedback",
          threshold: 7,
        },
      ],
    };
  }
}
