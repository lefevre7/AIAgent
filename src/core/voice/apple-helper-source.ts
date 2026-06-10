export const APPLE_NATIVE_VOICE_HELPER_SOURCE = String.raw`import AVFoundation
import CoreMedia
import Darwin
import Foundation
import Speech

struct HelperError: Encodable {
    let code: String
    let details: [String: String]
    let message: String
}

struct HelperFailure: Error {
    let code: String
    let details: [String: String]
    let message: String

    var helperError: HelperError {
        HelperError(code: code, details: details, message: message)
    }
}

struct InputDevicePayload: Encodable {
    let defaultDevice: Bool
    let id: String
    let kind: String
    let metadata: [String: String]
    let name: String

    enum CodingKeys: String, CodingKey {
        case defaultDevice = "default"
        case id
        case kind
        case metadata
        case name
    }
}

struct InputDeviceListResponse: Encodable {
    let devices: [InputDevicePayload]
    let ok: Bool
}

struct TranscriptionPayload: Encodable {
    let durationMs: Int?
    let locale: String?
    let text: String
}

struct TranscriptionSuccessResponse: Encodable {
    let ok: Bool
    let result: TranscriptionPayload
}

struct TranscriptionFailureResponse: Encodable {
    let error: HelperError
    let ok: Bool
}

struct CapturePayload: Encodable {
    let durationMs: Int?
    let locale: String?
    let outputPath: String
    let stopReason: String
    let text: String?
}

struct CaptureSuccessResponse: Encodable {
    let capture: CapturePayload
    let ok: Bool
}

struct CaptureFailureResponse: Encodable {
    let capture: CapturePayload?
    let error: HelperError
    let ok: Bool
}

@main
struct AppleNativeVoiceHelper {
    static func main() {
        do {
            let command = try Command.parse(Array(CommandLine.arguments.dropFirst()))
            let exitCode: Int32

            switch command.name {
            case "list-input-devices":
                let devices = listInputDevices()
                emitJSON(InputDeviceListResponse(devices: devices, ok: true))
                exitCode = EXIT_SUCCESS
            case "transcribe":
                let inputPath = try command.requiredValue(for: "input")
                let requireOnDevice = command.boolValue(for: "require-on-device", defaultValue: false)
                let locale = command.value(for: "locale")
                let transcription = try transcribeFile(
                    at: URL(fileURLWithPath: inputPath),
                    localeIdentifier: locale,
                    requireOnDevice: requireOnDevice
                )
                emitJSON(TranscriptionSuccessResponse(ok: true, result: transcription))
                exitCode = EXIT_SUCCESS
            case "capture":
                let controller = try CaptureController(command: command)
                exitCode = controller.run()
            default:
                throw HelperFailure(
                    code: "voice_helper_unknown_command",
                    details: ["command": command.name],
                    message: "Unknown helper command \"\(command.name)\"."
                )
            }

            exit(exitCode)
        } catch let failure as HelperFailure {
            emitJSON(TranscriptionFailureResponse(error: failure.helperError, ok: false))
            exit(EXIT_FAILURE)
        } catch {
            let failure = HelperFailure(
                code: "voice_helper_unhandled_error",
                details: [:],
                message: error.localizedDescription
            )
            emitJSON(TranscriptionFailureResponse(error: failure.helperError, ok: false))
            exit(EXIT_FAILURE)
        }
    }
}

private struct Command {
    let name: String
    let options: [String: String]

    static func parse(_ arguments: [String]) throws -> Command {
        guard let name = arguments.first, !name.isEmpty else {
            throw HelperFailure(
                code: "voice_helper_missing_command",
                details: [:],
                message: "Expected a helper command."
            )
        }

        var options: [String: String] = [:]
        var index = 1

        while index < arguments.count {
            let keyToken = arguments[index]
            guard keyToken.hasPrefix("--") else {
                throw HelperFailure(
                    code: "voice_helper_invalid_argument",
                    details: ["argument": keyToken],
                    message: "Unexpected argument \"\(keyToken)\"."
                )
            }

            let key = String(keyToken.dropFirst(2))
            if index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") {
                options[key] = arguments[index + 1]
                index += 2
            } else {
                options[key] = "true"
                index += 1
            }
        }

        return Command(name: name, options: options)
    }

    func value(for key: String) -> String? {
        options[key]
    }

    func requiredValue(for key: String) throws -> String {
        if let value = options[key], !value.isEmpty {
            return value
        }

        throw HelperFailure(
            code: "voice_helper_missing_option",
            details: ["option": key],
            message: "Missing required option --\(key)."
        )
    }

    func boolValue(for key: String, defaultValue: Bool) -> Bool {
        guard let raw = options[key]?.lowercased() else {
            return defaultValue
        }

        if ["1", "true", "yes", "on"].contains(raw) {
            return true
        }
        if ["0", "false", "no", "off"].contains(raw) {
            return false
        }
        return defaultValue
    }

    func intValue(for key: String) throws -> Int? {
        guard let raw = options[key] else {
            return nil
        }
        guard let value = Int(raw) else {
            throw HelperFailure(
                code: "voice_helper_invalid_integer",
                details: ["option": key, "value": raw],
                message: "Option --\(key) must be an integer."
            )
        }
        return value
    }
}

private final class CaptureController: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureFileOutputRecordingDelegate {
    private let command: Command
    private let completionSemaphore = DispatchSemaphore(value: 0)
    private let fileOutput = AVCaptureAudioFileOutput()
    private let levelQueue = DispatchQueue(label: "aiagent.voice.capture.levels")
    private let levelOutput = AVCaptureAudioDataOutput()
    private let localeIdentifier: String?
    private let maxDurationMs: Int
    private let outputURL: URL
    private let requireOnDevice: Bool
    private let session = AVCaptureSession()
    private let silenceTimeoutMs: Int
    private let signalQueue = DispatchQueue(label: "aiagent.voice.capture.signals")
    private var signalSources: [DispatchSourceSignal] = []
    private let sourceDevice: AVCaptureDevice

    private var captureStartedAt = Date()
    private var finalFailureResponse: CaptureFailureResponse?
    private var finalSuccessResponse: CaptureSuccessResponse?
    private var isStopping = false
    private var lastNonSilentAt = Date()
    private var maxDurationTimer: DispatchSourceTimer?
    private var stopReason = "completed"
    private var silenceTimer: DispatchSourceTimer?

    init(command: Command) throws {
        self.command = command
        self.localeIdentifier = command.value(for: "locale")
        self.maxDurationMs = try command.intValue(for: "max-duration-ms") ?? 60_000
        self.outputURL = URL(fileURLWithPath: try command.requiredValue(for: "output"))
        self.requireOnDevice = command.boolValue(for: "require-on-device", defaultValue: false)
        self.silenceTimeoutMs = try command.intValue(for: "silence-timeout-ms") ?? 1_500
        self.sourceDevice = try resolveInputDevice(identifierOrName: command.value(for: "input-device"))
        super.init()

        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try self.configureSession()
        self.signalSources = try self.installSignalSources()
    }

    func run() -> Int32 {
        do {
            try ensureMicrophoneAuthorization()
            try ensureSpeechAuthorization()

            let availableFileTypes = Set(fileOutput.availableOutputFileTypes)
            guard availableFileTypes.contains(.wav) else {
                throw HelperFailure(
                    code: "voice_capture_wave_unsupported",
                    details: [:],
                    message: "This system cannot write capture audio as WAVE."
                )
            }

            captureStartedAt = Date()
            lastNonSilentAt = captureStartedAt
            session.startRunning()
            installTimers()
            fileOutput.startRecording(to: outputURL, outputFileType: .wav, recordingDelegate: self)
            completionSemaphore.wait()

            if let response = finalSuccessResponse {
                emitJSON(response)
                return EXIT_SUCCESS
            }

            emitJSON(
                finalFailureResponse ??
                    CaptureFailureResponse(
                        capture: CapturePayload(
                            durationMs: durationMs(for: outputURL),
                            locale: localeIdentifier,
                            outputPath: outputURL.path,
                            stopReason: "error",
                            text: nil
                        ),
                        error: HelperFailure(
                            code: "voice_capture_unknown_failure",
                            details: [:],
                            message: "Capture finished without a terminal response."
                        ).helperError,
                        ok: false
                    )
            )
            return EXIT_FAILURE
        } catch let failure as HelperFailure {
            emitJSON(CaptureFailureResponse(capture: nil, error: failure.helperError, ok: false))
            return EXIT_FAILURE
        } catch {
            let failure = HelperFailure(
                code: "voice_capture_unhandled_error",
                details: [:],
                message: error.localizedDescription
            )
            emitJSON(CaptureFailureResponse(capture: nil, error: failure.helperError, ok: false))
            return EXIT_FAILURE
        }
    }

    private func configureSession() throws {
        let input = try AVCaptureDeviceInput(device: sourceDevice)
        guard session.canAddInput(input) else {
            throw HelperFailure(
                code: "voice_capture_input_unavailable",
                details: ["deviceId": sourceDevice.uniqueID],
                message: "The selected microphone cannot be opened for capture."
            )
        }
        session.addInput(input)

        guard session.canAddOutput(fileOutput) else {
            throw HelperFailure(
                code: "voice_capture_file_output_unavailable",
                details: [:],
                message: "The audio file output could not be attached to the capture session."
            )
        }
        session.addOutput(fileOutput)

        if silenceTimeoutMs > 0, session.canAddOutput(levelOutput) {
            levelOutput.audioSettings = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsNonInterleaved: false,
                AVNumberOfChannelsKey: 1
            ]
            levelOutput.setSampleBufferDelegate(self, queue: levelQueue)
            session.addOutput(levelOutput)
        }
    }

    private func installTimers() {
        let maxTimer = DispatchSource.makeTimerSource(queue: signalQueue)
        maxTimer.schedule(deadline: .now() + .milliseconds(maxDurationMs))
        maxTimer.setEventHandler { [weak self] in
            self?.requestStop(reason: "max_duration")
        }
        maxTimer.resume()
        maxDurationTimer = maxTimer

        guard silenceTimeoutMs > 0 else {
            return
        }

        let silenceTimer = DispatchSource.makeTimerSource(queue: signalQueue)
        silenceTimer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        silenceTimer.setEventHandler { [weak self] in
            guard let self else {
                return
            }

            if self.isStopping {
                return
            }

            let elapsedSinceSpeech = Date().timeIntervalSince(self.lastNonSilentAt) * 1_000
            let elapsedSinceStart = Date().timeIntervalSince(self.captureStartedAt) * 1_000
            if elapsedSinceStart >= 500, elapsedSinceSpeech >= Double(self.silenceTimeoutMs) {
                self.requestStop(reason: "silence")
            }
        }
        silenceTimer.resume()
        self.silenceTimer = silenceTimer
    }

    private func requestStop(reason: String) {
        if isStopping {
            return
        }
        isStopping = true
        stopReason = reason
        if fileOutput.isRecording {
            fileOutput.stopRecording()
        } else {
            finishRecording(error: nil)
        }
    }

    private func finishRecording(error: Error?) {
        maxDurationTimer?.cancel()
        silenceTimer?.cancel()
        session.stopRunning()

        if let error {
            finalFailureResponse = CaptureFailureResponse(
                capture: CapturePayload(
                    durationMs: durationMs(for: outputURL),
                    locale: localeIdentifier,
                    outputPath: outputURL.path,
                    stopReason: "error",
                    text: nil
                ),
                error: HelperFailure(
                    code: "voice_capture_failed",
                    details: ["underlyingError": error.localizedDescription],
                    message: "Audio capture failed."
                ).helperError,
                ok: false
            )
            completionSemaphore.signal()
            return
        }

        do {
            let transcription = try transcribeFile(
                at: outputURL,
                localeIdentifier: localeIdentifier,
                requireOnDevice: requireOnDevice
            )
            finalSuccessResponse = CaptureSuccessResponse(
                capture: CapturePayload(
                    durationMs: transcription.durationMs ?? durationMs(for: outputURL),
                    locale: transcription.locale ?? localeIdentifier,
                    outputPath: outputURL.path,
                    stopReason: stopReason,
                    text: transcription.text
                ),
                ok: true
            )
        } catch let failure as HelperFailure {
            finalFailureResponse = CaptureFailureResponse(
                capture: CapturePayload(
                    durationMs: durationMs(for: outputURL),
                    locale: localeIdentifier,
                    outputPath: outputURL.path,
                    stopReason: "error",
                    text: nil
                ),
                error: failure.helperError,
                ok: false
            )
        } catch {
            finalFailureResponse = CaptureFailureResponse(
                capture: CapturePayload(
                    durationMs: durationMs(for: outputURL),
                    locale: localeIdentifier,
                    outputPath: outputURL.path,
                    stopReason: "error",
                    text: nil
                ),
                error: HelperFailure(
                    code: "voice_capture_transcription_failed",
                    details: ["underlyingError": error.localizedDescription],
                    message: "Audio capture finished, but transcription failed."
                ).helperError,
                ok: false
            )
        }

        completionSemaphore.signal()
    }

    private func installSignalSources() throws -> [DispatchSourceSignal] {
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        return try [SIGINT, SIGTERM].map { signalNumber in
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: signalQueue)
            source.setEventHandler { [weak self] in
                self?.requestStop(reason: "manual")
            }
            source.resume()
            return source
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard silenceTimeoutMs > 0 else {
            return
        }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            return
        }

        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard status == kCMBlockBufferNoErr, let dataPointer else {
            return
        }

        let sampleCount = totalLength / MemoryLayout<Int16>.size
        guard sampleCount > 0 else {
            return
        }

        let rms = dataPointer.withMemoryRebound(to: Int16.self, capacity: sampleCount) { pointer -> Double in
            let buffer = UnsafeBufferPointer(start: pointer, count: sampleCount)
            let sumSquares = buffer.reduce(0.0) { partial, sample in
                let normalized = Double(sample) / Double(Int16.max)
                return partial + (normalized * normalized)
            }
            return sqrt(sumSquares / Double(sampleCount))
        }

        if rms >= 0.02 {
            lastNonSilentAt = Date()
        }
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        finishRecording(error: error)
    }
}

private func listInputDevices() -> [InputDevicePayload] {
    let defaultDeviceId = AVCaptureDevice.default(for: .audio)?.uniqueID
    return discoveredAudioDevices().map { device in
        InputDevicePayload(
            defaultDevice: device.uniqueID == defaultDeviceId,
            id: device.uniqueID,
            kind: "input",
            metadata: [
                "manufacturer": device.manufacturer,
                "modelId": device.modelID
            ].filter { !$0.value.isEmpty },
            name: device.localizedName
        )
    }
}

private func transcribeFile(
    at url: URL,
    localeIdentifier: String?,
    requireOnDevice: Bool
) throws -> TranscriptionPayload {
    try ensureSpeechAuthorization()

    let locale = localeIdentifier.map { Locale(identifier: $0.replacingOccurrences(of: "_", with: "-")) }
    guard let recognizer = locale.map(SFSpeechRecognizer.init(locale:)) ?? SFSpeechRecognizer() else {
        throw HelperFailure(
            code: "voice_transcription_locale_unsupported",
            details: ["locale": localeIdentifier ?? "<default>"],
            message: "The requested speech locale is not available."
        )
    }

    if requireOnDevice && !recognizer.supportsOnDeviceRecognition {
        throw HelperFailure(
            code: "voice_transcription_on_device_unavailable",
            details: ["locale": recognizer.locale.identifier],
            message: "On-device speech recognition is unavailable for the requested locale."
        )
    }

    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = requireOnDevice
    request.shouldReportPartialResults = false

    let semaphore = DispatchSemaphore(value: 0)
    var finalText: String?
    var finalError: Error?

    let task = recognizer.recognitionTask(with: request) { result, error in
        if let error {
            finalError = error
            semaphore.signal()
            return
        }

        guard let result else {
            return
        }

        if result.isFinal {
            finalText = result.bestTranscription.formattedString
            semaphore.signal()
        }
    }

    let waitResult = semaphore.wait(timeout: .now() + .seconds(180))
    if waitResult == .timedOut {
        task.cancel()
        throw HelperFailure(
            code: "voice_transcription_timeout",
            details: ["path": url.path],
            message: "Speech recognition did not finish before the timeout."
        )
    }

    if let error = finalError {
        throw HelperFailure(
            code: "voice_transcription_failed",
            details: ["underlyingError": error.localizedDescription],
            message: "Speech recognition failed."
        )
    }

    guard let text = finalText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
        throw HelperFailure(
            code: "voice_transcription_empty",
            details: ["path": url.path],
            message: "No speech could be transcribed from the audio input."
        )
    }

    return TranscriptionPayload(
        durationMs: durationMs(for: url),
        locale: recognizer.locale.identifier,
        text: text
    )
}

private func resolveInputDevice(identifierOrName: String?) throws -> AVCaptureDevice {
    if let identifierOrName, !identifierOrName.isEmpty {
        let normalized = identifierOrName.lowercased()
        if let device = discoveredAudioDevices().first(where: { device in
            device.uniqueID.lowercased() == normalized ||
                device.localizedName.lowercased() == normalized ||
                device.localizedName.lowercased().hasPrefix(normalized)
        }) {
            return device
        }

        throw HelperFailure(
            code: "voice_input_device_not_found",
            details: ["inputDevice": identifierOrName],
            message: "The requested input device was not found."
        )
    }

    if let defaultDevice = AVCaptureDevice.default(for: .audio) {
        return defaultDevice
    }

    if let firstDevice = discoveredAudioDevices().first {
        return firstDevice
    }

    throw HelperFailure(
        code: "voice_input_device_unavailable",
        details: [:],
        message: "No microphone devices are available."
    )
}

private func discoveredAudioDevices() -> [AVCaptureDevice] {
    let deviceTypes: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
        deviceTypes = [.microphone, .external]
    } else {
        deviceTypes = [.builtInMicrophone, .externalUnknown]
    }

    let session = AVCaptureDevice.DiscoverySession(deviceTypes: deviceTypes, mediaType: .audio, position: .unspecified)
    return session.devices
}

private func ensureMicrophoneAuthorization() throws {
    let currentStatus = AVCaptureDevice.authorizationStatus(for: .audio)
    switch currentStatus {
    case .authorized:
        return
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { accessGranted in
            granted = accessGranted
            semaphore.signal()
        }
        semaphore.wait()
        guard granted else {
            throw HelperFailure(
                code: "voice_microphone_authorization_denied",
                details: [:],
                message: "Microphone permission was denied."
            )
        }
    case .denied, .restricted:
        throw HelperFailure(
            code: "voice_microphone_authorization_denied",
            details: [:],
            message: "Microphone permission is unavailable."
        )
    @unknown default:
        throw HelperFailure(
            code: "voice_microphone_authorization_unknown",
            details: [:],
            message: "Microphone permission status is unknown."
        )
    }
}

private func ensureSpeechAuthorization() throws {
    let currentStatus = SFSpeechRecognizer.authorizationStatus()
    switch currentStatus {
    case .authorized:
        return
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var resolvedStatus = SFSpeechRecognizerAuthorizationStatus.notDetermined
        SFSpeechRecognizer.requestAuthorization { newStatus in
            resolvedStatus = newStatus
            semaphore.signal()
        }
        semaphore.wait()
        guard resolvedStatus == .authorized else {
            throw HelperFailure(
                code: "voice_speech_authorization_denied",
                details: ["status": String(describing: resolvedStatus)],
                message: "Speech recognition permission was denied."
            )
        }
    case .denied, .restricted:
        throw HelperFailure(
            code: "voice_speech_authorization_denied",
            details: ["status": String(describing: currentStatus)],
            message: "Speech recognition permission is unavailable."
        )
    @unknown default:
        throw HelperFailure(
            code: "voice_speech_authorization_unknown",
            details: ["status": String(describing: currentStatus)],
            message: "Speech recognition permission status is unknown."
        )
    }
}

private func durationMs(for url: URL) -> Int? {
    let asset = AVURLAsset(url: url)
    let seconds = CMTimeGetSeconds(asset.duration)
    guard seconds.isFinite, seconds > 0 else {
        return nil
    }
    return Int((seconds * 1_000).rounded())
}

private func emitJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    do {
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        let fallback = "{\"error\":{\"code\":\"voice_helper_encode_failed\",\"details\":{},\"message\":\"\(error.localizedDescription)\"},\"ok\":false}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}
`;
