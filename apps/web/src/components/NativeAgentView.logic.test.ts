import { describe, expect, it } from "vite-plus/test";

import { NATIVE_AGENT_BLOCKED_INPUT_NOTICE } from "./NativeAgentView.logic";

describe("NativeAgentView", () => {
  it("uses an explicit blocked-input notice", () => {
    expect(NATIVE_AGENT_BLOCKED_INPUT_NOTICE).toBe(
      "Input is unavailable for provider-native sub-agents.",
    );
  });
});
