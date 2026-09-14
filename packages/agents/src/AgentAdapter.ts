import type { AgentEvent, AgentHealth, AgentProvider, AgentRunInput } from "./types.js";
import type { RateLimitWindowReading } from "./usage-extraction.js";

export interface AgentAdapter {
  readonly name: AgentProvider;
  /** True when calling `readUsage` spends real provider usage (no free/side-channel reader exists). */
  readonly spendsProviderUsageToRead?: boolean;
  healthCheck(): Promise<AgentHealth>;
  readUsage?(): Promise<RateLimitWindowReading[]>;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
