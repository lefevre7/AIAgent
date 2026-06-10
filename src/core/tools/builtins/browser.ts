import { z } from "zod";

import type {
  BrowserAutomationService,
  BrowserDownloadRecord,
  BrowserPageRecord,
  BrowserPageSnapshot,
  JsonSchemaDocument,
  ToolDefinition
} from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const pageIdSchema = z.string().min(1).max(128).optional();
const refSchema = z.string().min(1).max(64).optional();
const selectorSchema = z.string().min(1).max(2048).optional();

const pageActionSchema = z
  .object({
    pageId: pageIdSchema,
    ref: refSchema,
    selector: selectorSchema
  })
  .strict();

const browserOpenSchema = z
  .object({
    newPage: z.boolean().optional(),
    pageId: pageIdSchema,
    url: z.string().min(1).max(4096).optional()
  })
  .strict();

const browserNavigateSchema = z
  .object({
    pageId: pageIdSchema,
    url: z.string().min(1).max(4096)
  })
  .strict();

const browserSnapshotSchema = z
  .object({
    maxElements: z.number().int().positive().max(512).optional(),
    maxTextChars: z.number().int().positive().max(50_000).optional(),
    pageId: pageIdSchema
  })
  .strict();

const browserScreenshotSchema = pageActionSchema.extend({
  fullPage: z.boolean().optional(),
  imageType: z.enum(["jpeg", "png"]).optional()
});

const browserClickSchema = pageActionSchema.extend({
  button: z.enum(["left", "middle", "right"]).optional(),
  doubleClick: z.boolean().optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).max(8).optional()
});

const browserFillSchema = pageActionSchema.extend({
  submit: z.boolean().optional(),
  text: z.string().min(1)
});

const browserTypeSchema = browserFillSchema.extend({
  delayMs: z.number().int().min(0).max(5000).optional()
});

const browserSelectSchema = pageActionSchema.extend({
  values: z.array(z.string().min(1)).min(1).max(50)
});

const browserPressSchema = pageActionSchema.extend({
  key: z.string().min(1).max(128)
});

const browserUploadSchema = pageActionSchema.extend({
  paths: z.array(z.string().min(1)).min(1).max(32)
});

const browserWaitSchema = pageActionSchema
  .extend({
    text: z.string().min(1).max(2000).optional(),
    textGone: z.string().min(1).max(2000).optional(),
    timeMs: z.number().int().positive().max(300_000).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    url: z.string().min(1).max(4096).optional()
  })
  .superRefine((value, context) => {
    if (value.timeMs || value.text || value.textGone || value.url || value.ref || value.selector) {
      return;
    }

    context.addIssue({
      code: "custom",
      message: "Provide at least one wait target: timeMs, url, text, textGone, ref, or selector."
    });
  });

const browserListDownloadsSchema = z
  .object({
    limit: z.number().int().positive().max(100).optional(),
    pageId: pageIdSchema
  })
  .strict();

const browserClosePageSchema = z
  .object({
    pageId: pageIdSchema
  })
  .strict();

const emptyBrowserSchema = z.object({}).strict();

export function createBrowserTools(params: { browserService: BrowserAutomationService }): RuntimeTool[] {
  return [
    createBrowserOpenTool(params),
    createBrowserListPagesTool(params),
    createBrowserNavigateTool(params),
    createBrowserSnapshotTool(params),
    createBrowserScreenshotTool(params),
    createBrowserClickTool(params),
    createBrowserFillTool(params),
    createBrowserTypeTool(params),
    createBrowserSelectOptionTool(params),
    createBrowserPressKeyTool(params),
    createBrowserUploadTool(params),
    createBrowserWaitTool(params),
    createBrowserListDownloadsTool(params),
    createBrowserClosePageTool(params)
  ];
}

export function createBrowserOpenTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return {
    definition: browserOpenToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = browserOpenSchema.parse(call.arguments as unknown);
      const opened = await params.browserService.openPage({
        ...input,
        sessionId: context.session.id
      });

      return {
        display: [
          {
            kind: "status",
            state: opened.navigated ? "navigated" : opened.createdPage ? "opened" : "focused",
            summary: `Active page ${opened.page.id} at ${opened.page.url}`
          }
        ],
        result: opened
      };
    }
  };
}

