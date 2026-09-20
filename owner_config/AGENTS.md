# Repository Agent Guide

## Project Overview

`owner_config` centrally manages local configuration files for projects under the
parent code directory. The implementation uses Node.js 22 and TypeScript.

Key paths:

- `src/core.ts`: project loading and filesystem operations.
- `src/merge.ts`: YAML, JSON, and INI merge behavior.
- `src/server.ts` and `web/`: HTTP API and browser UI.
- `data/projects.yaml`: managed projects, paths, files, and grouping metadata.
- `data/projects/<name>--<id>/baseline/`: snapshots copied from target projects.
- `data/projects/<name>--<id>/local/<environment>/`: local overrides applied on top of baselines.
- `tests/`: Node test suite for core operations, merging, and the HTTP API.

## Code Navigation

This repository is indexed by CodeGraph. When `.codegraph/` exists, use
`codegraph explore "<question or symbol>"` before `rg`, `find`, or directly
reading source files for code discovery and call-path analysis. Use `rg` for
follow-up literal searches and non-code files.

## Development Commands

Install dependencies and start the Web/API service from the repository root:

```bash
npm install
./deploy.sh
```

`./deploy.sh` defaults to `start` and leaves one Node service process running in
the background. Use `./deploy.sh stop` to stop that process. `npm start` remains
available as a compatibility alias.

Run the TypeScript test suite:

```bash
npm test
```

## Change Guidelines

- Preserve existing configuration data and user changes in a dirty worktree.
- Keep the Web client and HTTP API backed by the same ID-based selection and
  operation semantics.
- Add focused tests for configuration schema changes, ID selection rules, and
  every affected operation.
- Treat `sync`, `apply`, and `restore` as filesystem-mutating operations. Tests
  should use temporary project roots and must not operate on real sibling projects.
- Keep structured merge validation strict: unknown keys, type mismatches,
  invalid list indexes, and unresolved variables must continue to fail clearly.
- Update `README.md` whenever commands, configuration fields, or setup steps
  change.

## Test Process Cleanup

Any long-running service started for testing or verification must be stopped
before the task is handed off. This includes `./deploy.sh`, `npm start`, `npm
run dev`, Vite preview servers, and temporary HTTP servers.

- Start background services in a way that keeps their PID or terminal session
  available.
- Stop each service after its final check, including when a check fails.
- Confirm the process exited and its listening port was released.

## Configuration Conventions

- Project IDs must be unique positive integers; display names may repeat.
- Missing or empty `tags` means the project has no tags.
- `conf_dir` is relative to the parent of this repository unless absolute.
- Managed file paths are relative to each project's resolved configuration
  directory.
- Local overrides always live under their environment directory. `dev` is the
  default environment but follows the same path rules as every other environment.
- A project may belong to multiple tags. The Web UI filters by tags and submits
  unique project IDs to the operation API.
