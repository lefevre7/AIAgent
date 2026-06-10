import { createBootstrapInfo } from "@/core/index";

describe("createBootstrapInfo", () => {
  it("returns the expected bootstrap surfaces and providers", () => {
    expect(createBootstrapInfo()).toMatchObject({
      name: "AIAgent",
      phase: "bootstrap",
      providers: ["LM Studio", "Ollama"],
      surfaces: ["CLI", "Library", "Web", "Gateway"]
    });
  });
});

