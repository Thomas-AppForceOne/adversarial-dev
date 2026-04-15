type AgentRole = "HARNESS" | "PLANNER" | "GENERATOR" | "EVALUATOR" | "CLAUDE-CLI";

const COLORS: Record<AgentRole, string> = {
  HARNESS: "\x1b[36m",     // cyan
  PLANNER: "\x1b[35m",     // magenta
  GENERATOR: "\x1b[32m",   // green
  EVALUATOR: "\x1b[33m",   // yellow
  "CLAUDE-CLI": "\x1b[90m", // grey (infra layer, not an agent)
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function formatMessage(role: AgentRole, message: string): string {
  return `${DIM}${timestamp()}${RESET} ${COLORS[role]}[${role}]${RESET} ${message}`;
}

export function log(role: AgentRole, message: string): void {
  console.log(formatMessage(role, message));
}

export function logError(role: AgentRole, message: string): void {
  console.error(formatMessage(role, `\x1b[31m${message}${RESET}`));
}

export function logDivider(): void {
  console.log(`\n${DIM}${"─".repeat(60)}${RESET}\n`);
}
