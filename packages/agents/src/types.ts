export type AgentProvider = "CLAUDE" | "CODEX";

export type PermissionProfile = "READ_ONLY" | "WORKTREE_WRITE" | "TEST_ONLY";

export type WebAccessPolicy = "DISABLED" | "ASK_BEFORE_USE" | "ENABLED_FOR_TASK";

export type WebAccessDecision = {
  policy: WebAccessPolicy;
  permitted: boolean | null;
  decidedAt?: string;
  decidedBy?: "USER" | "SYSTEM";
};

export type AgentHealth = {
  provider: AgentProvider;
  available: boolean;
  authenticated: boolean | null;
  cliVersion: string | null;
  message?: string;
  capabilities: {
    structuredOutput: boolean;
    sessionResume: boolean;
    dynamicModelDiscovery: boolean;
    availableModels: string[] | null;
    availableEffortLevels: string[] | null;
  };
};

export type AgentRunInput = {
  runId: string;
  cwd: string;
  prompt: string;
  permissionProfile: PermissionProfile;
  webAccess: WebAccessDecision;
  sessionId?: string;
  outputFormat: "TEXT" | "JSON" | "JSONL";
  timeoutMs: number;
  environment: Record<string, string>;
  model: {
    requested: string;
    effort?: string;
  };
};

export type AgentRunMetadata = {
  provider: AgentProvider;
  requestedModel: string;
  actualModel: string | null;
  effort: string | null;
  cliVersion: string;
  promptVersion: string;
  webAccessPermitted: boolean;
};

export type AgentEvent =
  | { type: "started"; runId: string; occurredAt: string }
  | { type: "stdout"; runId: string; occurredAt: string; chunk: string }
  | { type: "stderr"; runId: string; occurredAt: string; chunk: string }
  | { type: "structured_output"; runId: string; occurredAt: string; value: unknown }
  | { type: "completed"; runId: string; occurredAt: string; exitCode: number; metadata: AgentRunMetadata }
  | { type: "failed"; runId: string; occurredAt: string; message: string; exitCode: number | null }
  | { type: "cancelled"; runId: string; occurredAt: string };

