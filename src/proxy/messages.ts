/**
 * Message parsing and normalization utilities.
 */

/**
 * Strip cache_control from a content block (or nested blocks).
 * cache_control is ephemeral metadata that agents add/remove between requests;
 * it must not affect content hashing or lineage verification.
 */
function stripCacheControlForHashing(obj: any): any {
  if (!obj || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(stripCacheControlForHashing)
  const { cache_control, ...rest } = obj
  return rest
}

/**
 * Stable JSON serialization for hashing purposes.
 *
 * Recursively serializes a value with object keys sorted lexicographically so
 * the output is byte-identical regardless of the original property order.
 * Without this, a `tool_use` block whose `input` has its keys in a different
 * order between requests would hash differently, breaking lineage verification
 * (issue: "changes out of sync" mid-task — Meridian would classify the
 * continuation as `diverged` and start a fresh SDK session, losing context).
 */
function stableStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const keys = Object.keys(value).sort()
  const parts: string[] = []
  for (const k of keys) {
    parts.push(`${JSON.stringify(k)}:${stableStringify(value[k])}`)
  }
  return `{${parts.join(",")}}`
}

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 * Strips cache_control metadata and uses stable JSON serialization to
 * ensure hash stability across requests even when clients reorder object keys.
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 */
export function normalizeContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") {
        return `tool_use:${block.id}:${block.name}:${stableStringify(block.input)}`
      }
      if (block.type === "tool_result") {
        const inner = block.content
        if (typeof inner === "string") return `tool_result:${block.tool_use_id}:${inner}`
        // Strip cache_control from nested content blocks before serializing
        return `tool_result:${block.tool_use_id}:${stableStringify(stripCacheControlForHashing(inner))}`
      }
      // Unknown block types: strip cache_control before serializing
      return stableStringify(stripCacheControlForHashing(block))
    }).join("\n")
  }
  return String(content)
}

/**
 * Extract the advisor model from a tools array.
 * Returns the model string if an advisor tool definition is found, undefined otherwise.
 * The advisor tool is identified by a type starting with "advisor_".
 */
export function extractAdvisorModel(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const candidate = tool as Record<string, unknown>
    if (typeof candidate.type === "string" && candidate.type.startsWith("advisor_") && typeof candidate.model === "string" && candidate.model.length > 0) {
      return candidate.model
    }
  }
  return undefined
}

/**
 * Remove advisor tool definitions from a tools array.
 * Returns a new array with advisor tools filtered out.
 */
export function stripAdvisorTools(tools: unknown[]): unknown[] {
  return tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true
    const candidate = tool as Record<string, unknown>
    return !(typeof candidate.type === "string" && candidate.type.startsWith("advisor_"))
  })
}

/**
 * Extract only the last user message (for session resume — SDK already has history).
 */
export function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}
