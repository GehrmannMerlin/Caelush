# Input security policy

Security policy decisions are monotonic within one durable Tool admission: a later presentation
or result projection cannot turn a refusal into an approval. The policy boundary receives typed
facts, applies the configured capability and approval rules, and returns a safe decision to the
Tool pipeline.
