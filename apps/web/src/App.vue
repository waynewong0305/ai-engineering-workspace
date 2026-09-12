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

const health = ref<HealthResponse | null>(null);
const loading = ref(true);
const healthError = ref("");
const projects = ref<Project[]>([]);
const projectsLoading = ref(true);
const submitError = ref("");
const successMessage = ref("");
const submitting = ref(false);
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
  } finally {
    projectsLoading.value = false;
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

onMounted(() => Promise.all([loadHealth(), loadProjects()]));
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
        <a class="nav-item disabled" href="#tasks" aria-disabled="true"><span>02</span>Tasks <em>Soon</em></a>
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
        <button class="ghost-button" type="button" @click="loadHealth">Recheck tools</button>
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
          <small v-if="name === 'codex' && tool.authenticated === true">Authenticated locally</small>
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
    </main>
  </div>
</template>
