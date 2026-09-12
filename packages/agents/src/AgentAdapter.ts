import type { AgentEvent, AgentHealth, AgentProvider, AgentRunInput } from "./types.js";

export interface AgentAdapter {
  readonly name: AgentProvider;
  healthCheck(): Promise<AgentHealth>;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}

