import { join } from "path";
import { readFile } from "fs/promises";
import { Codex } from "@openai/codex-sdk";
import {
  CONTRACT_NEGOTIATION_GENERATOR_PROMPT,
  CONTRACT_NEGOTIATION_EVALUATOR_PROMPT,
} from "../shared/prompts.ts";
import { CODEX_MODEL, CODEX_NETWORK_ACCESS } from "../shared/config.ts";
import { log, logError, logDivider } from "../shared/logger.ts";
import {
  initWorkspace,
  writeSpec,
  readSpec,
  writeContract,
  writeFeedback,
  writeProgress,
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

  log("HARNESS", "Initializing Codex SDK harness");
  log("HARNESS", `Work directory: ${config.workDir}`);
  log("HARNESS", `App directory:  ${appDir} (${mode})`);
  log("HARNESS", `Max sprints: ${config.maxSprints} | Max retries: ${config.maxRetriesPerSprint} | Threshold: ${config.passThreshold}/10`);

  await initWorkspace(config.workDir, config.appDir, !!(config.specFile || config.specsDir));

  // Phase 1: Planning
  logDivider();
  log("HARNESS", "PHASE 1: PLANNING");
  logDivider();

  const progress: HarnessProgress = {
    status: "planning",
    currentSprint: 0,
    totalSprints: 0,
    completedSprints: 0,
    retryCount: 0,
  };
  await writeProgress(config.workDir, progress);

  let spec: string;
  if (config.specFile) {
    log("HARNESS", `Using provided spec: ${config.specFile}`);
    spec = await readFile(config.specFile, "utf-8");
    await writeSpec(config.workDir, spec);
  } else if (config.specsDir) {
    log("HARNESS", `Assembling spec from directory: ${config.specsDir}`);
    await runPlannerFromSpecsDir(config.specsDir, config.workDir, config.appDir);
    spec = await readSpec(config.workDir);
  } else {
    const plannerResponse = await runPlanner(config.userPrompt, config.workDir, config.appDir);
    try {
      spec = await readSpec(config.workDir);
    } catch {
      log("HARNESS", "Planner returned spec as text, writing to spec.md");
      await writeSpec(config.workDir, plannerResponse);
      spec = plannerResponse;
    }
  }

  // Parse sprint count from spec - look for "Sprint N" patterns
  const sprintNumbers = Array.from(spec.matchAll(/sprint\s+(\d+)/gi))
    .map((m) => parseInt(m[1]!, 10))
    .filter((n) => n > 0 && n <= config.maxSprints);
  const totalSprints = sprintNumbers.length > 0
    ? Math.min(Math.max(...sprintNumbers), config.maxSprints)
    : 3; // Default to 3 if no sprint numbers found

  progress.totalSprints = totalSprints;
  log("HARNESS", `Planner produced ${totalSprints} sprints`);

  // Phase 2-4: Sprint Loop
  for (let sprint = 1; sprint <= totalSprints; sprint++) {
    logDivider();
    log("HARNESS", `SPRINT ${sprint}/${totalSprints}`);
    logDivider();

    // Phase 2: Contract Negotiation
    progress.status = "negotiating";
    progress.currentSprint = sprint;
    progress.retryCount = 0;
    await writeProgress(config.workDir, progress);

    log("HARNESS", "Negotiating sprint contract...");
    const contract = await negotiateContract(config.workDir, spec, sprint);
    await writeContract(config.workDir, contract);
    log("HARNESS", `Contract agreed: ${contract.criteria.length} criteria for ${contract.features.length} features`);

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

      await runGenerator(config.workDir, appDir, spec, contract, lastEval);

      // Evaluate
      progress.status = "evaluating";
      await writeProgress(config.workDir, progress);

      lastEval = await runEvaluator(config.workDir, appDir, contract, config.passThreshold);
      await writeFeedback(config.workDir, sprint, retry, lastEval);

      if (lastEval.passed) {
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

  const allPassed = results.every((r) => r.passed);
  progress.status = allPassed ? "complete" : "failed";
  await writeProgress(config.workDir, progress);

  const totalDuration = Date.now() - startTime;
  logDivider();
  log("HARNESS", `Harness ${allPassed ? "COMPLETED" : "FAILED"} in ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
  log("HARNESS", `Sprints: ${results.filter((r) => r.passed).length}/${results.length} passed`);

  return { success: allPassed, sprints: results, totalDurationMs: totalDuration };
}

async function negotiateContract(
  workDir: string,
  spec: string,
  sprintNumber: number,
): Promise<SprintContract> {
  const codex = new Codex();

  // Generator proposes contract
  const proposalPrompt = `${CONTRACT_NEGOTIATION_GENERATOR_PROMPT}\n\n---\n\n## Product Spec\n\n${spec}\n\n## Sprint Number: ${sprintNumber}\n\nPropose a sprint contract for this sprint.`;

  const proposalThread = codex.startThread({
    workingDirectory: workDir,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: CODEX_NETWORK_ACCESS,
    approvalPolicy: "never",
    model: CODEX_MODEL,
  });

  const proposalTurn = await proposalThread.run(proposalPrompt);
  const proposalText = proposalTurn.finalResponse ?? "";

  // Evaluator reviews contract
  const reviewPrompt = `${CONTRACT_NEGOTIATION_EVALUATOR_PROMPT}\n\n---\n\n## Proposed Sprint Contract\n\n${proposalText}\n\nReview this contract.`;

  const reviewThread = codex.startThread({
    workingDirectory: workDir,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: CODEX_NETWORK_ACCESS,
    approvalPolicy: "never",
    model: CODEX_MODEL,
  });

  const reviewTurn = await reviewThread.run(reviewPrompt);
  const reviewText = reviewTurn.finalResponse ?? "";

  const contractSource = reviewText.trim() === "APPROVED" ? proposalText : reviewText;
  return parseContract(contractSource, sprintNumber);
}

function parseContract(text: string, sprintNumber: number): SprintContract {
  // Try multiple extraction strategies
  const candidates: string[] = [];
  const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of codeBlocks.reverse()) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const braceMatch = text.match(/\{[\s\S]*"criteria"[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  candidates.push(text.trim());

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
