import type { AppConfig } from "@/core/config";
import { tunnelExposureSchema, tunnelStatusSchema, type TunnelStatus } from "@/core/contracts";

type TunnelServiceOptions = {
  authToken?: string;
  gatewayConfig: AppConfig["gateway"];
  tunnelConfig: AppConfig["tunnel"];
};

export class TunnelService {
  constructor(private readonly options: TunnelServiceOptions) {}

  getStatus(): TunnelStatus {
    const publicBaseUrl = this.resolvePublicBaseUrl();
    const warnings: string[] = [];

    if (!this.options.tunnelConfig.enabled) {
      return tunnelStatusSchema.parse({
        enabled: false,
        exposures: [],
        metadata: {},
        provider: this.options.tunnelConfig.provider,
        publicBaseUrl,
        ready: false,
        warnings
      });
    }

    if (this.options.tunnelConfig.provider === "none") {
      warnings.push("Tunnel support is enabled, but the provider is set to \"none\".");
    }

    if (!publicBaseUrl) {
      warnings.push("Set tunnel.publicBaseUrl or tunnel.hostname so remote clients know where to connect.");
    }

    if (!this.options.authToken) {
      warnings.push("Remote web and gateway access require gateway.auth.token to be configured.");
    }

    const exposures = publicBaseUrl
      ? [
          {
            metadata: {},
            path: "/",
            publicUrl: this.resolvePublicUrl("/"),
            requiresAuthentication: true,
            surface: "web"
          },
          {
            metadata: {},
            path: "/api/gateway",
            publicUrl: this.resolvePublicUrl("/api/gateway"),
            requiresAuthentication: true,
            surface: "gateway_http"
          },
          {
            metadata: {},
            path: this.options.gatewayConfig.websocketPath,
            publicUrl: this.resolvePublicWebSocketUrl(this.options.gatewayConfig.websocketPath),
            requiresAuthentication: true,
            surface: "gateway_websocket"
          }
        ]
      : [];

    return tunnelStatusSchema.parse({
      enabled: true,
      exposures: exposures.map((exposure) => tunnelExposureSchema.parse(exposure)),
      metadata: {},
      provider: this.options.tunnelConfig.provider,
      publicBaseUrl,
      ready: Boolean(publicBaseUrl && this.options.authToken && this.options.tunnelConfig.provider !== "none"),
      warnings
    });
  }

  getPublicBaseUrl(): string | undefined {
    return this.resolvePublicBaseUrl();
  }

  getPublicUrl(pathname: string): string | undefined {
    return this.resolvePublicUrl(pathname);
  }

  getPublicWebSocketUrl(pathname: string): string | undefined {
    return this.resolvePublicWebSocketUrl(pathname);
  }

  private resolvePublicBaseUrl(): string | undefined {
    const explicit = normalizeBaseUrl(this.options.tunnelConfig.publicBaseUrl);
    if (explicit) {
      return explicit;
    }

    const hostname = this.options.tunnelConfig.hostname?.trim();
    if (!hostname) {
      return undefined;
    }

    return normalizeBaseUrl(`https://${hostname}`);
  }

  private resolvePublicUrl(pathname: string): string | undefined {
    const baseUrl = this.resolvePublicBaseUrl();
    if (!baseUrl) {
      return undefined;
    }

    return new URL(pathname, ensureTrailingSlash(baseUrl)).toString();
  }

  private resolvePublicWebSocketUrl(pathname: string): string | undefined {
    const url = this.resolvePublicUrl(pathname);
    if (!url) {
      return undefined;
    }

    return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}
