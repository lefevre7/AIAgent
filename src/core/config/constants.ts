import os from "node:os";
import path from "node:path";

import { DEFAULT_HOSTNAME, DEFAULT_PORT } from "@/core/runtime-metadata";

export const APP_CONFIG_VERSION = 1;
export const APPROVALS_CONFIG_VERSION = 1;
export const APP_CONFIG_FILE_NAME = "aia.config.jsonc";
export const APPROVALS_CONFIG_FILE_NAME = "aia.approvals.jsonc";
export const USER_STATE_DIRECTORY_NAME = ".aia";
export const DEFAULT_USER_STATE_DIRECTORY = path.join(os.homedir(), USER_STATE_DIRECTORY_NAME);
export const DEFAULT_GLOBAL_CONFIG_PATH = path.join(DEFAULT_USER_STATE_DIRECTORY, APP_CONFIG_FILE_NAME);
export const DEFAULT_GLOBAL_APPROVALS_PATH = path.join(DEFAULT_USER_STATE_DIRECTORY, APPROVALS_CONFIG_FILE_NAME);
export const DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234/v1";
export const DEFAULT_LM_STUDIO_MODEL = "mistralai/devstral-small-2-2512";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_GATEWAY_HOSTNAME = DEFAULT_HOSTNAME;
export const DEFAULT_GATEWAY_PORT = DEFAULT_PORT;
export const DEFAULT_GATEWAY_WEBSOCKET_PATH = "/api/gateway/ws";
export const DEFAULT_COMFYUI_BASE_URL = "http://localhost:8188";
export const DEFAULT_IMAGE_DEFAULT_PROVIDER_ID = "comfyui_local";
export const DEFAULT_IMAGE_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_VOICE_DEFAULT_PROVIDER_ID = "apple_native";
export const DEFAULT_VOICE_SYNTHESIS_PROVIDER_ID = "local_system";
export const DEFAULT_VOICE_TRANSCRIPTION_PROVIDER_ID = "apple_native";
export const DEFAULT_VOICE_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
export const DEFAULT_VOICE_MAX_CAPTURE_MS = 60_000;
export const DEFAULT_VOICE_SILENCE_TIMEOUT_MS = 1_500;
