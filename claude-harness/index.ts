import { resolve } from "path";
import { readFile } from "fs/promises";
import { runHarness } from "./harness.ts";
import { DEFAULT_CONFIG, resolveClaudeModels, CLAUDE_MODELS } from "../shared/config.ts";
import { log, logError, logDivider } from "../shared/logger.ts";
import type { HarnessConfig } from "../shared/types.ts";

// --models: print valid models and exit (no Docker/harness needed)
if (process.argv.includes("--models")) {
  console.log("Claude models (default: claude-sonnet-4-6):");
  for (const m of CLAUDE_MODELS) console.log(`  ${m}`);
  process.exit(0);
}

let userPrompt: string | undefined;
let targetDir: string | undefined;
let specFile: string | undefined;
let specsDir: string | undefined;
let resume = false;
let cliModel: string | undefined;
let cliModelHigh: string | undefined;
let cliModelLow: string | undefined;

// Parse argv: [node, script, ...args]
// Supported flags: --file/-f <path>, --target/-t <path>, --spec/-s <path>, --specs <dir>, --resume/-r, --model/-m <model>
const args = process.argv.slice(2);
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--file" || a === "-f") {
    const filePath = args[++i];
    if (!filePath) { console.error("Error: --file requires a path argument"); process.exit(1); }
    userPrompt = await readFile(resolve(filePath), "utf-8");
  } else if (a === "--target" || a === "-t") {
    const dir = args[++i];
    if (!dir) { console.error("Error: --target requires a directory path"); process.exit(1); }
    targetDir = resolve(dir);
  } else if (a === "--spec" || a === "-s") {
    const p = args[++i];
    if (!p) { console.error("Error: --spec requires a file path"); process.exit(1); }
    specFile = resolve(p);
  } else if (a === "--specs") {
    const d = args[++i];
    if (!d) { console.error("Error: --specs requires a directory path"); process.exit(1); }
    specsDir = resolve(d);
  } else if (a === "--resume" || a === "-r") {
    resume = true;
  } else if (a === "--model" || a === "-m") {
    cliModel = args[++i];
    if (!cliModel) { console.error("Error: --model requires a model name"); process.exit(1); }
  } else if (a === "--model-high") {
    cliModelHigh = args[++i];
    if (!cliModelHigh) { console.error("Error: --model-high requires a model name"); process.exit(1); }
  } else if (a === "--model-low") {
    cliModelLow = args[++i];
    if (!cliModelLow) { console.error("Error: --model-low requires a model name"); process.exit(1); }
  } else {
    positional.push(a);
  }
}

if (!userPrompt && positional.length > 0) {
  userPrompt = positional.join(" ");
}

// userPrompt is optional when --spec, --specs, or --resume is provided
if (!userPrompt && !specFile && !specsDir && !resume) {
  console.error("Usage: bun run claude-harness/index.ts <prompt>");
  console.error('       bun run claude-harness/index.ts --file <path-to-prompt.md>');
  console.error('       bun run claude-harness/index.ts --spec <spec-file>');
  console.error('       bun run claude-harness/index.ts --specs <specs-directory>');
  console.error('       bun run claude-harness/index.ts --target <existing-project-dir> <prompt>');
  console.error('       bun run claude-harness/index.ts --target <dir> --spec <spec-file>');
  console.error('       bun run claude-harness/index.ts --target <dir> --specs <specs-dir>');
  console.error(`       bun run claude-harness/index.ts --model <model>  (valid: ${CLAUDE_MODELS.join(", ")})`);
  console.error('       bun run claude-harness/index.ts --model-high <model> --model-low <model>   # two-tier: generator=high, rest=low');
  console.error('Example: bun run claude-harness/index.ts "Build a task manager"');
  console.error('Example: bun run claude-harness/index.ts --spec ./SPEC.md --target ~/projects/myapp');
  console.error('Example: bun run claude-harness/index.ts --specs ./specs/ --target ~/projects/myapp');
  process.exit(1);
}

if (!userPrompt) {
  userPrompt = specFile ?? specsDir ?? "";
}

const { high: modelHigh, low: modelLow } = resolveClaudeModels(cliModel, cliModelHigh, cliModelLow);

const config: HarnessConfig = {
  ...DEFAULT_CONFIG,
  userPrompt,
  workDir: resolve("workspace/claude"),
  modelHigh,
  modelLow,
  ...(targetDir ? { appDir: targetDir } : {}),
  ...(specFile ? { specFile } : {}),
  ...(specsDir ? { specsDir } : {}),
  ...(resume ? { resume } : {}),
};

logDivider();
log("HARNESS", "ADVERSARIAL DEV - Claude Agent SDK Harness");
log("HARNESS", `Prompt: "${userPrompt}"`);
if (modelHigh === modelLow) {
  log("HARNESS", `Model:   ${modelHigh}`);
} else {
  log("HARNESS", `Model (high/generator): ${modelHigh}`);
  log("HARNESS", `Model (low/planner,contract,evaluator): ${modelLow}`);
}
if (targetDir) log("HARNESS", `Target:  ${targetDir}`);
if (specFile)  log("HARNESS", `Spec:    ${specFile}`);
if (specsDir)  log("HARNESS", `Specs:   ${specsDir}`);
if (resume)    log("HARNESS", `Resume:  yes`);
logDivider();

try {
  const result = await runHarness(config);

  logDivider();
  if (result.success) {
    log("HARNESS", "All sprints completed successfully!");
  } else {
    logError("HARNESS", "Harness completed with failures.");
  }

  log("HARNESS", `Total time: ${(result.totalDurationMs / 1000 / 60).toFixed(1)} minutes`);
  log("HARNESS", `Sprints passed: ${result.sprints.filter((s) => s.passed).length}/${result.sprints.length}`);

  for (const sprint of result.sprints) {
    const status = sprint.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    log("HARNESS", `  Sprint ${sprint.sprintNumber}: [${status}] (${sprint.attempts} attempts)`);
  }

  process.exit(result.success ? 0 : 1);
} catch (error) {
  logError("HARNESS", `Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
