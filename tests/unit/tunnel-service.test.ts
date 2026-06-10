import { describe, expect, test } from "vitest";

import { createDefaultAppConfig } from "@/core";
import { TunnelService } from "@/core/tunnel";

describe("TunnelService", () => {
  test("reports disabled tunnel status when tunneling is off", () => {
    const config = createDefaultAppConfig({
      userStateDirectory: "/tmp/aia"
    });
    const service = new TunnelService({
      gatewayConfig: config.gateway,
      tunnelConfig: config.tunnel
    });

    expect(service.getStatus()).toMatchObject({
      enabled: false,
      exposures: [],
      provider: "none",
      ready: false
    });
  });

  test("derives remote web and gateway exposures from the configured public base URL", () => {
    const config = createDefaultAppConfig({
      userStateDirectory: "/tmp/aia"
    });
    const service = new TunnelService({
      authToken: "secret-token",
      gatewayConfig: config.gateway,
      tunnelConfig: {
        ...config.tunnel,
        enabled: true,
        provider: "tailscale",
        publicBaseUrl: "https://agent.example.ts.net"
      }
    });

    const status = service.getStatus();

    expect(status.ready).toBe(true);
    expect(status.exposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/",
          publicUrl: "https://agent.example.ts.net/",
          surface: "web"
        }),
        expect.objectContaining({
          path: "/api/gateway",
          publicUrl: "https://agent.example.ts.net/api/gateway",
          surface: "gateway_http"
        }),
        expect.objectContaining({
          path: config.gateway.websocketPath,
          publicUrl: `wss://agent.example.ts.net${config.gateway.websocketPath}`,
          surface: "gateway_websocket"
        })
      ])
    );
  });
});
