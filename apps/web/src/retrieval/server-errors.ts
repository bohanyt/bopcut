/** A retrieval failure with a message meant for the user or agent (missing tool, refused link, tool error). */
export class RetrievalError extends Error {}

/** A host that this machine cannot resolve. It may still resolve elsewhere, such as through a proxy. */
export class UnresolvedHostError extends RetrievalError {}
