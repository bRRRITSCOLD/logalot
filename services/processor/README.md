# processor (reserved)

Go worker that consumes from RabbitMQ, normalizes, persists to the hot store,
tees to cold, and fans out to the tail bus (Log Processing bounded context —
see `docs/architecture/overview.md`).

**Status:** reserved path. Built in **issue #7**. When it lands it becomes its
own Go module here and gets added to the `use` block in the repo-root `go.work`.
