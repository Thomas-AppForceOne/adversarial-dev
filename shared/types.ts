export interface HarnessConfig {
  userPrompt: string;
  workDir: string;
  /** Optional: path to an existing codebase. When set, agents operate on this
   *  directory instead of creating a fresh app/ subdirectory. */
  appDir?: string;
  /** Optional: path to a pre-written spec file. Skips the planner entirely. */
  specFile?: string;
  /** Optional: path to a directory of per-feature spec files. Planner reads
   *  all .md files in the dir, respects roadmap.md ordering if present. */
  specsDir?: string;
  /** Resume from a previous interrupted run. Reuses spec.md, skips completed
   *  sprints, and continues from where progress.json left off. */
  resume?: boolean;
  maxSprints: number;
  maxRetriesPerSprint: number;
  passThreshold: number;
}

export interface SprintContract {
  sprintNumber: number;
  features: string[];
  criteria: SprintCriterion[];
}

export interface SprintCriterion {
  name: string;
  description: string;
  threshold: number;
}

export interface EvalScore {
  criterion: string;
  score: number;
  details: string;
}

export interface EvalResult {
  passed: boolean;
  scores: Record<string, number>;
  feedback: EvalScore[];
  overallSummary: string;
}

export interface HarnessProgress {
  status: "planning" | "negotiating" | "building" | "evaluating" | "complete" | "failed";
  currentSprint: number;
  totalSprints: number;
  completedSprints: number;
  retryCount: number;
}

export interface SprintResult {
  sprintNumber: number;
  passed: boolean;
  attempts: number;
  evalResult?: EvalResult;
}

export interface HarnessResult {
  success: boolean;
  sprints: SprintResult[];
  totalDurationMs: number;
}
