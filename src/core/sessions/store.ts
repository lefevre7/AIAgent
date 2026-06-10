import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  approvalRequestSchema,
  approvalResolutionSchema,
  entityIdSchema,
  isoTimestampSchema,
  messageSchema,
  sessionRecordSchema,
  sessionResumeMetadataSchema,
  sessionSnapshotSchema,
  steeringInjectionSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  voiceCaptureRecordSchema,
  voicePlaybackRecordSchema,
  voiceTranscriptionRecordSchema,
  type ApprovalRequest,
  type ApprovalResolution,
  type Message,
  type SessionRecord,
  type SessionResumeMetadata,
  type SessionSnapshot,
  type SteeringInjection,
  type ToolCallRecord,
  type TurnRecord,
  type VoiceCaptureRecord,
  type VoicePlaybackRecord,
  type VoiceTranscriptionRecord
} from "@/core/contracts";
import { writeJsonAtomic } from "@/core/io/files";

const sessionEventEnvelopeSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: entityIdSchema,
    kind: z.enum([
      "approval_request_appended",
      "approval_resolution_appended",
      "message_appended",
      "resume_metadata_saved",
      "session_saved",
      "steering_appended",
      "tool_call_appended",
      "turn_appended",
      "voice_capture_appended",
      "voice_playback_appended",
      "voice_transcription_appended"
    ]),
    payload: z.unknown(),
    sessionId: entityIdSchema
  })
  .strict();

const pendingApprovalsIndexSchema = z
  .object({
    approvals: z.record(
      z.string(),
      z
        .object({
          request: approvalRequestSchema,
          sessionId: entityIdSchema
        })
        .strict()
    ),
    updatedAt: isoTimestampSchema
  })
  .strict();

export type SessionEventEnvelope = z.infer<typeof sessionEventEnvelopeSchema>;

export class FileSessionStore {
  constructor(private readonly stateRoot: string) {}

  async appendApprovalRequest(request: ApprovalRequest): Promise<void> {
    await this.ensureSessionDirectory(request.sessionId);
    await this.appendRecord(this.sessionApprovalRequestsFile(request.sessionId), request);
    await this.appendEvent({
      createdAt: request.createdAt,
      id: this.createEventId("approval_request_appended", request.sessionId, request.id, request.createdAt),
      kind: "approval_request_appended",
      payload: request,
      sessionId: request.sessionId
    });
    await this.updatePendingApprovalsIndex((index) => {
      index.approvals[request.id] = {
        request,
        sessionId: request.sessionId
      };
      return index;
    });
  }

  async appendApprovalResolution(resolution: ApprovalResolution, sessionId: string): Promise<void> {
    await this.ensureSessionDirectory(sessionId);
    await this.appendRecord(this.sessionApprovalResolutionsFile(sessionId), resolution);
    await this.appendEvent({
      createdAt: resolution.decidedAt,
      id: this.createEventId("approval_resolution_appended", sessionId, resolution.id, resolution.decidedAt),
      kind: "approval_resolution_appended",
      payload: resolution,
      sessionId
    });
    await this.updatePendingApprovalsIndex((index) => {
      delete index.approvals[resolution.requestId];
      return index;
    });
  }

