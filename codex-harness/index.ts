import { resolve } from "path";
import { readFile } from "fs/promises";
import { runHarness } from "./harness.ts";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import { log, logError, logDivider } from "../shared/logger.ts";
import type { HarnessConfig } from "../shared/types.ts";

let userPrompt: string | undefined;
let targetDir: string | undefined;
let specFile: string | undefined;
let specsDir: string | undefined;

// Parse argv: [node, script, ...args]
// Supported flags: --file/-f <path>, --target/-t <path>, --spec/-s <path>, --specs <dir>
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
  } else {
    positional.push(a);
  }
}

if (!userPrompt && positional.length > 0) {
  userPrompt = positional.join(" ");
}

// userPrompt is optional when --spec or --specs is provided
if (!userPrompt && !specFile && !specsDir) {
  console.error("Usage: bun run codex-harness/index.ts <prompt>");
  console.error('       bun run codex-harness/index.ts --file <path-to-prompt.md>');
  console.error('       bun run codex-harness/index.ts --spec <spec-file>');
  console.error('       bun run codex-harness/index.ts --specs <specs-directory>');
  console.error('       bun run codex-harness/index.ts --target <existing-project-dir> <prompt>');
  console.error('       bun run codex-harness/index.ts --target <dir> --spec <spec-file>');
  console.error('       bun run codex-harness/index.ts --target <dir> --specs <specs-dir>');
  console.error('Example: bun run codex-harness/index.ts "Build a task manager"');
  console.error('Example: bun run codex-harness/index.ts --spec ./SPEC.md --target ~/projects/myapp');
  console.error('Example: bun run codex-harness/index.ts --specs ./specs/ --target ~/projects/myapp');
  process.exit(1);
}

if (!userPrompt) {
  userPrompt = specFile ?? specsDir ?? "";
}

const config: HarnessConfig = {
  ...DEFAULT_CONFIG,
  userPrompt,
  workDir: resolve("workspace/codex"),
  ...(targetDir ? { appDir: targetDir } : {}),
  ...(specFile ? { specFile } : {}),
  ...(specsDir ? { specsDir } : {}),
};

logDivider();
log("HARNESS", "ADVERSARIAL DEV - Codex SDK Harness");
log("HARNESS", `Prompt: "${userPrompt}"`);
if (targetDir) log("HARNESS", `Target:  ${targetDir}`);
if (specFile)  log("HARNESS", `Spec:    ${specFile}`);
if (specsDir)  log("HARNESS", `Specs:   ${specsDir}`);
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
