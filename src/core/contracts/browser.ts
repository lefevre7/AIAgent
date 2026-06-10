import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  metadataSchema,
  uriSchema
} from "@/core/contracts/common";

export const browserDownloadStatusSchema = z.enum(["cancelled", "failed", "pending", "succeeded"]);

export const browserLocatorSchema = z
  .object({
    ref: z.string().min(1).max(64).optional(),
    selector: z.string().min(1).max(2048).optional()
  })
  .strict();

export const browserPageRecordSchema = z
  .object({
    active: z.boolean(),
    createdAt: isoTimestampSchema,
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    sessionId: entityIdSchema,
    title: z.string().min(1).max(512).optional(),
    url: uriSchema
  })
  .strict();

export const browserElementSnapshotSchema = z
  .object({
    checked: z.boolean().optional(),
    disabled: z.boolean().optional(),
    inputType: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(512).optional(),
    locatorHint: z.string().min(1).max(1024).optional(),
    placeholder: z.string().min(1).max(512).optional(),
    ref: z.string().min(1).max(64),
    role: z.string().min(1).max(128).optional(),
    tagName: z.string().min(1).max(64),
    text: z.string().min(1).max(2000).optional()
  })
  .strict();

export const browserPageSnapshotSchema = z
  .object({
    ariaSnapshot: z.string().min(1).optional(),
    elements: z.array(browserElementSnapshotSchema).max(512).default([]),
    metadata: metadataSchema.default({}),
    pageId: entityIdSchema,
    sessionId: entityIdSchema,
    takenAt: isoTimestampSchema,
    textExcerpt: z.string().min(1).optional(),
    title: z.string().min(1).max(512).optional(),
    truncated: z.boolean().default(false),
    url: uriSchema
  })
  .strict();

export const browserDownloadRecordSchema = z
  .object({
    artifact: artifactReferenceSchema.optional(),
    createdAt: isoTimestampSchema,
    errorMessage: z.string().min(1).optional(),
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    pageId: entityIdSchema,
    sessionId: entityIdSchema,
    status: browserDownloadStatusSchema,
    suggestedFilename: z.string().min(1).max(512).optional(),
    url: uriSchema.optional()
  })
  .strict();

export type BrowserDownloadRecord = z.infer<typeof browserDownloadRecordSchema>;
export type BrowserDownloadStatus = z.infer<typeof browserDownloadStatusSchema>;
export type BrowserElementSnapshot = z.infer<typeof browserElementSnapshotSchema>;
export type BrowserLocator = z.infer<typeof browserLocatorSchema>;
export type BrowserPageRecord = z.infer<typeof browserPageRecordSchema>;
export type BrowserPageSnapshot = z.infer<typeof browserPageSnapshotSchema>;
export type BrowserArtifactReference = z.infer<typeof artifactReferenceSchema>;

export type BrowserClosePageResult = {
  activePageId: string | null;
  closedPageId: string;
  pages: BrowserPageRecord[];
};

export type BrowserListDownloadsParams = {
  limit?: number;
  pageId?: string;
};

export type BrowserListPagesResult = {
  activePageId: string | null;
  pages: BrowserPageRecord[];
};

export type BrowserOpenPageParams = {
  newPage?: boolean;
  pageId?: string;
  sessionId: string;
  url?: string;
};

export type BrowserOpenPageResult = {
  createdPage: boolean;
  navigated: boolean;
  page: BrowserPageRecord;
};

export type BrowserPageActionParams = {
  pageId?: string;
  sessionId: string;
};

export type BrowserPageKeyActionParams = BrowserPageActionParams &
  BrowserLocator & {
    key: string;
  };

export type BrowserPageSelectionActionParams = BrowserPageActionParams &
  BrowserLocator & {
    values: string[];
  };

export type BrowserPageTextActionParams = BrowserPageActionParams &
  BrowserLocator & {
    submit?: boolean;
    text: string;
  };

export type BrowserPageUploadParams = BrowserPageActionParams &
  BrowserLocator & {
    paths: string[];
  };

export type BrowserPageWaitParams = BrowserPageActionParams &
  BrowserLocator & {
    text?: string;
    textGone?: string;
    timeMs?: number;
    timeoutMs?: number;
    url?: string;
  };

export type BrowserPointerActionParams = BrowserPageActionParams &
  BrowserLocator & {
    button?: "left" | "middle" | "right";
    doubleClick?: boolean;
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  };

export type BrowserScreenshotParams = BrowserPageActionParams &
  BrowserLocator & {
    fullPage?: boolean;
    imageType?: "jpeg" | "png";
  };

export type BrowserSnapshotParams = BrowserPageActionParams & {
  maxElements?: number;
  maxTextChars?: number;
};

export interface BrowserAutomationService {
  click(params: BrowserPointerActionParams): Promise<BrowserPageRecord>;
  closePage(params: BrowserPageActionParams): Promise<BrowserClosePageResult>;
  dispose(): Promise<void>;
  fill(params: BrowserPageTextActionParams): Promise<BrowserPageRecord>;
  listDownloads(params: BrowserListDownloadsParams & { sessionId: string }): Promise<BrowserDownloadRecord[]>;
  listPages(sessionId: string): Promise<BrowserListPagesResult>;
  navigate(params: BrowserPageActionParams & { url: string }): Promise<BrowserPageRecord>;
  openPage(params: BrowserOpenPageParams): Promise<BrowserOpenPageResult>;
  press(params: BrowserPageKeyActionParams): Promise<BrowserPageRecord>;
  screenshot(params: BrowserScreenshotParams): Promise<BrowserArtifactReference>;
  selectOptions(params: BrowserPageSelectionActionParams): Promise<BrowserPageRecord>;
  snapshot(params: BrowserSnapshotParams): Promise<BrowserPageSnapshot>;
  type(params: BrowserPageTextActionParams & { delayMs?: number }): Promise<BrowserPageRecord>;
  upload(params: BrowserPageUploadParams): Promise<BrowserPageRecord>;
  waitFor(params: BrowserPageWaitParams): Promise<BrowserPageRecord>;
}
