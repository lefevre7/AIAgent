import { BUILT_IN_LANGUAGE_MODEL_PROVIDERS } from "@/core/lm/providers";
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
    // From the provider table, so a provider added there is named here too
    // (llama.cpp was missing from a hand-kept list).
    providers: Object.values(BUILT_IN_LANGUAGE_MODEL_PROVIDERS).map((provider) => provider.displayName),
    surfaces: ["CLI", "Library", "Web", "Gateway"]
  };
}
