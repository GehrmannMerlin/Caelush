# Context and project intelligence

Project intelligence is a host Context concern. The Core adapter may call
`ProjectInspector.inspect()` and the relevant-file planner, then materialize bounded context for
the model. The Agent Kernel receives only the prepared model context and durable conversation
input; it does not import workspace or project-inventory types.
