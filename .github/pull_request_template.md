<!--
Title MUST follow Conventional Commits, e.g.:
  feat(ingest): accept NDJSON batches
  fix(processor): ack only after durable write
  infra: monorepo scaffolding
This title becomes the squash-merge commit subject.
-->

## What & why

<!-- One or two sentences: what this PR does and the problem it solves. -->

## Linked issue

Closes #<!-- issue number -->

## Type of change

- [ ] feat — new capability
- [ ] fix — bug fix
- [ ] infra / chore — tooling, CI, deps
- [ ] docs — documentation only
- [ ] refactor / test — no behavior change

## Checklist

- [ ] PR title is a Conventional Commit (it becomes the squash commit subject)
- [ ] Tests added/updated and passing (`make test`)
- [ ] Lint/format clean (`make lint`)
- [ ] Multi-tenancy: every new port/query carries `TenantContext`; no un-scoped data path (N/A if no data path)
- [ ] Scope is small and revertible; out-of-scope work split into follow-up issues

## Verification evidence

<!-- Paste the real command output proving the change works (tests, lint, manual checks). -->

```
```
