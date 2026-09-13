import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { containerResourceNodeSchema } from "@llm-chat/contracts";
import { StoreError } from "./errors";
import type { ContainerResources } from "./container-resources";

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
  app.delete("/api/container-resources/cache", async () => {
    await operation(() => resources.clearCache()); return { ok: true };
  });
}
