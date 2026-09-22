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

  // The public-URL accessors are what a caller uses to tell someone where to
  // reach this machine (a webhook registration, a shared attach link), so they
  // must agree with the exposures the status reports — and must say "nothing"
  // rather than a localhost URL when no tunnel is configured.
  test("exposes public base, http, and websocket URLs derived from the tunnel host", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aia" });
    const service = new TunnelService({
      authToken: "secret",
      gatewayConfig: config.gateway,
      tunnelConfig: {
        ...config.tunnel,
        enabled: true,
        provider: "tailscale",
        publicBaseUrl: "https://agent.example.ts.net"
      }
    });

    expect(service.getPublicBaseUrl()).toBe("https://agent.example.ts.net");
    expect(service.getPublicUrl("/api/channels/whatsapp/webhook")).toBe(
      "https://agent.example.ts.net/api/channels/whatsapp/webhook"
    );
    // A websocket URL must switch scheme, not just reuse the https origin.
    expect(service.getPublicWebSocketUrl(config.gateway.websocketPath)).toBe(
      `wss://agent.example.ts.net${config.gateway.websocketPath}`
    );
  });

  test("reports no public URLs when no tunnel host is configured", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aia" });
    const service = new TunnelService({
      gatewayConfig: config.gateway,
      tunnelConfig: config.tunnel
    });

    expect(service.getPublicBaseUrl()).toBeUndefined();
    expect(service.getPublicUrl("/api/gateway")).toBeUndefined();
    expect(service.getPublicWebSocketUrl(config.gateway.websocketPath)).toBeUndefined();
  });
});