export function createBrowserListPagesTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return {
    definition: browserListPagesToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      emptyBrowserSchema.parse(call.arguments as unknown);
      const pages = await params.browserService.listPages(context.session.id);

      return {
        display: [
          {
            kind: "markdown",
            markdown: renderPagesMarkdown(pages.pages, pages.activePageId)
          }
        ],
        result: pages
      };
    }
  };
}

export function createBrowserNavigateTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return {
    definition: browserNavigateToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = browserNavigateSchema.parse(call.arguments as unknown);
      const page = await params.browserService.navigate({
        ...input,
        sessionId: context.session.id
      });

      return {
        display: [
          {
            kind: "status",
            state: "navigated",
            summary: `Navigated ${page.id} to ${page.url}`
          }
        ],
        result: page
      };
    }
  };
}

export function createBrowserSnapshotTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return {
    definition: browserSnapshotToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = browserSnapshotSchema.parse(call.arguments as unknown);
      const snapshot = await params.browserService.snapshot({
        ...input,
        sessionId: context.session.id
      });

      return {
        display: [
          {
            kind: "markdown",
            markdown: renderSnapshotMarkdown(snapshot)
          }
        ],
        result: snapshot
      };
    }
  };
}

export function createBrowserScreenshotTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return {
    definition: browserScreenshotToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = browserScreenshotSchema.parse(call.arguments as unknown);
      const artifact = await params.browserService.screenshot({
        ...input,
        sessionId: context.session.id
      });

      return {
        artifacts: [artifact],
        display: [
          {
            kind: "status",
            state: "captured",
            summary: `Saved browser screenshot to ${artifact.uri}`
          }
        ],
        result: {
          artifact
        }
      };
    }
  };
}

export function createBrowserClickTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return createPageMutationTool({
    browserService: params.browserService,
    definition: browserClickToolDefinition,
    execute: (sessionId, input) =>
      params.browserService.click({
        ...input,
        sessionId
      }),
    schema: browserClickSchema,
    successState: "clicked"
  });
}

export function createBrowserFillTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return createPageMutationTool({
    browserService: params.browserService,
    definition: browserFillToolDefinition,
    execute: (sessionId, input) =>
      params.browserService.fill({
        ...input,
        sessionId
      }),
    schema: browserFillSchema,
    successState: "filled"
  });
}

export function createBrowserTypeTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return createPageMutationTool({
    browserService: params.browserService,
    definition: browserTypeToolDefinition,
    execute: (sessionId, input) =>
      params.browserService.type({
        ...input,
        sessionId
      }),
    schema: browserTypeSchema,
    successState: "typed"
  });
}

export function createBrowserSelectOptionTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return createPageMutationTool({
    browserService: params.browserService,
    definition: browserSelectOptionToolDefinition,
    execute: (sessionId, input) =>
      params.browserService.selectOptions({
        ...input,
        sessionId
      }),
    schema: browserSelectSchema,
    successState: "selected"
  });
}

export function createBrowserPressKeyTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return createPageMutationTool({
    browserService: params.browserService,
    definition: browserPressKeyToolDefinition,
    execute: (sessionId, input) =>
      params.browserService.press({
        ...input,
        sessionId
      }),
    schema: browserPressSchema,
    successState: "pressed"
  });
}

export function createBrowserUploadTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return createPageMutationTool({
    browserService: params.browserService,
    definition: browserUploadToolDefinition,
    execute: (sessionId, input) =>
      params.browserService.upload({
        ...input,
        sessionId
      }),
    schema: browserUploadSchema,
    successState: "uploaded"
  });
}

export function createBrowserWaitTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return createPageMutationTool({
    browserService: params.browserService,
    definition: browserWaitToolDefinition,
    execute: (sessionId, input) =>
      params.browserService.waitFor({
        ...input,
        sessionId
      }),
    schema: browserWaitSchema,
    successState: "ready"
  });
}

export function createBrowserListDownloadsTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return {
    definition: browserListDownloadsToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = browserListDownloadsSchema.parse(call.arguments as unknown);
      const downloads = await params.browserService.listDownloads({
        ...input,
        sessionId: context.session.id
      });

      return {
        artifacts: downloads.flatMap((download) => (download.artifact ? [download.artifact] : [])),
        display: [
          {
            kind: "markdown",
            markdown: renderDownloadsMarkdown(downloads)
          }
        ],
        result: {
          downloads
        }
      };
    }
  };
}

