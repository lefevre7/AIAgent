import { createBootstrapInfo } from "@/core/index";

describe("createBootstrapInfo", () => {
  it("returns the expected bootstrap surfaces and providers", () => {
    expect(createBootstrapInfo()).toMatchObject({
      name: "AIAgent",
      phase: "bootstrap",
      // Every built-in provider; llama.cpp was missing from a hand-kept list.
      providers: ["llama.cpp", "LM Studio", "Ollama"],
      surfaces: ["CLI", "Library", "Web", "Gateway"]
    });
  });
});
