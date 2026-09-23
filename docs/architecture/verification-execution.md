# Verification execution

Phase 11B keeps verification command admission and execution in the host adapters. The
verification domain describes typed argv and receives bounded evidence; it does not spawn
processes or access the workspace itself.

The host-side adapter accepts typed argv, executes it through the Runtime `executeArgv()` port,
and records the associated `ToolInvocation` plus bounded output. A verification command may
include at most 32 KiB of captured output in its evidence. Verification evidence is not completion
authority.