export function createBrowserClosePageTool(params: { browserService: BrowserAutomationService }): RuntimeTool {
  return {
    definition: browserClosePageToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = browserClosePageSchema.parse(call.arguments as unknown);
      const result = await params.browserService.closePage({
        ...input,
        sessionId: context.session.id
      });

      return {
        display: [
          {
            kind: "status",
            state: "closed",
            summary: `Closed page ${result.closedPageId}. ${result.pages.length} page(s) remain open.`
          }
        ],
        result
      };
    }
  };
}

type PageMutationToolParams<TSchema extends z.ZodTypeAny> = {
  browserService: BrowserAutomationService;
  definition: ToolDefinition;
  execute: (sessionId: string, input: z.infer<TSchema>) => Promise<BrowserPageRecord>;
  schema: TSchema;
  successState: string;
};

function createPageMutationTool<TSchema extends z.ZodTypeAny>(params: PageMutationToolParams<TSchema>): RuntimeTool {
  return {
    definition: params.definition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = params.schema.parse(call.arguments as unknown);
      const page = await params.execute(context.session.id, input);
      return {
        display: [
          {
            kind: "status",
            state: params.successState,
            summary: `${page.id} is now at ${page.url}`
          }
        ],
        result: page
      };
    }
  };
}

function createBrowserToolDefinition(params: {
  aliases?: string[];
  approvalMode: ToolDefinition["approvalMode"];
  description: string;
  descriptor: ToolDefinition["descriptor"];
  execution?: ToolDefinition["execution"];
  inputSchema: JsonSchemaDocument;
  invocationName: string;
  outputKind?: ToolDefinition["outputKind"];
  outputSchema?: JsonSchemaDocument;
  purposeTags: string[];
  readOnly: boolean;
  retryable?: boolean;
  sideEffects: ToolDefinition["sideEffects"];
  toolId: string;
  usageGuidance: string;
}): ToolDefinition {
  return {
    aliases: params.aliases ?? [],
    annotations: {
      destructiveHint: !params.readOnly,
      idempotentHint: params.readOnly,
      meta: {
        family: "browser"
      },
      openWorldHint: true,
      readOnlyHint: params.readOnly,
      title: toTitle(params.invocationName)
    },
    approvalMode: params.approvalMode,
    descriptor: params.descriptor,
    description: params.description,
    displayName: toTitle(params.invocationName),
    execution: params.execution ?? {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: params.readOnly,
    inputSchema: params.inputSchema,
    invocationName: params.invocationName,
    kind: "browser",
    metadata: {},
    name: params.invocationName,
    outputKind: params.outputKind ?? "json",
    outputSchema: params.outputSchema,
    retryable: params.retryable ?? true,
    searchTags: ["browser", ...params.purposeTags],
    sideEffects: params.sideEffects,
    source: {
      displayName: "Built-in Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: params.toolId,
    usageGuidance: params.usageGuidance,
    version: "1.0.0"
  };
}

export const browserOpenToolDefinition = createBrowserToolDefinition({
  aliases: ["open_browser_page"],
  approvalMode: "ask",
  description:
    "Open the Playwright browser session for the current task, create or focus a page, and optionally navigate it to a URL.",
  descriptor: {
    approvalNotes: "Operator approval is required because opening or navigating a browser page can reach external systems.",
    examples: ["Start a browser page on the documentation URL before inspecting it."],
    purpose: "Create or focus the current browser page for this task so later browser tools act against a stable session.",
    sideEffectSummary: "May create a browser page and may perform a network navigation.",
    whenNotToUse: ["Do not use when an active page already exists and you only need to inspect or interact with it."],
    whenToUse: [
      "Use before any other browser tool when no browser page is open yet.",
      "Use to create a fresh page or move the active page to a known URL."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      newPage: { type: "boolean" },
      pageId: { type: "string" },
      url: { type: "string" }
    },
    type: "object"
  },
  invocationName: "browser_open",
  purposeTags: ["navigate", "page", "session", "start"],
  readOnly: false,
  sideEffects: ["network_read"],
  toolId: "tool.browser.open",
  usageGuidance: "Use first to create or focus the task browser page. Set newPage when you need a clean tab."
});

export const browserListPagesToolDefinition = createBrowserToolDefinition({
  aliases: ["browser_tabs"],
  approvalMode: "never",
  description: "List the currently open browser pages for the current task session and show which one is active.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads browser session state.",
    examples: ["Check which tab is active before closing one.", "List open pages after a popup or new window appears."],
    purpose: "Inspect the current browser page set before switching, closing, or navigating pages.",
    sideEffectSummary: "Reads browser session metadata only.",
    whenNotToUse: ["Do not use when you already know the active page and only need to act on it."],
    whenToUse: [
      "Use after navigation or popup flows to see which pages are open.",
      "Use before close operations when multiple pages may exist."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {},
    type: "object"
  },
  invocationName: "browser_list_pages",
  purposeTags: ["inspect", "pages", "tabs"],
  readOnly: true,
  sideEffects: ["none"],
  toolId: "tool.browser.list_pages",
  usageGuidance: "Use when you need page ids, titles, URLs, or the current active page before taking the next browser action."
});

export const browserNavigateToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Navigate an existing browser page to a new URL and make it the active page.",
  descriptor: {
    approvalNotes: "Operator approval is required because navigation reaches external systems.",
    examples: ["Move the active page from the search results to the selected docs URL."],
    purpose: "Explicitly move a specific browser page to a new URL after the browser session already exists.",
    sideEffectSummary: "Performs network navigation on an existing page.",
    whenNotToUse: ["Do not use this when you need to create the initial browser page; use browser_open first."],
    whenToUse: [
      "Use when the session already has a page and you need to move it to a new URL.",
      "Use when you want to keep page history in the same tab instead of creating a new one."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
      url: { type: "string" }
    },
    required: ["url"],
    type: "object"
  },
  invocationName: "browser_navigate",
  purposeTags: ["go", "navigate", "url"],
  readOnly: false,
  sideEffects: ["network_read"],
  toolId: "tool.browser.navigate",
  usageGuidance: "Use after browser_open when you want to keep working inside the same page but move it to a different URL."
});

