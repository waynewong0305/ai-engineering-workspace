import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentEvent, AgentHealth, AgentProvider, AgentRunInput } from "@aiew/agents";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createTestRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-question-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return repositoryPath;
}

async function createTask(app: ReturnType<typeof buildApp>, title = "Question lifecycle fixture") {
  const project = (await app.inject({
    method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
  })).json();
  const task = (await app.inject({
    method: "POST", url: "/api/tasks",
    payload: {
      projectId: project.id, title, problemStatement: "Exercise the question lifecycle.",
      type: "BRAINSTORM", riskLevel: "LOW", webAccessPermitted: false,
    },
  })).json();
  return { project, task };
}

async function createQuestion(app: ReturnType<typeof buildApp>, taskId: string, content = "What is the current database-storage runway?") {
  const response = await app.inject({
    method: "POST", url: `/api/tasks/${taskId}/evidence`, payload: { type: "QUESTION", content },
  });
  return response.json();
}

async function getTask(app: ReturnType<typeof buildApp>, taskId: string) {
  return (await app.inject({ method: "GET", url: `/api/tasks/${taskId}` })).json();
}

describe("question lifecycle routes", () => {
  it("creates an OPEN question_details row for a QUESTION evidence item, with blank suggestions", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const question = await createQuestion(app, task.id);

    const detail = (await getTask(app, task.id)).questionDetails.find((d: { questionId: string }) => d.questionId === question.id);
    expect(detail).toMatchObject({
      status: "OPEN", whyItMatters: null, suggestedAction: null, expectedEvidence: null,
      suggestionSource: null, duplicateOfQuestionId: null, responses: [],
    });
  });

  it("creates question_details when an existing item is reclassified to QUESTION, and preserves it across reclassification", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const decision = (await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/evidence`, payload: { type: "DECISION", content: "Use versioned mapping." },
    })).json();

    const toQuestion = await app.inject({
      method: "PATCH", url: `/api/tasks/${task.id}/evidence/${decision.id}`, payload: { type: "QUESTION" },
    });
    expect(toQuestion.statusCode).toBe(200);
    let detail = (await getTask(app, task.id)).questionDetails.find((d: { questionId: string }) => d.questionId === decision.id);
    expect(detail.status).toBe("OPEN");

    await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${decision.id}/responses`, payload: { answer: "Resolved." },
    });
    await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/evidence/${decision.id}`, payload: { type: "DECISION" } });
    await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/evidence/${decision.id}`, payload: { type: "QUESTION" } });

    detail = (await getTask(app, task.id)).questionDetails.find((d: { questionId: string }) => d.questionId === decision.id);
    expect(detail.status).toBe("ANSWERED");
    expect(detail.responses).toHaveLength(1);
  });

  it("answers, reopens, defers, and marks a question not applicable, each affecting the open count and leaving a response history", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const q1 = await createQuestion(app, task.id, "What is the storage runway?");
    const q2 = await createQuestion(app, task.id, "What is the RTO/RPO target?");
    expect((await getTask(app, task.id)).openQuestionCount).toBe(2);

    const answered = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${q1.id}/responses`,
      payload: { answer: "Roughly six months at the current growth rate." },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({ status: "ANSWERED" });
    expect(answered.json().responses).toHaveLength(1);
    expect((await getTask(app, task.id)).openQuestionCount).toBe(1);

    const reopened = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/${q1.id}/reopen` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe("OPEN");
    expect(reopened.json().responses).toHaveLength(2);
    expect((await getTask(app, task.id)).openQuestionCount).toBe(2);

    const deferred = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${q1.id}/defer`, payload: { reason: "Waiting on the ops team." },
    });
    expect(deferred.statusCode).toBe(200);
    expect(deferred.json().status).toBe("DEFERRED");
    expect((await getTask(app, task.id)).openQuestionCount).toBe(1);

    const notApplicable = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/${q2.id}/mark-not-applicable` });
    expect(notApplicable.statusCode).toBe(200);
    expect(notApplicable.json().status).toBe("NOT_APPLICABLE");
    expect((await getTask(app, task.id)).openQuestionCount).toBe(0);
  });

  it("rejects acting on a non-open question without reopening first, and rejects reopening an already-open question", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const question = await createQuestion(app, task.id);

    const alreadyOpen = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/reopen` });
    expect(alreadyOpen.statusCode).toBe(400);

    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/defer` });
    const secondDefer = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/defer` });
    expect(secondDefer.statusCode).toBe(400);
    const answerWhileDeferred = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/responses`, payload: { answer: "Too late." },
    });
    expect(answerWhileDeferred.statusCode).toBe(400);
  });

  it("confirms and undoes a duplicate link, excluding the duplicate from the open count without double-counting", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const canonical = await createQuestion(app, task.id, "How many tenant databases exist?");
    const duplicate = await createQuestion(app, task.id, "How many tenants does the platform host?");
    expect((await getTask(app, task.id)).openQuestionCount).toBe(2);

    const confirmed = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${duplicate.id}/confirm-duplicate`,
      payload: { duplicateOfQuestionId: canonical.id },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "DUPLICATE", duplicateOfQuestionId: canonical.id });
    expect((await getTask(app, task.id)).openQuestionCount).toBe(1);

    const removed = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/questions/${duplicate.id}/duplicate-link` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ status: "OPEN", duplicateOfQuestionId: null });
    expect((await getTask(app, task.id)).openQuestionCount).toBe(2);
  });

  it("rejects a self-duplicate, a cross-task duplicate, and chaining a duplicate onto another duplicate", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task: taskA } = await createTask(app, "Task A");
    const { task: taskB } = await createTask(app, "Task B");
    const a1 = await createQuestion(app, taskA.id, "Question A1");
    const a2 = await createQuestion(app, taskA.id, "Question A2");
    const a3 = await createQuestion(app, taskA.id, "Question A3");
    const b1 = await createQuestion(app, taskB.id, "Question B1");

    const selfDuplicate = await app.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/questions/${a1.id}/confirm-duplicate`, payload: { duplicateOfQuestionId: a1.id },
    });
    expect(selfDuplicate.statusCode).toBe(400);

    const crossTask = await app.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/questions/${a1.id}/confirm-duplicate`, payload: { duplicateOfQuestionId: b1.id },
    });
    expect(crossTask.statusCode).toBe(400);

    await app.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/questions/${a2.id}/confirm-duplicate`, payload: { duplicateOfQuestionId: a1.id },
    });
    const chained = await app.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/questions/${a3.id}/confirm-duplicate`, payload: { duplicateOfQuestionId: a2.id },
    });
    expect(chained.statusCode).toBe(400);
  });

  it("404s for an unknown task, an unknown question, and a real evidence item that isn't type QUESTION", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const fact = (await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/evidence`, payload: { type: "FACT", content: "Not a question." },
    })).json();

    expect((await app.inject({ method: "POST", url: "/api/tasks/does-not-exist/questions/does-not-exist/reopen" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/does-not-exist/reopen` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/${fact.id}/reopen` })).statusCode).toBe(404);
  });

  it("reflects the corrected open count on GET /api/tasks as well as the task detail endpoint", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task, project } = await createTask(app);
    const question = await createQuestion(app, task.id);
    await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/responses`, payload: { answer: "Answered." },
    });

    const list = (await app.inject({ method: "GET", url: `/api/tasks?projectId=${project.id}` })).json();
    expect(list.find((t: { id: string }) => t.id === task.id).openQuestionCount).toBe(0);
  });

  it("cascades question_details and question_responses when the owning task is deleted", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const question = await createQuestion(app, task.id);
    await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/responses`, payload: { answer: "Answered before deletion." },
    });

    const deletion = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, payload: { confirm: true } });
    expect(deletion.statusCode).toBe(204);

    const reopenAfterDelete = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/reopen` });
    expect(reopenAfterDelete.statusCode).toBe(404);
  });
});

