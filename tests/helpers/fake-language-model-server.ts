import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

type FakeLanguageModelRequest = {
  body: Record<string, unknown> | null;
  method: string;
  path: string;
  provider: "lm_studio" | "ollama" | "unknown";
};

type FakeLanguageModelPlan = {
  content: string;
  toolCalls?: Array<{
    arguments?: Record<string, unknown>;
    id?: string;
    name: string;
  }>;
};

export type FakeLanguageModelServer = {
  baseUrl: string;
  close(): Promise<void>;
  requests: FakeLanguageModelRequest[];
};

export async function startFakeLanguageModelServer(
  options: {
    modelId?: string;
    plan?: (request: FakeLanguageModelRequest) => FakeLanguageModelPlan | Promise<FakeLanguageModelPlan>;
  } = {}
): Promise<FakeLanguageModelServer> {
  const requests: FakeLanguageModelRequest[] = [];
  const modelId = options.modelId ?? "fake-lm-studio-model";
  let responseCounter = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/models") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ data: [{ id: modelId }] }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tags") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ models: [{ model: modelId, name: modelId }] }));
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/chat/completions" || url.pathname === "/api/chat")
    ) {
      const body = await readJsonBody(request);
      const provider = url.pathname === "/chat/completions" ? "lm_studio" : "ollama";
      const recordedRequest: FakeLanguageModelRequest = {
        body,
        method: request.method,
        path: url.pathname,
        provider
      };
      requests.push(recordedRequest);

      const plan = await (options.plan?.(recordedRequest) ?? buildDefaultPlan(recordedRequest));
      responseCounter += 1;

      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(
        JSON.stringify(
          provider === "lm_studio"
            ? buildLmStudioResponse({
                modelId,
                plan,
                sequence: responseCounter
              })
            : buildOllamaResponse({
                modelId,
                plan
              })
        )
      );
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({ error: `No fake handler for ${request.method ?? "GET"} ${url.pathname}` }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the fake language-model server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
    requests
  };
}

function buildDefaultPlan(request: FakeLanguageModelRequest): FakeLanguageModelPlan {
  const tools = Array.isArray(request.body?.tools) ? request.body.tools : [];
  const hasAttemptComplete = tools.some((tool) => {
    if (typeof tool !== "object" || tool === null) {
      return false;
    }

    const name = (tool as { function?: { name?: string } }).function?.name;
    return name === "attempt_complete";
  });

  return {
    content: `Completed fake task for ${extractLastUserText(request.body) ?? "the shared runtime request"}.`,
    toolCalls: hasAttemptComplete
      ? [
          {
            arguments: {},
            id: `fake-tool.attempt-complete.${Math.random().toString(16).slice(2, 10)}`,
            name: "attempt_complete"
          }
        ]
      : []
  };
}

function buildLmStudioResponse(params: {
  modelId: string;
  plan: FakeLanguageModelPlan;
  sequence: number;
}) {
  return {
    choices: [
      {
        finish_reason: (params.plan.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop",
        message: {
          content: params.plan.content,
          tool_calls: (params.plan.toolCalls ?? []).map((toolCall, index) => ({
            function: {
              arguments: JSON.stringify(toolCall.arguments ?? {}),
              name: toolCall.name
            },
            id: toolCall.id ?? `fake-openai-tool.${params.sequence}.${index + 1}`,
            type: "function"
          }))
        }
      }
    ],
    id: `chatcmpl.fake.${params.sequence}`,
    model: params.modelId,
    usage: {
      completion_tokens: 18,
      prompt_tokens: 42,
      total_tokens: 60
    }
  };
}

function buildOllamaResponse(params: { modelId: string; plan: FakeLanguageModelPlan }) {
  return {
    done: true,
    done_reason: (params.plan.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop",
    eval_count: 18,
    message: {
      content: params.plan.content,
      tool_calls: (params.plan.toolCalls ?? []).map((toolCall) => ({
        function: {
          arguments: toolCall.arguments ?? {},
          name: toolCall.name
        }
      }))
    },
    model: params.modelId,
    prompt_eval_count: 42
  };
}

function extractLastUserText(body: Record<string, unknown> | null): string | null {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUserMessage = messages
    .slice()
    .reverse()
    .find((entry) => typeof entry === "object" && entry !== null && (entry as { role?: string }).role === "user");

  if (!lastUserMessage || typeof lastUserMessage !== "object" || lastUserMessage === null) {
    return null;
  }

  const content = (lastUserMessage as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    const text = content
      .flatMap((entry) => {
        if (typeof entry === "string") {
          return [entry];
        }
        if (typeof entry === "object" && entry !== null && (entry as { type?: string }).type === "text") {
          const value = (entry as { text?: unknown }).text;
          return typeof value === "string" ? [value] : [];
        }
        return [];
      })
      .join(" ")
      .trim();
    return text || null;
  }

  return null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return null;
  }

  return JSON.parse(raw) as Record<string, unknown>;
}
