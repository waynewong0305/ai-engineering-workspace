# ADR-0003: Use a provider-neutral agent contract

- Status: Accepted
- Date: 2026-09-13

## Context

Claude and Codex must be independently assignable as architect, builder, skeptic, or reviewer. Provider checks in workflow logic would couple those roles to CLI-specific flags and make future providers difficult to add.

## Decision

Workflow code will depend on `AgentAdapter`, `AgentRunInput`, and `AgentEvent`. CLI commands, authentication detection, model discovery, structured-output handling, and provider-specific cancellation remain inside adapter implementations.

Every run input carries an explicit permission profile, web-access decision, model request, working directory, output format, timeout, and sanitized environment. Completion metadata distinguishes requested and actual models.

## Consequences

Builder/reviewer roles can swap providers without workflow changes. Adapters must translate provider-specific output into the common event stream, and unsupported capabilities must be reported rather than silently emulated.

