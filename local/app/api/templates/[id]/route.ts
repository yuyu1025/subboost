import { getOptionalCurrentAdmin, localAdminRequiredResponse } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import { getTemplateDetail } from "@local/lib/template-service";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function buildTemplateAttachmentDisposition(name: string): string {
  const safeBase =
    String(name || "subboost-template")
      .trim()
      .replace(/[\r\n"]/g, "")
      .replace(/[<>:"/\\|?*]+/g, "")
      .replace(/\.(?:json|ya?ml)$/i, "")
      .slice(0, 80) || "subboost-template";
  const filename = `${safeBase}.json`;
  const asciiBase =
    safeBase
      .replace(/[^\x20-\x7E]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60) || "subboost-template";
  const asciiFilename = `${asciiBase}.json`;
  const encodedFilename = encodeURIComponent(filename);
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const admin = await getOptionalCurrentAdmin();
  const download = new URL(request.url).searchParams.get("download");

  try {
    const template = await getTemplateDetail(admin?.id ?? null, id);
    if (!template) return apiError("Template not found.", "NOT_FOUND", 404);
    if (download === "1" || download === "true") {
      return new Response(JSON.stringify(template.config, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": buildTemplateAttachmentDisposition(template.name),
          "Cache-Control": "no-store",
        },
      });
    }
    return json({ template });
  } catch (error) {
    if (!admin) return localAdminRequiredResponse();
    return apiError(error instanceof Error ? error.message : "Unable to load template.", "BAD_REQUEST", 400);
  }
}
