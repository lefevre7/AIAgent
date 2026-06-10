import crypto from "node:crypto";

import { expect, test } from "@playwright/test";

test("completes session-create and session-message flows through gateway HTTP", async ({ request }) => {
  const created = await request.post("/api/gateway/request", {
    data: gatewayRequest("session.create", {
      cwd: process.cwd(),
      goal: "Complete the fake gateway task.",
      initialMessage: {
        text: "Finish the gateway end-to-end task."
      },
      metadata: {
        surface: "e2e"
      },
      tags: [],
      title: "Gateway E2E Session"
    })
  });

  const createPayload = (await created.json()) as {
    ok: boolean;
    payload: {
      run: {
        id: string;
      };
      session: {
        id: string;
      };
    };
  };

  expect(createPayload.ok).toBe(true);
  const sessionId = createPayload.payload.session.id;

  await expect
    .poll(async () => {
      const snapshotResponse = await request.get(`/api/gateway/sessions/${encodeURIComponent(sessionId)}/snapshot`);
      const snapshot = (await snapshotResponse.json()) as {
        snapshot: {
          messages: Array<{
            parts: Array<{ kind: string; text?: string }>;
            role: string;
          }>;
          session: {
            status: string;
          };
        };
      };

      return {
        assistantMessages: snapshot.snapshot.messages.filter((message) => message.role === "assistant").length,
        status: snapshot.snapshot.session.status
      };
    })
    .toEqual({
      assistantMessages: 1,
      status: "completed"
    });

  await expect
    .poll(async () => {
      const messageResponse = await request.post("/api/gateway/request", {
        data: gatewayRequest("session.message", {
          sessionId,
          text: "Continue from the gateway request path."
        })
      });
      const messagePayload = (await messageResponse.json()) as {
        ok: boolean;
      };
      return messagePayload.ok;
    })
    .toBe(true);

  await expect
    .poll(async () => {
      const snapshotResponse = await request.get(`/api/gateway/sessions/${encodeURIComponent(sessionId)}/snapshot`);
      const snapshot = (await snapshotResponse.json()) as {
        snapshot: {
          messages: Array<{
            parts: Array<{ kind: string; text?: string }>;
            role: string;
          }>;
          session: {
            status: string;
          };
        };
      };

      return {
        assistantMessages: snapshot.snapshot.messages.filter((message) => message.role === "assistant").length,
        status: snapshot.snapshot.session.status
      };
    })
    .toEqual({
      assistantMessages: 2,
      status: "completed"
    });
});

function gatewayRequest(topic: string, payload: Record<string, unknown>) {
  return {
    createdAt: new Date().toISOString(),
    id: `gateway-request.e2e.${topic}.${crypto.randomUUID()}`,
    metadata: {
      surface: "e2e"
    },
    payload,
    topic
  };
}