export const browserSnapshotToolDefinition = createBrowserToolDefinition({
  aliases: ["browser_dom_snapshot"],
  approvalMode: "never",
  description:
    "Capture a high-signal accessibility and interactive-element snapshot of the active browser page, including actionable refs for later tools.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads the current page state.",
    examples: [
      "Take a snapshot before clicking anything on a new page.",
      "Refresh the refs after the page changes so later browser actions target the right elements."
    ],
    purpose: "Inspect the current page and generate fresh element refs that other browser tools can use safely.",
    sideEffectSummary: "Reads the current browser page and annotates in-memory refs for later actions.",
    whenNotToUse: ["Do not use when you already know the exact selector or ref for the next action."],
    whenToUse: [
      "Use immediately after opening or navigating a page.",
      "Use again after the page changes so refs stay current."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      maxElements: { maximum: 512, minimum: 1, type: "integer" },
      maxTextChars: { maximum: 50000, minimum: 1, type: "integer" },
      pageId: { type: "string" }
    },
    type: "object"
  },
  invocationName: "browser_snapshot",
  outputKind: "mixed",
  purposeTags: ["accessibility", "inspect", "refs", "snapshot"],
  readOnly: true,
  sideEffects: ["none"],
  toolId: "tool.browser.snapshot",
  usageGuidance:
    "Use before interacting with a page when you need fresh refs. Prefer ref-based actions after taking a fresh snapshot."
});

export const browserScreenshotToolDefinition = createBrowserToolDefinition({
  approvalMode: "never",
  description: "Capture a screenshot of the current page or a specific referenced/selected element and store it as an artifact.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only captures the current rendered page state.",
    examples: ["Capture the whole page after a navigation.", "Capture a specific form or error element by ref."],
    purpose: "Create a durable visual artifact of the current page state for review, comparison, or later discussion.",
    sideEffectSummary: "Reads the current browser page and stores a local screenshot artifact.",
    whenNotToUse: ["Do not use when a text snapshot is enough; browser_snapshot is usually cheaper and easier to reason about."],
    whenToUse: [
      "Use when visual layout matters.",
      "Use when you need an image artifact to inspect or share later."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      fullPage: { type: "boolean" },
      imageType: { enum: ["jpeg", "png"], type: "string" },
      pageId: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" }
    },
    type: "object"
  },
  invocationName: "browser_screenshot",
  outputKind: "artifact",
  purposeTags: ["capture", "image", "screenshot", "visual"],
  readOnly: true,
  sideEffects: ["none"],
  toolId: "tool.browser.screenshot",
  usageGuidance: "Use when visual verification matters or when you need a durable image artifact from the current page."
});

