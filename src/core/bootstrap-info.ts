import { APP_NAME, BOOTSTRAP_PHASE } from "@/core/runtime-metadata";

export type BootstrapInfo = {
  directories: string[];
  name: string;
  phase: string;
  providers: string[];
  surfaces: string[];
};

export function createBootstrapInfo(): BootstrapInfo {
  return {
    directories: ["src/core", "src/gateway", "src/server", "src/web", "src/app", "tests"],
    name: APP_NAME,
    phase: BOOTSTRAP_PHASE,
    providers: ["LM Studio", "Ollama"],
    surfaces: ["CLI", "Library", "Web", "Gateway"]
  };
}

