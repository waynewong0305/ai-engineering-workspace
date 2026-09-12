<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";

type ToolHealth = {
  available: boolean;
  version: string | null;
  authenticated?: boolean | null;
};

type HealthResponse = {
  status: "ok";
  database: "connected" | "unavailable";
  tools: {
    git: ToolHealth;
    claude: ToolHealth;
    codex: ToolHealth;
  };
};

type ValidationCommand = { id: string; label: string; command: string };

type Project = {
  id: string;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  currentBranch: string;
  worktreeRoot: string;
  projectContext: string | null;
  validationCommands: ValidationCommand[];
  gitStatus: "CLEAN" | "DIRTY";
  updatedAt: string;
};

type AgentProvider = "CLAUDE" | "CODEX";
type AgentHealth = {
  provider: AgentProvider;
  available: boolean;
  authenticated: boolean | null;
  cliVersion: string | null;
  message?: string;
  capabilities: { availableModels: string[] | null; availableEffortLevels: string[] | null };
};
type AgentRun = {
  id: string;
  projectId: string;
  provider: AgentProvider;
  requestedModel: string;
  actualModel: string | null;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  output: string;
  errorOutput: string;
  errorMessage: string | null;
  durationMs: number | null;
};

const health = ref<HealthResponse | null>(null);
const loading = ref(true);
const healthError = ref("");
const projects = ref<Project[]>([]);
const projectsLoading = ref(true);
const submitError = ref("");
const successMessage = ref("");
const submitting = ref(false);
const agentHealth = ref<Partial<Record<AgentProvider, AgentHealth>>>({});
const selectedProjectId = ref("");
const selectedProvider = ref<AgentProvider>("CODEX");
const agentPrompt = ref("Explain this repository at a high level. Focus on its purpose, architecture, and main entry points.");
const agentModel = ref("");
const agentEffort = ref("");
const runError = ref("");
const startingRun = ref(false);
const currentRun = ref<AgentRun | null>(null);
let eventSource: EventSource | null = null;
const form = reactive({
  name: "",
  repositoryPath: "",
  defaultBranch: "",
  worktreeRoot: "",
  projectContext: "",
  tests: "",
  lint: "",
  build: "",
});

const connectedCount = computed(() => {
  if (!health.value) return 0;
  return Object.values(health.value.tools).filter((tool) => tool.available).length;
});

async function loadHealth() {
  loading.value = true;
  healthError.value = "";
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`Health check failed (${response.status})`);
    health.value = await response.json();
  } catch (error) {
    healthError.value = error instanceof Error ? error.message : "Health check failed";
  } finally {
    loading.value = false;
  }
}

async function loadProjects() {
  projectsLoading.value = true;
  try {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error("Could not load projects.");
    projects.value = await response.json();
    if (!selectedProjectId.value && projects.value[0]) selectedProjectId.value = projects.value[0].id;
  } finally {
    projectsLoading.value = false;
  }
}

async function loadAgentHealth() {
  try {
    const response = await fetch("/api/agents/health");
    if (response.ok) agentHealth.value = await response.json();
  } catch {
    agentHealth.value = {};
  }
}

async function recheckTools() {
  await Promise.all([loadHealth(), loadAgentHealth()]);
}

async function refreshRun(runId: string) {
  const response = await fetch(`/api/agent-runs/${runId}`);
  if (response.ok) currentRun.value = await response.json();
}

function streamRun(runId: string) {
  eventSource?.close();
  eventSource = new EventSource(`/api/agent-runs/${runId}/events`);
  for (const type of ["started", "stdout", "stderr", "completed", "failed", "cancelled"]) {
    eventSource.addEventListener(type, async (message) => {
      const event = JSON.parse((message as MessageEvent).data);
      const payload = event.payload ?? {};
      if (type === "started" && currentRun.value) currentRun.value.status = "RUNNING";
      if (type === "stdout" && currentRun.value) currentRun.value.output += payload.chunk ?? "";
      if (type === "stderr" && currentRun.value) currentRun.value.errorOutput += payload.chunk ?? "";
      if (["completed", "failed", "cancelled"].includes(type)) {
        await refreshRun(runId);
        eventSource?.close();
        eventSource = null;
      }
    });
  }
  eventSource.onerror = () => {
    if (currentRun.value && ["QUEUED", "RUNNING"].includes(currentRun.value.status)) void refreshRun(runId);
  };
}

