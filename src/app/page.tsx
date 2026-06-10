import { HomePage } from "@/web/home-page";
import { ControlPlaneService } from "@/server/control-plane/service";
import { getServerRuntimeContext } from "@/server/runtime-context";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: PageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const sessionId = readSearchParam(resolvedSearchParams.sessionId);
  const memoryText = readSearchParam(resolvedSearchParams.memoryText) ?? "";
  const memorySessionId = readSearchParam(resolvedSearchParams.memorySessionId) ?? sessionId ?? undefined;
  const flash = readSearchParam(resolvedSearchParams.flash);
  const flashError = readSearchParam(resolvedSearchParams.flashError);
  const context = await getServerRuntimeContext({
    cwd: process.cwd()
  });
  const service = new ControlPlaneService(context);
  const dashboard = await service.getDashboard({
    memorySessionId,
    memoryText,
    sessionId
  });

  return (
    <HomePage
      dashboard={dashboard}
      flash={flash}
      flashError={flashError}
      memoryText={memoryText}
      redirectTo={buildRedirectTo(resolvedSearchParams)}
    />
  );
}

function buildRedirectTo(searchParams: Record<string, string | string[] | undefined>): string {
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "flash" || key === "flashError") {
      continue;
    }

    const normalized = readSearchParam(value);
    if (normalized) {
      next.set(key, normalized);
    }
  }

  const query = next.toString();
  return query.length > 0 ? `/?${query}` : "/";
}

function readSearchParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === "string" && entry.length > 0);
  }

  return undefined;
}
