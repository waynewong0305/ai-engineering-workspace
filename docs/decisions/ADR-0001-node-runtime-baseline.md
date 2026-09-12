# ADR-0001: Require Node.js 22 or newer

- Status: Accepted
- Date: 2026-09-13

## Context

The discovered shell runtime is Node.js 16.20.2. The selected Vue/Vite and Fastify generation requires a maintained modern Node runtime. Building around Node 16 would force old dependencies into a new security-sensitive orchestration tool.

## Decision

The repository declares Node.js 22 or newer and includes `.nvmrc` with major version 22. This session may use the Codex app's bundled Node 24 runtime for verification, but the application does not modify the user's Node installation.

## Consequences

Normal local development requires selecting or installing Node 22+. Dependency versions may use modern platform APIs. The user must resolve this prerequisite before relying on the normal `npm run dev` command in a fresh terminal.