describe("free exact-match duplicate grouping", () => {
  it("groups only identically-normalized questions, keeps the earliest as canonical, and is idempotent", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const original = await createQuestion(app, task.id, "What is the current database-storage runway?");
    const nearIdentical = await createQuestion(app, task.id, "  what is the CURRENT database-storage runway???  ");
    const unique = await createQuestion(app, task.id, "What downtime is acceptable per tenant?");

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/group-exact-duplicates` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ groupedCount: 1 });

    const task2 = await getTask(app, task.id);
    const originalDetail = task2.questionDetails.find((d: { questionId: string }) => d.questionId === original.id);
    const nearIdenticalDetail = task2.questionDetails.find((d: { questionId: string }) => d.questionId === nearIdentical.id);
    const uniqueDetail = task2.questionDetails.find((d: { questionId: string }) => d.questionId === unique.id);
    expect(originalDetail.status).toBe("OPEN");
    expect(nearIdenticalDetail).toMatchObject({ status: "DUPLICATE", duplicateOfQuestionId: original.id });
    expect(uniqueDetail.status).toBe("OPEN");
    expect(task2.openQuestionCount).toBe(2);

    const again = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/group-exact-duplicates` });
    expect(again.json()).toEqual({ groupedCount: 0 });
  });

  it("404s for an unknown task", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/tasks/does-not-exist/questions/group-exact-duplicates" });
    expect(response.statusCode).toBe(404);
  });
});