export const browserClickToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Click or double-click a page element by fresh snapshot ref or explicit selector.",
  descriptor: {
    approvalNotes: "Operator approval is required because clicks can submit forms, mutate remote state, or trigger downloads.",
    examples: ["Click the primary button by ref after taking a fresh snapshot."],
    purpose: "Perform the safest explicit pointer interaction against a referenced page element.",
    sideEffectSummary: "Mutates page state and may trigger remote or local side effects.",
    whenNotToUse: ["Do not use when you first need to discover the target element; use browser_snapshot before clicking."],
    whenToUse: [
      "Use when a page element needs a mouse click to continue the task.",
      "Use with a fresh ref whenever possible instead of guessing selectors."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      button: { enum: ["left", "middle", "right"], type: "string" },
      doubleClick: { type: "boolean" },
      modifiers: {
        items: { enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"], type: "string" },
        type: "array"
      },
      pageId: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" }
    },
    type: "object"
  },
  invocationName: "browser_click",
  purposeTags: ["click", "pointer"],
  readOnly: false,
  sideEffects: ["network_write", "remote_mutation"],
  toolId: "tool.browser.click",
  usageGuidance: "Use with a fresh ref after browser_snapshot whenever possible. Clicks can have real side effects, so avoid guessing."
});

export const browserFillToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Fill an input, textarea, or contenteditable element with replacement text.",
  descriptor: {
    approvalNotes: "Operator approval is required because filling forms can submit or stage changes on remote systems.",
    examples: ["Fill a search box or form field by ref after a fresh snapshot."],
    purpose: "Populate a text-like input reliably when you want to replace the field contents.",
    sideEffectSummary: "Mutates page form state and can affect later submissions.",
    whenNotToUse: ["Do not use when special keyboard handling matters; use browser_type for per-key events."],
    whenToUse: [
      "Use for ordinary form fields where replacing the content is correct.",
      "Use with submit=true when the form expects Enter after the field is filled."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" },
      submit: { type: "boolean" },
      text: { type: "string" }
    },
    required: ["text"],
    type: "object"
  },
  invocationName: "browser_fill",
  purposeTags: ["fill", "form", "input", "text"],
  readOnly: false,
  sideEffects: ["remote_mutation"],
  toolId: "tool.browser.fill",
  usageGuidance: "Prefer this over browser_type for normal inputs. Use browser_type only when the page depends on real key events."
});

export const browserTypeToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Type text character-by-character into a page element, emitting real key events.",
  descriptor: {
    approvalNotes: "Operator approval is required because typing changes page state and can trigger handlers on each key press.",
    examples: ["Type into an autocomplete box that reacts to each keystroke."],
    purpose: "Use real keyboard-style text input when the page has special key handling or autocomplete behavior.",
    sideEffectSummary: "Mutates page form state and triggers key-driven page behavior.",
    whenNotToUse: ["Do not use when a simple replacement fill is enough; browser_fill is faster and more reliable."],
    whenToUse: [
      "Use when the site reacts to each key press.",
      "Use when you need artificial key delays or keyboard-driven widgets."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      delayMs: { maximum: 5000, minimum: 0, type: "integer" },
      pageId: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" },
      submit: { type: "boolean" },
      text: { type: "string" }
    },
    required: ["text"],
    type: "object"
  },
  invocationName: "browser_type",
  purposeTags: ["keyboard", "type"],
  readOnly: false,
  sideEffects: ["remote_mutation"],
  toolId: "tool.browser.type",
  usageGuidance: "Use only when key-by-key input matters. For ordinary text fields, browser_fill is preferred."
});

