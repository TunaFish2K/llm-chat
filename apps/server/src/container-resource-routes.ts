import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { containerResourceNodeSchema } from "@llm-chat/contracts";
import { StoreError } from "./errors";
import type { ContainerResources } from "./container-resources";
import { RESOURCE_CHUNK_SIZE } from "./container-resource-files";

export function registerContainerResourceRoutes(app: FastifyInstance, resources: ContainerResources) {
  const ids = z.array(z.string().min(1).max(300)).min(1).max(100);
  const operation = async <T>(work: () => T | Promise<T>) => {
    try { return await work(); }
    catch (error) { if (error instanceof z.ZodError) throw error; throw new StoreError("container_resource_error", error instanceof Error ? error.message : "Resource operation failed"); }
  };
  app.get("/api/container-resources", () => operation(() => resources.catalog()));
  app.put("/api/container-resources/settings", async request => {
    const body = z.object({ node: containerResourceNodeSchema }).parse(request.body);
    resources.setNode(body.node); return { ok: true };
  });
  app.post("/api/container-resources/download", async request => {
    const body = z.object({ ids }).parse(request.body);
    return operation(() => resources.download(body.ids));
  });
  app.post<{ Params: { id: string } }>("/api/container-resources/jobs/:id/cancel", async request => {
    resources.cancel(request.params.id); return { ok: true };
  });
  app.post("/api/container-resources/uploads", async request => {
    const body = z.object({ name: z.string().min(1).max(200), size: z.number().int().positive().max(20 * 1024 ** 3), fingerprint: z.string().max(200).default("") }).parse(request.body);
    return operation(() => resources.beginUpload(body.name, body.size, body.fingerprint));
  });
  app.put<{ Params: { id: string }; Querystring: { offset?: string } }>("/api/container-resources/uploads/:id", { bodyLimit: RESOURCE_CHUNK_SIZE }, async request => {
    const offset = z.coerce.number().int().nonnegative().parse(request.query.offset);
    if (!Buffer.isBuffer(request.body)) throw new StoreError("invalid_resource_chunk", "Upload a binary chunk");
    const chunk = request.body;
    return operation(() => resources.upload(request.params.id, offset, chunk));
  });
  app.post<{ Params: { id: string } }>("/api/container-resources/uploads/:id/complete", async request => {
    await operation(() => resources.completeUpload(request.params.id)); return { ok: true };
  });
  app.get<{ Querystring: { ids?: string } }>("/api/container-resources/bundle", async (request, reply) => {
    const selected = ids.parse(request.query.ids?.split(","));
    const stream = await operation(() => resources.exportBundle(selected));
    return reply.header("content-type", "application/octet-stream").header("content-disposition", 'attachment; filename="container-resources.llmresources"').send(stream);
  });
  app.delete("/api/container-resources/cache", async () => {
    await operation(() => resources.clearCache()); return { ok: true };
  });
}
