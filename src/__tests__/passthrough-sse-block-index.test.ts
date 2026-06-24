/**
 * Regression test for the synthetic SSE block-index bug.
 *
 * Previously the streaming passthrough path emitted captured tool_use blocks
 * with index = `eventsForwarded + i`. But `eventsForwarded` counts ALL events
 * (including deltas/stops/message_start/stop/ping), while the client expects
 * monotonic content-block indices. For a response with 2 tool_uses and 2
 * deltas each, the offset was off by ~10 — clients receiving index 10+ when
 * they expected index 2+ silently dropped the synthetic blocks.
 *
 * This test simulates a streaming request that triggers the synthetic
 * passthrough emission path and verifies that the block indices are
 * contiguous from 0 (matching the format Anthropic SDK and OpenCode expect).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  toolUseBlockStart,
  textDelta,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  parseSSE,
  makeToolRequest,
} from "./helpers"

let mockMessages: any[] = []
let capturedQueryOpts: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedQueryOpts = opts
    return (async function* () {
      // Simulate SDK firing PreToolUse hook for each tool_use in our mock
      if (capturedQueryOpts?.hooks?.PreToolUse) {
        const preToolUseHooks = capturedQueryOpts.hooks.PreToolUse
        for (const hookConfig of preToolUseHooks) {
          for (const hook of hookConfig.hooks) {
            // Synthesize tool calls based on what's in mockMessages
            const toolUseMessages = mockMessages.filter((m: any) =>
              m.event?.content_block?.type === "tool_use"
            )
            for (const tum of toolUseMessages) {
              const tu = tum.event.content_block
              await hook({
                tool_name: `mcp__oc__${tu.name}`,
                tool_input: tu.input ?? {},
                tool_use_id: tu.id,
              })
            }
          }
        }
      }
      for (const msg of mockMessages) {
        yield msg
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: {
      registerTool: (_name: string, _def: any, _handler: any) => {},
    },
  }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

// Enable passthrough mode
process.env.MERIDIAN_PASSTHROUGH = "true"

const { createProxyServer } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
  return app
}

async function postStream(app: any, body: any) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

describe("passthrough SSE: synthetic tool_use block indices are contiguous from 0", () => {
  beforeEach(() => {
    mockMessages = []
  })

  it("assigns contiguous client block indices when emitting synthetic tool_use blocks", async () => {
    // Simulate a response with 1 text block + 2 tool_use blocks (parallel calls).
    // The SDK emits streaming events for both. We want to verify that the
    // synthetic emission uses correct block indices.
    mockMessages = [
      messageStart("msg_test"),
      textBlockStart(0),
      textDelta(0, "Let me check both."),
      blockStop(0),
      toolUseBlockStart(1, "get_weather", "toolu_w1"),
      inputJsonDelta(1, '{"city":"Paris"}'),
      blockStop(1),
      toolUseBlockStart(2, "get_time", "toolu_t1"),
      inputJsonDelta(2, '{"city":"Paris"}'),
      blockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const app = createTestApp()
    const body = makeToolRequest(
      [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      { stream: true }
    )

    const res = await postStream(app, body)
    const text = await readAll(res)
    const events = parseSSE(text)

    // Extract all indices from content_block_start events
    const blockStartIndices = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => (e.data as any).index)

    console.log("[sse-index-test] Block start indices:", blockStartIndices)
    console.log("[sse-index-test] Total events:", events.length)

    // Indices must be 0, 1, 2, ... contiguous
    for (let i = 0; i < blockStartIndices.length; i++) {
      expect(blockStartIndices[i]).toBe(i)
    }
  })

  it("does not produce duplicate tool_use IDs in synthetic emission", async () => {
    mockMessages = [
      messageStart("msg_test"),
      toolUseBlockStart(0, "get_weather", "toolu_w1"),
      inputJsonDelta(0, '{"city":"Paris"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const app = createTestApp()
    const body = makeToolRequest(
      [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      { stream: true }
    )

    const res = await postStream(app, body)
    const text = await readAll(res)
    const events = parseSSE(text)

    // Extract all tool_use IDs from content_block_start events
    const toolUseIds = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => ((e.data as any).content_block as any)?.id)
      .filter(Boolean)

    console.log("[sse-index-test] Tool use IDs:", toolUseIds)

    // No duplicate IDs
    const uniqueIds = new Set(toolUseIds)
    expect(uniqueIds.size).toBe(toolUseIds.length)
  })
})
