# Failure model

Delivery is **at-most-once after claim**. Durable state advances before Pi receives the prompt.
If persistence fails, memory does not advance and no occurrence is returned. If Pi delivery fails
after persistence, that occurrence is lost and the error is surfaced; the runtime does not retry.

The project file has one live writer selected by an `O_EXCL` PID lease. Followers may run
session-retained loops but durable mutations fail with `LeaseUnavailable`. Network filesystems,
container PID namespaces, external live editing, and distributed scheduling are outside the
contract.
