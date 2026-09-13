# AI Engineering Workspace

AI Engineering Workspace is a local-only application for coordinating independent Claude Code and Codex engineering workflows against local Git repositories.

The current increment includes the application shell, local tool health checks, SQLite persistence, safe project registration, explicit read-only Claude Code/Codex runs, and persisted brainstorm/architecture tasks with independent analysis, reciprocal cross-review, comparison, and an evidence board. It does not yet create worktrees or run implementation workflows.

## Quick start

Use Node.js 22 or newer. The repository includes an `.nvmrc` file.

```bash
nvm use
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Stop both development processes with `Ctrl+C`.

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

See [USER_GUIDE.md](./USER_GUIDE.md) for product usage, [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) for internals, and [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) for current scope.
