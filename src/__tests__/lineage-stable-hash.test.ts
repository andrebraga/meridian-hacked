/**
 * Tests for normalizeContent's stable JSON serialization.
 * Verifies that tool_use blocks with the same input but different key order
 * produce identical hashes (the property that broke lineage verification
 * before the fix).
 */

import { describe, it, expect } from "bun:test"
import { computeLineageHash, hashMessage } from "../proxy/session/lineage"

describe("lineage hash stability across tool_use input key order", () => {
  it("produces identical hashes for tool_use with same input in different key order", () => {
    const messagesA = [
      { role: "user", content: "edit the file" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "edit",
            input: { filePath: "/foo.ts", old_string: "a", new_string: "b" },
          },
        ],
      },
    ]
    const messagesB = [
      { role: "user", content: "edit the file" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "edit",
            input: { new_string: "b", old_string: "a", filePath: "/foo.ts" },
          },
        ],
      },
    ]
    expect(computeLineageHash(messagesA)).toBe(computeLineageHash(messagesB))
    expect(hashMessage(messagesA[1]!)).toBe(hashMessage(messagesB[1]!))
  })

  it("produces identical hashes for nested tool_use input regardless of key order", () => {
    const messagesA = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "ls", env: { FOO: "1", BAR: "2" } },
          },
        ],
      },
    ]
    const messagesB = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { env: { BAR: "2", FOO: "1" }, command: "ls" },
          },
        ],
      },
    ]
    expect(computeLineageHash(messagesA)).toBe(computeLineageHash(messagesB))
  })

  it("produces different hashes when input values actually differ", () => {
    const messagesA = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "edit",
            input: { filePath: "/foo.ts", old_string: "a" },
          },
        ],
      },
    ]
    const messagesB = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "edit",
            input: { filePath: "/foo.ts", old_string: "b" },
          },
        ],
      },
    ]
    expect(computeLineageHash(messagesA)).not.toBe(computeLineageHash(messagesB))
  })

  it("produces identical hashes for tool_result with same content in different key order", () => {
    const messagesA = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
    ]
    const messagesB = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ text: "ok", type: "text" }],
          },
        ],
      },
    ]
    expect(computeLineageHash(messagesA)).toBe(computeLineageHash(messagesB))
  })
})