export const browserSelectOptionToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Select one or more options in a <select> control by value or visible label.",
  descriptor: {
    approvalNotes: "Operator approval is required because selecting options changes page state and can trigger remote mutations.",
    examples: ["Pick the environment or filter option from a dropdown control."],
    purpose: "Change a native <select> control without guessing keyboard sequences.",
    sideEffectSummary: "Mutates form state and can trigger onchange logic.",
    whenNotToUse: ["Do not use this for custom combobox widgets that are not native <select> elements."],
    whenToUse: [
      "Use for native select dropdowns discovered in a fresh browser snapshot.",
      "Pass visible labels or values; the tool resolves both."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" },
      values: {
        items: { type: "string" },
        minItems: 1,
        type: "array"
      }
    },
    required: ["values"],
    type: "object"
  },
  invocationName: "browser_select_option",
  purposeTags: ["dropdown", "form", "select"],
  readOnly: false,
  sideEffects: ["remote_mutation"],
  toolId: "tool.browser.select_option",
  usageGuidance: "Use for native select controls. Provide visible labels or option values and prefer refs from a fresh snapshot."
});

export const browserPressKeyToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Send a key or shortcut to the active page or a specific element.",
  descriptor: {
    approvalNotes: "Operator approval is required because key presses can submit forms, delete content, or trigger commands.",
    examples: ["Press Enter after filling a search box.", "Send Escape to close an overlay."],
    purpose: "Drive pages that depend on keyboard shortcuts or non-text key presses.",
    sideEffectSummary: "Mutates page state and may trigger remote actions.",
    whenNotToUse: ["Do not use for ordinary text input; use browser_fill or browser_type instead."],
    whenToUse: [
      "Use for Enter, Escape, arrows, tabbing, or shortcuts.",
      "Use after targeting a specific element when focus matters."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      key: { type: "string" },
      pageId: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" }
    },
    required: ["key"],
    type: "object"
  },
  invocationName: "browser_press_key",
  purposeTags: ["keyboard", "shortcut"],
  readOnly: false,
  sideEffects: ["remote_mutation"],
  toolId: "tool.browser.press_key",
  usageGuidance: "Use for keys and shortcuts, not for regular text entry."
});

export const browserUploadToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Attach one or more local files to a file input in the browser page.",
  descriptor: {
    approvalNotes: "Operator approval is required because this sends local files into the page and may upload them remotely.",
    examples: ["Upload the generated report file through a file input by ref."],
    purpose: "Bridge local files into a browser form when the task requires a file upload.",
    sideEffectSummary: "Reads local files and mutates remote page state.",
    whenNotToUse: ["Do not use until you have the exact input ref or selector and the file paths are confirmed."],
    whenToUse: [
      "Use for native file inputs after taking a fresh browser snapshot.",
      "Use when a task explicitly requires attaching local files."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
      paths: {
        items: { type: "string" },
        minItems: 1,
        type: "array"
      },
      ref: { type: "string" },
      selector: { type: "string" }
    },
    required: ["paths"],
    type: "object"
  },
  invocationName: "browser_upload_file",
  purposeTags: ["attach", "file", "upload"],
  readOnly: false,
  sideEffects: ["remote_mutation", "workspace_read"],
  toolId: "tool.browser.upload_file",
  usageGuidance: "Use only after the file input is identified and the local file paths are correct."
});

export const browserWaitToolDefinition = createBrowserToolDefinition({
  approvalMode: "never",
  description: "Wait for a page condition such as a target element, URL, visible text, disappearing text, or a fixed delay.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only waits for page state to settle.",
    examples: ["Wait for results text after submitting a search.", "Wait for a loading banner to disappear."],
    purpose: "Pause until the page reaches a known condition before taking the next browser action.",
    sideEffectSummary: "Reads page state and waits for it to change.",
    whenNotToUse: ["Do not use arbitrary sleeps when a specific selector, text, or URL condition is available."],
    whenToUse: [
      "Use after actions that cause async page changes.",
      "Prefer specific conditions over timeMs whenever possible."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
      ref: { type: "string" },
      selector: { type: "string" },
      text: { type: "string" },
      textGone: { type: "string" },
      timeMs: { maximum: 300000, minimum: 1, type: "integer" },
      timeoutMs: { maximum: 300000, minimum: 1, type: "integer" },
      url: { type: "string" }
    },
    type: "object"
  },
  invocationName: "browser_wait",
  purposeTags: ["ready", "wait"],
  readOnly: true,
  sideEffects: ["none"],
  toolId: "tool.browser.wait",
  usageGuidance: "Prefer waiting on a concrete selector, ref, text, or URL over arbitrary time-based sleeps."
});

