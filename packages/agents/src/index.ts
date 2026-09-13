export type { AgentAdapter } from "./AgentAdapter.js";
export { ClaudeAdapter } from "./ClaudeAdapter.js";
export { CodexAdapter } from "./CodexAdapter.js";
export { UnsafeEnvironmentError, sanitizeEnvironment } from "./environment.js";
export { classifyAgentFailure, modelSubstitutionFailure } from "./failure-classification.js";
export type { ClassifiedAgentFailure } from "./failure-classification.js";
export { ProcessSupervisor } from "./ProcessSupervisor.js";
export type { SupervisedProcessEvent, SupervisedProcessInput } from "./ProcessSupervisor.js";
export type {
  AgentEvent,
  AgentFailureKind,
  AgentHealth,
  AgentProvider,
  AgentRunInput,
  AgentRunMetadata,
  PermissionProfile,
  WebAccessDecision,
  WebAccessPolicy,
} from "./types.js";