  async appendMessages(messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.ensureSessionDirectory(message.sessionId);
      await this.appendRecord(this.sessionMessagesFile(message.sessionId), message);
      await this.appendEvent({
        createdAt: message.createdAt,
        id: this.createEventId("message_appended", message.sessionId, message.id, message.createdAt),
        kind: "message_appended",
        payload: message,
        sessionId: message.sessionId
      });
    }
  }

  async appendSteeringInjections(injections: SteeringInjection[]): Promise<void> {
    for (const injection of injections) {
      await this.ensureSessionDirectory(injection.sessionId);
      await this.appendRecord(this.sessionSteeringFile(injection.sessionId), injection);
      await this.appendEvent({
        createdAt: injection.createdAt,
        id: this.createEventId("steering_appended", injection.sessionId, injection.id, injection.createdAt),
        kind: "steering_appended",
        payload: injection,
        sessionId: injection.sessionId
      });
    }
  }

  async appendToolCalls(toolCalls: ToolCallRecord[]): Promise<void> {
    for (const toolCall of toolCalls) {
      await this.ensureSessionDirectory(toolCall.sessionId);
      await this.appendRecord(this.sessionToolCallsFile(toolCall.sessionId), toolCall);
      await this.appendEvent({
        createdAt: toolCall.startedAt,
        id: this.createEventId("tool_call_appended", toolCall.sessionId, toolCall.id, toolCall.startedAt),
        kind: "tool_call_appended",
        payload: toolCall,
        sessionId: toolCall.sessionId
      });
    }
  }

  async appendTurn(turn: TurnRecord): Promise<void> {
    await this.ensureSessionDirectory(turn.sessionId);
    await this.appendRecord(this.sessionTurnsFile(turn.sessionId), turn);
    await this.appendEvent({
      createdAt: turn.startedAt,
      id: this.createEventId("turn_appended", turn.sessionId, turn.id, turn.startedAt),
      kind: "turn_appended",
      payload: turn,
      sessionId: turn.sessionId
    });
  }

  async appendVoiceCapture(record: VoiceCaptureRecord): Promise<void> {
    await this.ensureSessionDirectory(record.sessionId ?? record.id);
    await this.appendRecord(this.sessionVoiceCapturesFile(record.sessionId ?? record.id), record);
    await this.appendEvent({
      createdAt: record.completedAt ?? record.startedAt,
      id: this.createEventId(
        "voice_capture_appended",
        record.sessionId ?? record.id,
        record.id,
        record.completedAt ?? record.startedAt
      ),
      kind: "voice_capture_appended",
      payload: record,
      sessionId: record.sessionId ?? record.id
    });
  }

  async appendVoicePlayback(record: VoicePlaybackRecord): Promise<void> {
    await this.ensureSessionDirectory(record.sessionId ?? record.id);
    await this.appendRecord(this.sessionVoicePlaybacksFile(record.sessionId ?? record.id), record);
    await this.appendEvent({
      createdAt: record.completedAt ?? record.startedAt,
      id: this.createEventId(
        "voice_playback_appended",
        record.sessionId ?? record.id,
        record.id,
        record.completedAt ?? record.startedAt
      ),
      kind: "voice_playback_appended",
      payload: record,
      sessionId: record.sessionId ?? record.id
    });
  }

  async appendVoiceTranscription(record: VoiceTranscriptionRecord): Promise<void> {
    await this.ensureSessionDirectory(record.sessionId ?? record.id);
    await this.appendRecord(this.sessionVoiceTranscriptionsFile(record.sessionId ?? record.id), record);
    await this.appendEvent({
      createdAt: record.completedAt ?? record.startedAt,
      id: this.createEventId(
        "voice_transcription_appended",
        record.sessionId ?? record.id,
        record.id,
        record.completedAt ?? record.startedAt
      ),
      kind: "voice_transcription_appended",
      payload: record,
      sessionId: record.sessionId ?? record.id
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.readJsonFile(this.sessionMetadataFile(sessionId), sessionRecordSchema);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    return sessionSnapshotSchema.parse({
      approvalRequests: await this.readJsonLines(this.sessionApprovalRequestsFile(sessionId), approvalRequestSchema),
      approvalResolutions: await this.readJsonLines(
        this.sessionApprovalResolutionsFile(sessionId),
        approvalResolutionSchema
      ),
      messages: await this.readLatestJsonLines(this.sessionMessagesFile(sessionId), messageSchema),
      resumeMetadata: await this.readJsonFile(this.sessionResumeMetadataFile(sessionId), sessionResumeMetadataSchema),
      session,
      steeringInjections: await this.readJsonLines(this.sessionSteeringFile(sessionId), steeringInjectionSchema),
      toolCalls: await this.readJsonLines(this.sessionToolCallsFile(sessionId), toolCallRecordSchema),
      turns: await this.readJsonLines(this.sessionTurnsFile(sessionId), turnRecordSchema),
      voiceCaptures: await this.readLatestJsonLines(this.sessionVoiceCapturesFile(sessionId), voiceCaptureRecordSchema),
      voicePlaybacks: await this.readLatestJsonLines(this.sessionVoicePlaybacksFile(sessionId), voicePlaybackRecordSchema),
      voiceTranscriptions: await this.readLatestJsonLines(
        this.sessionVoiceTranscriptionsFile(sessionId),
        voiceTranscriptionRecordSchema
      )
    });
  }

  async listSessions(): Promise<SessionRecord[]> {
    const index = await this.readJsonFile(this.sessionsIndexFile(), z.array(sessionRecordSchema));
    if (index) {
      return index.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    const sessionsDirectory = this.sessionsRoot();
    try {
      const entries = await fs.readdir(sessionsDirectory, { withFileTypes: true });
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => this.getSession(entry.name))
      );
      return sessions.filter((session): session is SessionRecord => session !== null);
    } catch {
      return [];
    }
  }

  async readPendingApprovals(): Promise<Record<string, { request: ApprovalRequest; sessionId: string }>> {
    const index = await this.readJsonFile(this.pendingApprovalsFile(), pendingApprovalsIndexSchema);
    return index?.approvals ?? {};
  }

  async saveResumeMetadata(sessionId: string, metadata: SessionResumeMetadata): Promise<void> {
    await this.ensureSessionDirectory(sessionId);
    await writeJsonAtomic(this.sessionResumeMetadataFile(sessionId), metadata);
    await this.appendEvent({
      createdAt: metadata.updatedAt,
      id: this.createEventId("resume_metadata_saved", sessionId, sessionId, metadata.updatedAt),
      kind: "resume_metadata_saved",
      payload: metadata,
      sessionId
    });
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.ensureSessionDirectory(session.id);
    await writeJsonAtomic(this.sessionMetadataFile(session.id), session);
    await this.appendEvent({
      createdAt: session.updatedAt,
      id: this.createEventId("session_saved", session.id, session.id, session.updatedAt),
      kind: "session_saved",
      payload: session,
      sessionId: session.id
    });
    await this.updateSessionsIndex(session);
  }

  private async appendEvent(event: SessionEventEnvelope): Promise<void> {
    const persistedEvent = sessionEventEnvelopeSchema.parse(event);
    await this.appendRecord(this.sessionEventsFile(persistedEvent.sessionId), persistedEvent);
    await this.appendRecord(this.globalEventsFile(), persistedEvent);
  }

  private createEventId(
    kind: SessionEventEnvelope["kind"],
    sessionId: string,
    recordId: string,
    createdAt: string
  ): string {
    const digest = crypto
      .createHash("sha1")
      .update(`${kind}:${sessionId}:${recordId}:${createdAt}`)
      .digest("hex")
      .slice(0, 20);
    return `evt.${kind}.${digest}`;
  }

  private async appendRecord(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
  }

  private async ensureSessionDirectory(sessionId: string): Promise<void> {
    await fs.mkdir(this.sessionDirectory(sessionId), { recursive: true });
    await fs.mkdir(path.join(this.stateRoot, "approvals"), { recursive: true });
    await fs.mkdir(path.join(this.stateRoot, "logs"), { recursive: true });
  }

  private globalEventsFile(): string {
    return path.join(this.stateRoot, "logs", "session-events.jsonl");
  }

  private pendingApprovalsFile(): string {
    return path.join(this.stateRoot, "approvals", "pending.json");
  }

  private sessionApprovalRequestsFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "approval-requests.jsonl");
  }

  private sessionApprovalResolutionsFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "approval-resolutions.jsonl");
  }

  private sessionDirectory(sessionId: string): string {
    return path.join(this.sessionsRoot(), sessionId);
  }

  private sessionEventsFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "events.jsonl");
  }

  private sessionMessagesFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "messages.jsonl");
  }

  private sessionMetadataFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "session.json");
  }

  private sessionResumeMetadataFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "resume.json");
  }

  private sessionSteeringFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "steering.jsonl");
  }

  private sessionToolCallsFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "tool-calls.jsonl");
  }

  private sessionTurnsFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "turns.jsonl");
  }

  private sessionVoiceCapturesFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "voice-captures.jsonl");
  }

  private sessionVoicePlaybacksFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "voice-playbacks.jsonl");
  }

  private sessionVoiceTranscriptionsFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "voice-transcriptions.jsonl");
  }

  private sessionsIndexFile(): string {
    return path.join(this.sessionsRoot(), "index.json");
  }

  private sessionsRoot(): string {
    return path.join(this.stateRoot, "sessions");
  }

  private async updatePendingApprovalsIndex(
    update: (
      current: z.infer<typeof pendingApprovalsIndexSchema>
    ) => z.infer<typeof pendingApprovalsIndexSchema>
  ): Promise<void> {
    const current =
      (await this.readJsonFile(this.pendingApprovalsFile(), pendingApprovalsIndexSchema)) ?? {
        approvals: {},
        updatedAt: new Date().toISOString()
      };
    const next = update({
      ...current,
      updatedAt: new Date().toISOString()
    });
    await writeJsonAtomic(this.pendingApprovalsFile(), {
      ...next,
      updatedAt: new Date().toISOString()
    });
  }

  private async updateSessionsIndex(session: SessionRecord): Promise<void> {
    const sessions = await this.listSessions();
    const deduped = [...sessions.filter((entry) => entry.id !== session.id), session].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
    await writeJsonAtomic(this.sessionsIndexFile(), deduped);
  }

  private async readJsonFile<TSchema extends z.ZodTypeAny>(
    filePath: string,
    schema: TSchema
  ): Promise<z.output<TSchema> | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return schema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async readJsonLines<TSchema extends z.ZodTypeAny>(
    filePath: string,
    schema: TSchema
  ): Promise<z.output<TSchema>[]> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => schema.parse(JSON.parse(line) as unknown));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readLatestJsonLines<TSchema extends z.ZodTypeAny>(
    filePath: string,
    schema: TSchema
  ): Promise<z.output<TSchema>[]> {
    const rows = await this.readJsonLines(filePath, schema);
    const byId = new Map<string, z.output<TSchema>>();

    for (const row of rows) {
      if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string") {
        continue;
      }
      if (byId.has(row.id)) {
        byId.delete(row.id);
      }
      byId.set(row.id, row);
    }

    return Array.from(byId.values());
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