export const browserListDownloadsToolDefinition = createBrowserToolDefinition({
  aliases: ["browser_downloads"],
  approvalMode: "never",
  description: "List files downloaded by the current browser session and return completed ones as artifacts.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only inspects already-triggered browser downloads.",
    examples: ["Check whether clicking a download link produced a file.", "Retrieve the artifact for the most recent report download."],
    purpose: "Inspect and retrieve browser download artifacts after a page action may have triggered them.",
    sideEffectSummary: "Reads download state and surfaces completed local artifacts.",
    whenNotToUse: ["Do not use before any page action could have triggered a download."],
    whenToUse: [
      "Use after clicking a download link or button.",
      "Use when you need the local artifact path or metadata for a downloaded file."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: { maximum: 100, minimum: 1, type: "integer" },
      pageId: { type: "string" }
    },
    type: "object"
  },
  invocationName: "browser_list_downloads",
  outputKind: "mixed",
  purposeTags: ["artifact", "download", "files"],
  readOnly: true,
  sideEffects: ["none"],
  toolId: "tool.browser.list_downloads",
  usageGuidance: "Use after actions that may have triggered a download. Completed downloads are returned as local artifacts."
});

export const browserClosePageToolDefinition = createBrowserToolDefinition({
  approvalMode: "ask",
  description: "Close the current or specified browser page and return the remaining page state.",
  descriptor: {
    approvalNotes: "Operator approval is required because closing a page can discard interactive state needed for later steps.",
    examples: ["Close a popup after extracting the information you needed from it."],
    purpose: "Remove no-longer-needed browser pages from the session cleanly.",
    sideEffectSummary: "Closes an in-memory browser page and discards its live interactive state.",
    whenNotToUse: ["Do not use if you may still need the page history or DOM state for later steps."],
    whenToUse: [
      "Use when popups or extra pages are cluttering the session.",
      "Use after a page is no longer needed and you want to keep the browser session tidy."
    ]
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      pageId: { type: "string" }
    },
    type: "object"
  },
  invocationName: "browser_close_page",
  purposeTags: ["close", "pages", "tabs"],
  readOnly: false,
  sideEffects: ["none"],
  toolId: "tool.browser.close_page",
  usageGuidance: "Use sparingly. Closing a page removes its live state from the current browser session."
});

function toTitle(invocationName: string): string {
  return invocationName
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function renderPagesMarkdown(pages: BrowserPageRecord[], activePageId: string | null): string {
  if (pages.length === 0) {
    return "No browser pages are currently open for this session.";
  }

  const rows = pages.map((page) => `- ${page.id}${page.id === activePageId ? " (active)" : ""}: ${page.title ?? "(untitled)"} — ${page.url}`);
  return ["Open browser pages:", ...rows].join("\n");
}

function renderSnapshotMarkdown(snapshot: BrowserPageSnapshot): string {
  const lines = [`# ${snapshot.title ?? "Browser Snapshot"}`, `URL: ${snapshot.url}`];

  if (snapshot.elements.length > 0) {
    lines.push("", "## Interactive Elements");
    for (const element of snapshot.elements) {
      const detailParts = [
        `[${element.ref}]`,
        element.tagName,
        element.role ? `role=${element.role}` : null,
        element.label ? `label="${element.label}"` : null,
        element.text ? `text="${element.text}"` : null,
        element.placeholder ? `placeholder="${element.placeholder}"` : null
      ].filter(Boolean);
      lines.push(`- ${detailParts.join(" ")}`);
    }
  }

  if (snapshot.ariaSnapshot) {
    lines.push("", "## ARIA Snapshot", "```yaml", snapshot.ariaSnapshot, "```");
  }

  if (snapshot.textExcerpt) {
    lines.push("", "## Text Excerpt", snapshot.textExcerpt);
  }

  if (snapshot.truncated) {
    lines.push("", "_The text excerpt was truncated._");
  }

  return lines.join("\n");
}

function renderDownloadsMarkdown(downloads: BrowserDownloadRecord[]): string {
  if (downloads.length === 0) {
    return "No downloads have been captured for this browser session yet.";
  }

  return [
    "Browser downloads:",
    ...downloads.map((download) => {
      const suffix = download.artifact ? ` -> ${download.artifact.uri}` : "";
      return `- ${download.id} [${download.status}] ${download.suggestedFilename ?? "(unnamed)"}${suffix}`;
    })
  ].join("\n");
}