async function startAgentRun() {
  startingRun.value = true;
  runError.value = "";
  currentRun.value = null;
  try {
    const response = await fetch("/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: selectedProjectId.value,
        provider: selectedProvider.value,
        prompt: agentPrompt.value,
        model: agentModel.value,
        effort: agentEffort.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not start the agent run.");
    currentRun.value = result;
    streamRun(result.id);
  } catch (error) {
    runError.value = error instanceof Error ? error.message : "Could not start the agent run.";
  } finally {
    startingRun.value = false;
  }
}

async function cancelAgentRun() {
  if (!currentRun.value) return;
  const response = await fetch(`/api/agent-runs/${currentRun.value.id}/cancel`, { method: "POST" });
  if (!response.ok) {
    const result = await response.json();
    runError.value = result.message ?? "Could not cancel the run.";
  }
}

async function registerProject() {
  submitting.value = true;
  submitError.value = "";
  successMessage.value = "";
  const validationCommands = [
    { label: "Tests", command: form.tests.trim() },
    { label: "Lint", command: form.lint.trim() },
    { label: "Build", command: form.build.trim() },
  ].filter((item) => item.command);

  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        repositoryPath: form.repositoryPath,
        defaultBranch: form.defaultBranch,
        worktreeRoot: form.worktreeRoot,
        projectContext: form.projectContext,
        validationCommands,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Project registration failed.");
    projects.value.unshift(result);
    successMessage.value = `${result.name} was registered without modifying the repository.`;
    Object.assign(form, {
      name: "",
      repositoryPath: "",
      defaultBranch: "",
      worktreeRoot: "",
      projectContext: "",
      tests: "",
      lint: "",
      build: "",
    });
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : "Project registration failed.";
  } finally {
    submitting.value = false;
  }
}

async function recheckProject(project: Project) {
  const response = await fetch(`/api/projects/${project.id}/recheck`, { method: "POST" });
  const result = await response.json();
  if (response.ok) Object.assign(project, result);
}

