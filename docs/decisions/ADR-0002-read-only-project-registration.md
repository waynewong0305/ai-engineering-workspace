# ADR-0002: Keep project registration read-only

- Status: Accepted
- Date: 2026-09-13

## Context

Registering an existing repository is the application's first contact with user source code. Creating directories, branches, worktrees, or executing configured validation commands at this point would exceed the user's intent and make onboarding risky.

## Decision

Registration performs only filesystem metadata reads and Git inspection commands. It canonicalizes the path, validates a working tree, reads branch and status information, suggests a worktree root, and stores settings in the workspace's own SQLite database. It does not create the suggested directory or execute user commands.

## Consequences

Registration is safe for dirty repositories and cannot accidentally trigger project code. Worktree creation and validation execution require later explicit workflows with their own permissions and safety checks.