describe("AI-judged possible-duplicate suggestions", () => {
  class FakeDuplicateDetectionAdapter implements AgentAdapter {
    constructor(readonly name: AgentProvider, private readonly response: unknown) {}
    async healthCheck(): Promise<AgentHealth> {
      return {
        provider: this.name, available: true, authenticated: true, cliVersion: `fake-${this.name.toLowerCase()} 1.0`,
        capabilities: { structuredOutput: true, sessionResume: false, dynamicModelDiscovery: false, availableModels: null, availableEffortLevels: null },
      };
    }
    async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
      const occurredAt = new Date().toISOString();
      yield { type: "started", runId: input.runId, occurredAt };
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: typeof this.response === "string" ? this.response : JSON.stringify(this.response) };
      yield {
        type: "completed", runId: input.runId, occurredAt, exitCode: 0,
        metadata: {
          provider: this.name, requestedModel: input.model.requested, actualModel: `fake-${this.name.toLowerCase()}`,
          effort: null, cliVersion: `fake-${this.name.toLowerCase()} 1.0`, promptVersion: input.promptVersion, webAccessPermitted: false,
        },
      };
    }
    async cancel() {}
  }

  async function waitForArtifact(app: ReturnType<typeof buildApp>, taskId: string, kind: string) {
    let task;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      task = await getTask(app, taskId);
      const artifact = task.artifacts.find((a: { kind: string }) => a.kind === kind);
      if (artifact) return artifact;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${kind} artifact never appeared.`);
  }

  it("produces a taskArtifacts row grouping the questions the fake model named, confirmable through the existing route", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeDuplicateDetectionAdapter("CLAUDE", { groups: [{ canonicalOrdinal: 1, duplicateOrdinals: [3] }] })],
    });
    apps.push(app);
    const { task } = await createTask(app);
    const q1 = await createQuestion(app, task.id, "What is the actual current infrastructure?");
    await createQuestion(app, task.id, "What downtime is acceptable per tenant?");
    const q3 = await createQuestion(app, task.id, "What database engine and hosting provider is in use?");

    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/detect-duplicates`, payload: { provider: "CLAUDE" },
    });
    expect(response.statusCode).toBe(202);

    const artifact = await waitForArtifact(app, task.id, "DUPLICATE_SUGGESTIONS");
    expect(artifact.parseError).toBeNull();
    expect(artifact.structuredData).toEqual({ groups: [{ canonicalQuestionId: q1.id, duplicateQuestionIds: [q3.id] }] });

    const confirm = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${q3.id}/confirm-duplicate`, payload: { duplicateOfQuestionId: q1.id },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ status: "DUPLICATE", duplicateOfQuestionId: q1.id });
  });

  it("fails cleanly on an out-of-range ordinal, leaving existing question state untouched", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeDuplicateDetectionAdapter("CLAUDE", { groups: [{ canonicalOrdinal: 1, duplicateOrdinals: [99] }] })],
    });
    apps.push(app);
    const { task } = await createTask(app);
    await createQuestion(app, task.id, "Question one.");
    await createQuestion(app, task.id, "Question two.");

    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/detect-duplicates`, payload: { provider: "CLAUDE" } });
    const artifact = await waitForArtifact(app, task.id, "DUPLICATE_SUGGESTIONS");
    expect(artifact.structuredData).toBeNull();
    expect(artifact.parseError).toBeTruthy();

    const after = await getTask(app, task.id);
    expect(after.openQuestionCount).toBe(2);
    expect(after.questionDetails.every((d: { status: string }) => d.status === "OPEN")).toBe(true);
  });

  it("400s an invalid provider and 404s an unknown task", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const invalidProvider = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/detect-duplicates`, payload: { provider: "GPT4" },
    });
    expect(invalidProvider.statusCode).toBe(400);
    const unknownTask = await app.inject({
      method: "POST", url: "/api/tasks/does-not-exist/questions/detect-duplicates", payload: { provider: "CLAUDE" },
    });
    expect(unknownTask.statusCode).toBe(404);
  });
});

describe("legacy question suggestion generation and acceptance", () => {
  class FakeSuggestionAdapter implements AgentAdapter {
    constructor(readonly name: AgentProvider, private readonly response: unknown) {}
    async healthCheck(): Promise<AgentHealth> {
      return {
        provider: this.name, available: true, authenticated: true, cliVersion: `fake-${this.name.toLowerCase()} 1.0`,
        capabilities: { structuredOutput: true, sessionResume: false, dynamicModelDiscovery: false, availableModels: null, availableEffortLevels: null },
      };
    }
    async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
      const occurredAt = new Date().toISOString();
      yield { type: "started", runId: input.runId, occurredAt };
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: typeof this.response === "string" ? this.response : JSON.stringify(this.response) };
      yield {
        type: "completed", runId: input.runId, occurredAt, exitCode: 0,
        metadata: {
          provider: this.name, requestedModel: input.model.requested, actualModel: `fake-${this.name.toLowerCase()}`,
          effort: null, cliVersion: `fake-${this.name.toLowerCase()} 1.0`, promptVersion: input.promptVersion, webAccessPermitted: false,
        },
      };
    }
    async cancel() {}
  }

  function suggestion(overrides: Partial<{
    questionId: string; priority: string; whyItMatters: string; suggestedAction: string; expectedEvidence: string[]; suggestedAnswers: string[];
  }> = {}) {
    return {
      questionId: "placeholder", priority: "MEDIUM", whyItMatters: "It affects the migration plan.",
      suggestedAction: "Ask the platform team.", expectedEvidence: ["A written answer from the platform team."], suggestedAnswers: [],
      ...overrides,
    };
  }

  it("generates a preview for every question missing suggestions, persisting an audit artifact without touching question_details", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeSuggestionAdapter("CLAUDE", {
        suggestions: [
          { ordinal: 1, priority: "HIGH", whyItMatters: "Blocks sizing.", suggestedAction: "Check the infra dashboard.", expectedEvidence: ["Dashboard screenshot."], suggestedAnswers: ["AWS RDS"] },
          { ordinal: 2, priority: "LOW", whyItMatters: "Minor cost impact.", suggestedAction: "Ask finance.", expectedEvidence: [], suggestedAnswers: [] },
        ],
      })],
    });
    apps.push(app);
    const { task } = await createTask(app);
    const q1 = await createQuestion(app, task.id, "What database engine is in use?");
    const q2 = await createQuestion(app, task.id, "What is the monthly hosting cost?");

    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/generate-suggestions`, payload: { provider: "CLAUDE" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionId: q1.id, priority: "HIGH" }),
      expect.objectContaining({ questionId: q2.id, priority: "LOW" }),
    ]));

    const withArtifacts = await getTask(app, task.id);
    const artifact = withArtifacts.artifacts.find((a: { kind: string }) => a.kind === "QUESTION_SUGGESTIONS");
    expect(artifact).toBeTruthy();
    expect(artifact.parseError).toBeNull();
    const detail1 = withArtifacts.questionDetails.find((d: { questionId: string }) => d.questionId === q1.id);
    expect(detail1.whyItMatters).toBeNull();
  });

  it("fails cleanly with a 502 and a parseError artifact when the model omits a question it was asked about", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeSuggestionAdapter("CLAUDE", {
        suggestions: [{ ordinal: 1, priority: "HIGH", whyItMatters: "Blocks sizing.", suggestedAction: "Check the infra dashboard.", expectedEvidence: [], suggestedAnswers: [] }],
      })],
    });
    apps.push(app);
    const { task } = await createTask(app);
    await createQuestion(app, task.id, "Question one.");
    await createQuestion(app, task.id, "Question two.");

    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/generate-suggestions`, payload: { provider: "CLAUDE" },
    });
    expect(response.statusCode).toBe(502);

    const withArtifacts = await getTask(app, task.id);
    const artifact = withArtifacts.artifacts.find((a: { kind: string }) => a.kind === "QUESTION_SUGGESTIONS");
    expect(artifact.structuredData).toBeNull();
    expect(artifact.parseError).toBeTruthy();
  });

  it("400s an invalid provider and 404s an unknown task for generate-suggestions", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const invalidProvider = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/generate-suggestions`, payload: { provider: "GPT4" },
    });
    expect(invalidProvider.statusCode).toBe(400);
    const unknownTask = await app.inject({
      method: "POST", url: "/api/tasks/does-not-exist/questions/generate-suggestions", payload: { provider: "CLAUDE" },
    });
    expect(unknownTask.statusCode).toBe(404);
  });

  it("accepts submitted suggestions into question_details, attributed to HUMAN", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const q1 = await createQuestion(app, task.id);
    const q2 = await createQuestion(app, task.id, "A second question.");

    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/accept-suggestions`,
      payload: { suggestions: [suggestion({ questionId: q1.id }), suggestion({ questionId: q2.id, priority: "BLOCKING" })] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ acceptedCount: 2, skippedCount: 0 });

    const withDetails = await getTask(app, task.id);
    const detail1 = withDetails.questionDetails.find((d: { questionId: string }) => d.questionId === q1.id);
    expect(detail1).toMatchObject({
      whyItMatters: "It affects the migration plan.", suggestedAction: "Ask the platform team.", suggestionSource: "HUMAN", priority: "MEDIUM",
    });
    const detail2 = withDetails.questionDetails.find((d: { questionId: string }) => d.questionId === q2.id);
    expect(detail2.priority).toBe("BLOCKING");
  });

  it("never overwrites a question that already has suggestions, and rejects a questionId from a different task", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task: taskA } = await createTask(app, "Task A");
    const { task: taskB } = await createTask(app, "Task B");
    const question = await createQuestion(app, taskA.id);
    const otherTaskQuestion = await createQuestion(app, taskB.id);

    const first = await app.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/questions/accept-suggestions`,
      payload: { suggestions: [suggestion({ questionId: question.id })] },
    });
    expect(first.json()).toEqual({ acceptedCount: 1, skippedCount: 0 });

    const resubmit = await app.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/questions/accept-suggestions`,
      payload: { suggestions: [suggestion({ questionId: question.id, whyItMatters: "A completely different reason." })] },
    });
    expect(resubmit.json()).toEqual({ acceptedCount: 0, skippedCount: 1 });
    const afterResubmit = await getTask(app, taskA.id);
    expect(afterResubmit.questionDetails.find((d: { questionId: string }) => d.questionId === question.id).whyItMatters)
      .toBe("It affects the migration plan.");

    const crossTask = await app.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/questions/accept-suggestions`,
      payload: { suggestions: [suggestion({ questionId: otherTaskQuestion.id })] },
    });
    expect(crossTask.statusCode).toBe(400);
  });

  it("400s an empty suggestions array and 404s an unknown task for accept-suggestions", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const { task } = await createTask(app);
    const empty = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/questions/accept-suggestions`, payload: { suggestions: [] } });
    expect(empty.statusCode).toBe(400);
    const unknownTask = await app.inject({
      method: "POST", url: "/api/tasks/does-not-exist/questions/accept-suggestions", payload: { suggestions: [suggestion({ questionId: "x" })] },
    });
    expect(unknownTask.statusCode).toBe(404);
  });
});
