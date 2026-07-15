# Invariants

1. A persisted loop inhabits exactly one program-specific state space.
2. `Waiting.dueAt` is the only owner of the next live due instant.
3. One `(loopId, cursor)` produces at most one occurrence.
4. Closed admission never changes temporal state.
5. A durable claim commits the file before memory advances or an occurrence escapes.
6. Only the durable lease owner may mutate project-retained loops.
7. Pi prompt delivery occurs only after a successful claim.
8. Cron, manual wakeup, and one-shot behavior share the same claim transition.