onMounted(() => Promise.all([loadHealth(), loadProjects(), loadAgentHealth()]));
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">AE</div>
        <div>
          <strong>AI Engineering</strong>
          <span>Workspace</span>
        </div>
      </div>

      <nav aria-label="Main navigation">
        <p class="nav-label">Workspace</p>
        <a class="nav-item active" href="#projects"><span>01</span>Projects</a>
        <a class="nav-item" href="#agent-runs"><span>02</span>Agent runs</a>
        <a class="nav-item disabled" href="#brainstorm" aria-disabled="true"><span>03</span>Brainstorm</a>
        <a class="nav-item disabled" href="#architecture" aria-disabled="true"><span>04</span>Architecture</a>
        <a class="nav-item disabled" href="#build" aria-disabled="true"><span>05</span>Build</a>
        <a class="nav-item disabled" href="#reviews" aria-disabled="true"><span>06</span>Reviews</a>
        <a class="nav-item disabled" href="#decisions" aria-disabled="true"><span>07</span>Decisions</a>
      </nav>

      <div class="sidebar-foot">
        <span class="local-dot" aria-hidden="true"></span>
        Local only
        <small>Nothing is deployed</small>
      </div>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <p class="eyebrow">SYSTEM / PROJECTS</p>
          <h1>Engineering control room</h1>
        </div>
        <button class="ghost-button" type="button" @click="recheckTools">Recheck tools</button>
      </header>

      <section class="intro-grid" aria-labelledby="workspace-heading">
        <div class="intro-copy">
          <p class="section-index">01 — PROJECT REGISTRATION</p>
          <h2 id="workspace-heading">Bring a repository into a safer AI workflow.</h2>
          <p>
            Register a local Git project without changing it. This workspace will keep agent runs,
            evidence, and future worktrees isolated and auditable.
          </p>
        </div>
        <div class="readiness-card">
          <span>Local readiness</span>
          <strong>{{ loading ? "Checking…" : `${connectedCount}/3 tools found` }}</strong>
          <p v-if="healthError" class="error-text">{{ healthError }}</p>
          <p v-else>Database {{ health?.database ?? "checking" }} · Web access asks first</p>
        </div>
      </section>

      <section class="tool-grid" aria-label="Local tool status">
        <article v-for="(tool, name) in health?.tools" :key="name" class="tool-card">
          <div>
            <span :class="['status-light', tool.available ? 'ok' : 'missing']"></span>
            <strong>{{ name === "claude" ? "Claude Code" : name === "codex" ? "Codex" : "Git" }}</strong>
          </div>
          <p>{{ tool.available ? tool.version : "Not available" }}</p>
          <small v-if="(name === 'codex' || name === 'claude') && tool.authenticated === true">Authenticated locally</small>
          <small v-else-if="(name === 'codex' || name === 'claude') && tool.available && tool.authenticated === false">Authentication required</small>
          <small v-else-if="name === 'claude' && !tool.available">Install before agent integration</small>
        </article>
        <article v-if="loading" v-for="index in 3" :key="`loading-${index}`" class="tool-card skeleton"></article>
      </section>

      <section id="projects" class="project-panel">
        <div class="panel-heading">
          <div>
            <p class="section-index">PROJECTS / LOCAL REPOSITORIES</p>
            <h2>Register a project</h2>
            <p>The repository is inspected read-only. No branch, worktree, or command is created or run.</p>
          </div>
          <span class="safety-badge">READ ONLY</span>
        </div>

        <form class="project-form" @submit.prevent="registerProject">
          <label>
            <span>Repository path <strong>Required</strong></span>
            <input v-model="form.repositoryPath" required placeholder="/Users/you/Projects/example" autocomplete="off" />
          </label>
          <label>
            <span>Project name <small>Uses folder name when blank</small></span>
            <input v-model="form.name" placeholder="Example Web" autocomplete="off" />
          </label>
          <div class="field-row">
            <label>
              <span>Default branch <small>Auto-detect</small></span>
              <input v-model="form.defaultBranch" placeholder="main" autocomplete="off" />
            </label>
            <label>
              <span>Worktree root <small>Suggested when blank</small></span>
              <input v-model="form.worktreeRoot" placeholder="/Users/you/Projects/.ai-worktrees/example" autocomplete="off" />
            </label>
          </div>
          <label>
            <span>Project context <small>Optional guidance for future agent runs</small></span>
            <textarea v-model="form.projectContext" rows="3" placeholder="Architecture notes, conventions, important boundaries…"></textarea>
          </label>

          <fieldset>
            <legend>Validation commands <small>Stored only; not run during registration</small></legend>
            <div class="command-grid">
              <label><span>Tests</span><input v-model="form.tests" placeholder="npm test" autocomplete="off" /></label>
              <label><span>Lint</span><input v-model="form.lint" placeholder="npm run lint" autocomplete="off" /></label>
              <label><span>Build</span><input v-model="form.build" placeholder="npm run build" autocomplete="off" /></label>
            </div>
          </fieldset>

          <p v-if="submitError" class="form-message error-text" role="alert">{{ submitError }}</p>
          <p v-if="successMessage" class="form-message success-text" role="status">{{ successMessage }}</p>
          <div class="form-actions">
            <span>Web access defaults to <b>Ask before use</b> for future tasks.</span>
            <button class="primary-button" type="submit" :disabled="submitting">
              {{ submitting ? "Inspecting…" : "Inspect & register" }}
            </button>
          </div>
        </form>
      </section>

      <section class="registered-section" aria-labelledby="registered-heading">
        <div class="registered-heading">
          <div>
            <p class="section-index">REGISTERED</p>
            <h2 id="registered-heading">Local projects</h2>
          </div>
          <span>{{ projects.length }} total</span>
        </div>

        <div v-if="projectsLoading" class="empty-state">Loading registered projects…</div>
        <div v-else-if="projects.length === 0" class="empty-state">
          <strong>No projects registered yet.</strong>
          <span>Add a Git repository above. The source directory will remain untouched.</span>
        </div>
        <div v-else class="project-list">
          <article v-for="project in projects" :key="project.id" class="project-row">
            <div class="project-main">
              <div class="project-title-line">
                <strong>{{ project.name }}</strong>
                <span :class="['repo-state', project.gitStatus.toLowerCase()]">{{ project.gitStatus }}</span>
              </div>
              <code>{{ project.repositoryPath }}</code>
              <p v-if="project.projectContext">{{ project.projectContext }}</p>
            </div>
            <dl>
              <div><dt>Current branch</dt><dd>{{ project.currentBranch }}</dd></div>
              <div><dt>Default branch</dt><dd>{{ project.defaultBranch }}</dd></div>
              <div><dt>Checks saved</dt><dd>{{ project.validationCommands.length }}</dd></div>
            </dl>
            <button class="ghost-button" type="button" @click="recheckProject(project)">Recheck Git</button>
          </article>
        </div>
      </section>

      <section id="agent-runs" class="project-panel agent-panel" aria-labelledby="agent-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">02 — READ-ONLY AGENT RUN</p>
            <h2 id="agent-heading">Ask an agent to explain a repository.</h2>
            <p>The run cannot edit files and web access is disabled. Starting it may use provider credits.</p>
          </div>
          <span class="safety-badge">READ ONLY · NO WEB</span>
        </div>

        <form class="project-form" @submit.prevent="startAgentRun">
          <div class="field-row">
            <label>
              <span>Registered project</span>
              <select v-model="selectedProjectId" required>
                <option disabled value="">Select a project</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>
            <label>
              <span>Provider</span>
              <select v-model="selectedProvider">
                <option value="CODEX">Codex</option>
                <option value="CLAUDE">Claude Code</option>
              </select>
            </label>
          </div>
          <div class="provider-readiness">
            <span :class="['status-light', agentHealth[selectedProvider]?.authenticated ? 'ok' : 'missing']"></span>
            <strong>{{ selectedProvider === "CODEX" ? "Codex" : "Claude Code" }}</strong>
            <span v-if="agentHealth[selectedProvider]?.authenticated">Ready · {{ agentHealth[selectedProvider]?.cliVersion }}</span>
            <span v-else>{{ agentHealth[selectedProvider]?.message ?? "Provider is not ready." }}</span>
          </div>
          <label>
            <span>Prompt</span>
            <textarea v-model="agentPrompt" rows="4" required maxlength="20000"></textarea>
          </label>
          <div class="field-row">
            <label>
              <span>Model <small>Blank uses provider default</small></span>
              <input v-model="agentModel" placeholder="Provider default" autocomplete="off" />
            </label>
            <label>
              <span>Effort <small>Optional</small></span>
              <select v-model="agentEffort">
                <option value="">Provider default</option>
                <option v-for="effort in agentHealth[selectedProvider]?.capabilities.availableEffortLevels ?? []" :key="effort" :value="effort">{{ effort }}</option>
              </select>
            </label>
          </div>
          <p v-if="runError" class="form-message error-text" role="alert">{{ runError }}</p>
          <div class="form-actions">
            <span>Nothing runs until you select this button. Output and run metadata are stored locally.</span>
            <button class="primary-button" type="submit" :disabled="startingRun || !selectedProjectId || !agentHealth[selectedProvider]?.authenticated">
              {{ startingRun ? "Starting…" : "Run explanation" }}
            </button>
          </div>
        </form>

        <article v-if="currentRun" class="run-console" aria-live="polite">
          <div class="run-console-heading">
            <div><span>RUN STATUS</span><strong>{{ currentRun.status }}</strong></div>
            <button v-if="['QUEUED', 'RUNNING'].includes(currentRun.status)" class="ghost-button" type="button" @click="cancelAgentRun">Cancel</button>
          </div>
          <pre v-if="currentRun.output">{{ currentRun.output }}</pre>
          <p v-else-if="['QUEUED', 'RUNNING'].includes(currentRun.status)">Waiting for agent output…</p>
          <p v-if="currentRun.errorMessage" class="error-text">{{ currentRun.errorMessage }}</p>
          <details v-if="currentRun.errorOutput"><summary>Process messages</summary><pre>{{ currentRun.errorOutput }}</pre></details>
          <small v-if="currentRun.durationMs !== null">Completed in {{ (currentRun.durationMs / 1000).toFixed(1) }}s</small>
        </article>
      </section>
    </main>
  </div>
</template>
