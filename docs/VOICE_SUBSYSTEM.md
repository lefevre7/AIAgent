# Voice Subsystem

Last updated: 2026-03-31

## Scope

Item 18 is implemented as a shared core voice layer with:

- provider-agnostic `VoiceService` orchestration in `src/core/voice/service.ts`
- a local macOS-first STT and live-capture adapter in `src/core/voice/apple-native.ts`
- a local macOS-first TTS and playback adapter in `src/core/voice/local-system.ts`
- built-in model-facing voice tools in `src/core/tools/builtins/voice.ts`
- explicit CLI voice subcommands in `src/cli.ts`

Gateway and web transport/UI work is still intentionally deferred to items 20 and 22.

## Provider Split

- `apple_native`
  - current role: transcription, live capture, input-device discovery
  - implementation: a compiled Swift helper cached under `.aia/voice/bin/`
  - APIs: `SFSpeechRecognizer`, `SFSpeechURLRecognitionRequest`, `AVCaptureSession`, `AVCaptureAudioFileOutput`
  - posture: on-device recognition is required by default
- `local_system`
  - current role: voice listing, synthesis, direct text playback, output-device discovery
  - implementation: macOS `say` plus `afplay`

This keeps the public interface portable while using the lowest-friction local providers for the first release.

## Contracts And Persistence

- `src/core/contracts/voice.ts` now carries:
  - provider health
  - voice/device discovery
  - capture/playback/transcription job records
  - rich service methods for capture, playback, synthesis, transcription, and health
- `src/core/contracts/messages.ts` now supports first-class `audio` message parts with optional duration, transcript, voice, and waveform metadata.
- `src/core/sessions/store.ts` persists dedicated per-session voice files:
  - `voice-captures.jsonl`
  - `voice-playbacks.jsonl`
  - `voice-transcriptions.jsonl`

When CLI voice input is tied to a session, the final transcript is appended as a normal user message with both text and audio parts.

## Storage Layout

The canonical runtime root is `.aia/voice/`.

- `.aia/voice/bin/`
  - compiled Apple helper binary
  - helper Swift source and content hash
- `.aia/voice/captures/<provider>/<session-or-shared>/`
  - owned live-capture WAV artifacts
- `.aia/voice/synthesis/<provider>/<session-or-shared>/`
  - owned synthesized audio artifacts

The current implementation keeps raw audio by default.

## Approvals

- Model-facing voice tools:
  - `voice_list_voices`: `never`
  - `voice_transcribe_audio`: `never`
  - `voice_synthesize_text`: `ask`
- Live microphone capture is not model-initiated in item 18.
- Dedicated `voice_action` approval targets exist for microphone/speaker actions, but the current built-in model tools do not expose live capture or speaker playback.
- Direct operator-initiated CLI capture/playback implies consent and bypasses the model approval path.

## CLI Surface

Current commands:

- `aia voice list-voices`
- `aia voice list-devices`
- `aia voice transcribe-file --file <path>`
- `aia voice capture`
- `aia voice synthesize --text <text>`
- `aia voice speak --text <text>`

Useful flags:

- `--provider`
- `--locale`
- `--voice`
- `--input-device`
- `--output-device`
- `--session`
- `--max-duration-ms`
- `--silence-timeout-ms`

## Config And Env

Top-level `voice` config now owns runtime defaults such as:

- `artifactRoot`
- `defaultProviderId`
- `defaultSynthesisProviderId`
- `defaultTranscriptionProviderId`
- `defaultLocale`
- `defaultVoice`
- `inputDevice`
- `outputDevice`
- `maxCaptureMs`
- `silenceTimeoutMs`
- `requireOnDeviceRecognition`
- `retainAudio`

High-signal environment overrides are supported:

- `AIA_VOICE_ARTIFACT_ROOT`
- `AIA_VOICE_DEFAULT_PROVIDER`
- `AIA_VOICE_DEFAULT_SYNTHESIS_PROVIDER`
- `AIA_VOICE_DEFAULT_TRANSCRIPTION_PROVIDER`
- `AIA_VOICE_DEFAULT_LOCALE`
- `AIA_VOICE_DEFAULT_VOICE`
- `AIA_VOICE_INPUT_DEVICE`
- `AIA_VOICE_OUTPUT_DEVICE`
- `AIA_VOICE_MAX_CAPTURE_MS`
- `AIA_VOICE_SILENCE_TIMEOUT_MS`
- `AIA_VOICE_REQUIRE_ON_DEVICE`
- `AIA_VOICE_RETAIN_AUDIO`

## Current Limits

- Full gateway/web voice initiation and streaming are deferred.
- Partial transcripts are internal only; the runtime persists the final transcript only.
- Output-device selection is supported for direct text playback through `say`, but audio-artifact playback currently falls back to the system default output device.
- The Apple helper requires macOS microphone and Speech permissions.
- No bundled GPL voice engines are shipped; future Whisper/Piper-style backends remain external optional adapters.

## Tests

Deterministic coverage:

- `tests/integration/voice-service.test.ts`
- `tests/integration/voice-tools.test.ts`
- `tests/unit/approval-policy.test.ts`
- `tests/integration/session-store.test.ts`

Opt-in live macOS test:

```bash
AIA_RUN_LIVE_VOICE_TESTS=1 npm run test:live:voice
```

Prerequisites:

- macOS
- working `say`, `afplay`, `swiftc`, and Speech framework access
- granted microphone and Speech recognition permissions for the terminal running the suite
