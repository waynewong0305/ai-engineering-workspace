import type { AgentAdapter } from "./AgentAdapter.js";
import { firstLine, runCommand } from "./cli-utils.js";
import { JsonLineDecoder } from "./JsonLineDecoder.js";
import { ProcessSupervisor } from "./ProcessSupervisor.js";
import type { AgentEvent, AgentHealth, AgentRunInput } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractClaudeText(value: unknown): string | null {
  const event = asRecord(value);
  if (!event || event.type !== "assistant") return null;
  const message = asRecord(event.message);
  if (!Array.isArray(message?.content)) return null;
  const text = message.content.flatMap((block) => {
    const item = asRecord(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("");
  return text || null;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "CLAUDE" as const;

  constructor(
    private readonly supervisor = new ProcessSupervisor(),
    private readonly executable = "claude",
  ) {}

  async healthCheck(): Promise<AgentHealth> {
    const version = await runCommand(this.executable, ["--version"]);
    const available = version.exitCode === 0;
    const auth = available ? await runCommand(this.executable, ["auth", "status"]) : null;
    let authenticated = false;
    if (auth?.exitCode === 0) {
      try {
        authenticated = JSON.parse(auth.stdout).loggedIn === true;
      } catch {
        authenticated = false;
      }
    }
    return {
      provider: this.name,
      available,
      authenticated: available ? authenticated : null,
      cliVersion: available ? firstLine(version.stdout || version.stderr) : null,
      message: available && !authenticated ? "Run `claude auth login` in your terminal." : undefined,
      capabilities: {
        structuredOutput: available,
        sessionResume: available,
        dynamicModelDiscovery: false,
        availableModels: null,
        availableEffortLevels: available ? ["low", "medium", "high", "xhigh", "max"] : null,
      },
    };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    if (input.permissionProfile !== "READ_ONLY" && input.permissionProfile !== "WORKTREE_WRITE") {
      throw new Error("ClaudeAdapter supports READ_ONLY and WORKTREE_WRITE runs only.");
    }
    if (input.webAccess.permitted === null) throw new Error("A web-access decision is required before starting an agent run.");
    const health = await this.healthCheck();
    if (!health.available || !health.authenticated || !health.cliVersion) {
      throw new Error(health.message ?? "Claude Code is not ready.");
    }

    // WORKTREE_WRITE adds Edit/Write so the builder can change files, but deliberately never Bash —
    // the builder edits files; running commands is the separate, controlled TEST_ONLY validation
    // step (see ValidationRunner). `--restricted` (kept unconditional) already confines the file
    // tools to input.cwd, and `--permission-mode acceptEdits` auto-approves those edits since no
    // human is present to answer a prompt; `--permission-prompts none` still denies anything else
    // that would need a prompt (e.g. writes to git/settings/tool-configuration files).
    const baseTools = input.permissionProfile === "WORKTREE_WRITE" ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep";
    const tools = input.webAccess.permitted ? `${baseTools},WebSearch,WebFetch` : baseTools;
    const permissionMode = input.permissionProfile === "WORKTREE_WRITE" ? "acceptEdits" : "plan";
    const args = [
      "-p", input.prompt, "--output-format", "stream-json", "--verbose", "--restricted",
      "--tools", tools, "--permission-mode", permissionMode, "--permission-prompts", "none",
      "--strict-mcp-config", "--mcp-config", "{}", "--setting-sources", "", "--disable-slash-commands", "--no-chrome",
    ];
    if (input.sessionId) args.push("--resume", input.sessionId);
    else args.push("--no-session-persistence");
    if (input.model.requested && input.model.requested !== "(provider default)") args.push("--model", input.model.requested);
    if (input.model.effort) args.push("--effort", input.model.effort);

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
          const parsed = asRecord(value);
          const message = asRecord(parsed?.message);
          if (typeof message?.model === "string") actualModel = message.model;
          yield { type: "structured_output", runId: input.runId, occurredAt: event.occurredAt, value };
          const text = extractClaudeText(value);
          if (text) yield { type: "stdout", runId: input.runId, occurredAt: event.occurredAt, chunk: text };
        }
      } else if (event.type === "stderr") {
        yield { type: "stderr", runId: input.runId, occurredAt: event.occurredAt, chunk: event.chunk };
      } else {
        for (const value of decoder.flush()) {
          yield { type: "structured_output", runId: input.runId, occurredAt: event.occurredAt, value };
          const text = extractClaudeText(value);
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
