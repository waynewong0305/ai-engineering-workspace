import type { AgentAdapter } from "./AgentAdapter.js";
import { firstLine, runCommand } from "./cli-utils.js";
import { JsonLineDecoder } from "./JsonLineDecoder.js";
import { ProcessSupervisor } from "./ProcessSupervisor.js";
import type { AgentEvent, AgentHealth, AgentRunInput } from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractText(value: unknown): string | null {
  const event = record(value);
  if (!event || event.type !== "item.completed") return null;
  const item = record(event.item);
  return item?.type === "agent_message" && typeof item.text === "string" ? item.text : null;
}

function extractModel(value: unknown): string | null {
  const event = record(value);
  if (!event) return null;
  if (typeof event.model === "string") return event.model;
  const thread = record(event.thread);
  return typeof thread?.model === "string" ? thread.model : null;
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "CODEX" as const;

  constructor(
    private readonly supervisor = new ProcessSupervisor(),
    private readonly executable = "codex",
  ) {}

  async healthCheck(): Promise<AgentHealth> {
    const version = await runCommand(this.executable, ["--version"]);
    const available = version.exitCode === 0;
    const login = available ? await runCommand(this.executable, ["login", "status"]) : null;
    return {
      provider: this.name,
      available,
      authenticated: available ? login?.exitCode === 0 : null,
      cliVersion: available ? firstLine(version.stdout || version.stderr) : null,
      message: available && login?.exitCode !== 0 ? "Codex authentication is required." : undefined,
      capabilities: {
        structuredOutput: available,
        sessionResume: available,
        dynamicModelDiscovery: false,
        availableModels: null,
        availableEffortLevels: null,
      },
    };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    if (input.permissionProfile !== "READ_ONLY" && input.permissionProfile !== "WORKTREE_WRITE") {
      throw new Error("CodexAdapter supports READ_ONLY and WORKTREE_WRITE runs only.");
    }
    if (input.webAccess.permitted === null) throw new Error("A web-access decision is required before starting an agent run.");
    if (input.model.effort) throw new Error("The installed Codex CLI does not expose a supported effort flag.");

    const health = await this.healthCheck();
    if (!health.available || !health.authenticated || !health.cliVersion) {
      throw new Error(health.message ?? "Codex CLI is not ready.");
    }

    // WORKTREE_WRITE switches the sandbox to workspace-write (Codex's own OS-level write
    // confinement to the working directory, stronger than anything this adapter can enforce) and
    // routes approval requests through Codex's own automatic review because no human is present to
    // answer an interactive prompt. These flags were re-verified against the installed Codex CLI
    // during Phase 7; its earlier `--ask-for-approval never` spelling is no longer supported.
    const sandbox = input.permissionProfile === "WORKTREE_WRITE" ? "workspace-write" : "read-only";
    const args = [
      "exec", "--json", "--color", "never", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "-C", input.cwd, "-s", sandbox,
      "--disable", "computer_use", "--disable", "apps", "--disable", "plugins",
    ];
    if (input.permissionProfile === "WORKTREE_WRITE") args.push("--approve-for-me");
    if (!input.webAccess.permitted) args.push("--disable", "browser_use", "--disable", "browser_use_external");
    if (input.model.requested && input.model.requested !== "(provider default)") {
      args.push("-m", input.model.requested);
    }
    args.push(input.prompt);

    const decoder = new JsonLineDecoder();
    let actualModel: string | null = null;
    for await (const event of this.supervisor.run({
      runId: input.runId,
      command: this.executable,
      args,
      cwd: input.cwd,
      permissionProfile: input.permissionProfile,
      environment: input.environment,
      timeoutMs: input.timeoutMs,
    })) {
      if (event.type === "started") {
        yield { type: "started", runId: input.runId, occurredAt: event.occurredAt };
      } else if (event.type === "stdout") {
        for (const value of decoder.push(event.chunk)) {
          actualModel = extractModel(value) ?? actualModel;
          yield { type: "structured_output", runId: input.runId, occurredAt: event.occurredAt, value };
          const text = extractText(value);
          if (text) yield { type: "stdout", runId: input.runId, occurredAt: event.occurredAt, chunk: text };
        }
      } else if (event.type === "stderr") {
        yield { type: "stderr", runId: input.runId, occurredAt: event.occurredAt, chunk: event.chunk };
      } else {
        for (const value of decoder.flush()) {
          yield { type: "structured_output", runId: input.runId, occurredAt: event.occurredAt, value };
          const text = extractText(value);
          if (text) yield { type: "stdout", runId: input.runId, occurredAt: event.occurredAt, chunk: text };
        }
        if (event.type === "exited") {
          yield {
            type: "completed", runId: input.runId, occurredAt: event.occurredAt, exitCode: event.exitCode,
            metadata: {
              provider: this.name,
              requestedModel: input.model.requested,
              actualModel,
              effort: input.model.effort ?? null,
              cliVersion: health.cliVersion,
              promptVersion: input.promptVersion,
              webAccessPermitted: input.webAccess.permitted,
            },
          };
        } else if (event.type === "cancelled") {
          yield { type: "cancelled", runId: input.runId, occurredAt: event.occurredAt };
        } else {
          const message = event.type === "timed_out" ? `Agent run timed out after ${input.timeoutMs} ms.` : event.message;
          yield { type: "failed", runId: input.runId, occurredAt: event.occurredAt, message, exitCode: event.type === "failed" ? event.exitCode : null };
        }
      }
    }
  }

  cancel(runId: string): Promise<void> {
    return this.supervisor.cancel(runId);
  }
}
