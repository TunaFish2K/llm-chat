import { resolve, dirname } from "node:path";
import { z } from "zod";

const text = z.string().min(1).max(2048).refine((value) => !/[\0\r\n]/.test(value));
const origin = text.transform((value, ctx) => {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error();
    return url.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: "必须是 HTTPS origin；本机开发允许回环 HTTP" });
    return z.NEVER;
  }
});

const schema = z.object({
  password: z.object({ enabled: z.boolean().default(true) }).strict().default({ enabled: true }),
  oidc: z.object({
    issuer: text,
    clientId: text,
    clientSecretFile: text,
    clientAuthentication: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),
    publicOrigins: z.array(origin).min(1).max(16),
    allowedSubjects: z.array(text).min(1).max(100),
    label: text.max(100).optional()
  }).strict().optional()
}).strict().refine((value) => value.password.enabled || value.oidc, "必须启用至少一种认证方式");

export type AuthenticationConfig = z.infer<typeof schema>;
export const DEFAULT_AUTHENTICATION: AuthenticationConfig = { password: { enabled: true } };

export function parseAuthentication(value: unknown, configPath: string): AuthenticationConfig {
  const config = schema.parse(value);
  if (config.oidc) {
    const issuer = new URL(config.oidc.issuer);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
    if (issuer.username || issuer.password || issuer.search || issuer.hash
      || (issuer.protocol !== "https:" && !(issuer.protocol === "http:" && loopback))) {
      throw new Error("authentication.oidc.issuer 必须是 HTTPS issuer；本机开发允许回环 HTTP");
    }
    config.oidc.clientSecretFile = resolve(dirname(configPath), config.oidc.clientSecretFile);
    config.oidc.publicOrigins = [...new Set(config.oidc.publicOrigins)];
  }
  return config;
}

/** Public origins are explicit deployment configuration, never inferred from forwarded headers. */
export function configuredOrigin(config: AuthenticationConfig, host: string | undefined): string | undefined {
  return config.oidc?.publicOrigins.find((value) => new URL(value).host === host);
}
