import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
