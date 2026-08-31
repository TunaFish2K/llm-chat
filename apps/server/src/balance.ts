import { createHash } from "node:crypto";
import {
  BALANCE_EXPRESSION_MAX_LENGTH,
  type BalanceConfig,
  type ConnectionBalanceDto
} from "@llm-chat/contracts";
import {
  ensureOk,
  headers,
  type ProviderConnection
} from "@llm-chat/providers";

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_EXPRESSION_DEPTH = 32;
const MAX_EXPRESSION_COMPLEXITY = 256;
const MAX_RESPONSE_LENGTH = 1024 * 1024;

export type BalanceErrorCode =
  | "balance_disabled"
  | "balance_invalid_config"
  | "balance_invalid_result"
  | "balance_upstream_error";

export class BalanceError extends Error {
  constructor(
    public readonly code: BalanceErrorCode,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
  }
}

export interface BalanceConnection extends ProviderConnection {
  updatedAt: number;
  balanceConfig?: BalanceConfig;
}

interface BalanceServiceOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

interface CachedBalance {
  value: number;
  fetchedAt: number;
  expiresAt: number;
}

export class BalanceService {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CachedBalance>();

  constructor(options: BalanceServiceOptions = {}) {
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async get(connection: BalanceConnection, refresh = false): Promise<ConnectionBalanceDto> {
    const config = connection.balanceConfig;
    if (!config?.enabled) {
      throw new BalanceError("balance_disabled", "该连接未启用余额查询", 400);
    }

    const target = balanceUrl(connection.baseUrl, config.apiPath);
    const key = cacheKey(connection, config);
    const now = this.now();
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.expiresAt > now) {
      return {
        connectionId: connection.id,
        value: cached.value,
        fetchedAt: cached.fetchedAt,
        cached: true
      };
    }

    if (cached && cached.expiresAt <= now) this.cache.delete(key);
    this.prune(now);
    const body = await this.fetchJson(connection, target);
    const value = evaluateBalanceExpression(config.resultExpression, body);
    const fetchedAt = this.now();
    this.cache.set(key, { value, fetchedAt, expiresAt: fetchedAt + this.cacheTtlMs });
    return { connectionId: connection.id, value, fetchedAt, cached: false };
  }

  private async fetchJson(connection: BalanceConnection, target: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(target.toString(), {
        method: "GET",
        headers: headers(connection),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new BalanceError("balance_upstream_error", "余额服务请求失败", 502);
    }

    if (!response.ok) {
      await cancelBody(response);
      throw new BalanceError(
        "balance_upstream_error",
        `余额服务返回 HTTP ${response.status}`,
        502
      );
    }
    await ensureOk(response);

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_LENGTH) {
      await cancelBody(response);
      throw invalidResult("余额服务响应过大");
    }

    let text: string;
    try {
      text = await readBoundedText(response, MAX_RESPONSE_LENGTH);
    } catch (error) {
      if (error instanceof BalanceError) throw error;
      throw new BalanceError("balance_upstream_error", "读取余额服务响应失败", 502);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw invalidResult("余额服务未返回有效 JSON");
    }
  }

  private prune(now: number): void {
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) this.cache.delete(key);
    }
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limit) {
        try { await reader.cancel(); } catch {}
        throw invalidResult("余额服务响应过大");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    if (!(error instanceof BalanceError)) {
      try { await reader.cancel(); } catch {}
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch {}
}

export function evaluateBalanceExpression(expression: string, document: unknown): number {
  if (!expression.length || expression.length > BALANCE_EXPRESSION_MAX_LENGTH) {
    throw invalidResult("余额结果表达式长度无效");
  }
  return new ExpressionParser(expression, document).parse();
}

function balanceUrl(baseUrl: string, apiPath: string): URL {
  if (!apiPath.startsWith("/") || apiPath.startsWith("//") || apiPath.includes("\\")) {
    throw new BalanceError("balance_invalid_config", "余额接口路径必须是站点根路径", 400);
  }
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("unsupported protocol");
    const origin = base.origin;
    const target = new URL(apiPath, `${origin}/`);
    if (target.origin !== origin) throw new Error("cross-origin target");
    target.hash = "";
    return target;
  } catch {
    throw new BalanceError("balance_invalid_config", "余额接口路径配置无效", 400);
  }
}

function cacheKey(connection: BalanceConnection, config: BalanceConfig): string {
  const secretHeaders = Object.entries(connection.secretHeaders).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({
    id: connection.id,
    updatedAt: connection.updatedAt,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    secretHeaders,
    config
  })).digest("hex");
}

function invalidResult(message: string): BalanceError {
  return new BalanceError("balance_invalid_result", message, 422);
}

class ExpressionParser {
  private offset = 0;
  private complexity = 0;

  constructor(
    private readonly source: string,
    private readonly document: unknown
  ) {}

  parse(): number {
    const value = this.parseAdditive(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.syntaxError();
    return this.numeric(value);
  }

  private parseAdditive(depth: number): unknown {
    let value = this.parseMultiplicative(depth);
    while (true) {
      this.skipWhitespace();
      const operator = this.source[this.offset];
      if (operator !== "+" && operator !== "-") return value;
      this.offset += 1;
      this.bump(depth);
      const right = this.parseMultiplicative(depth);
      value = this.calculate(operator, value, right);
    }
  }

  private parseMultiplicative(depth: number): unknown {
    let value = this.parseUnary(depth);
    while (true) {
      this.skipWhitespace();
      const operator = this.source[this.offset];
      if (operator !== "*" && operator !== "/") return value;
      this.offset += 1;
      this.bump(depth);
      const right = this.parseUnary(depth);
      value = this.calculate(operator, value, right);
    }
  }

  private parseUnary(depth: number): unknown {
    this.skipWhitespace();
    const operator = this.source[this.offset];
    if (operator !== "+" && operator !== "-") return this.parsePrimary(depth);
    this.offset += 1;
    this.bump(depth + 1);
    const value = this.numeric(this.parseUnary(depth + 1));
    const result = operator === "-" ? -value : value;
    if (!Number.isFinite(result)) throw invalidResult("余额计算结果不是有限数字");
    return result;
  }

  private parsePrimary(depth: number): unknown {
    this.skipWhitespace();
    this.bump(depth);
    if (this.source[this.offset] === "(") {
      this.offset += 1;
      const value = this.parseAdditive(depth + 1);
      this.skipWhitespace();
      if (this.source[this.offset] !== ")") this.syntaxError();
      this.offset += 1;
      return value;
    }

    const rest = this.source.slice(this.offset);
    const numberMatch = rest.match(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      this.offset += numberMatch[0].length;
      const value = Number(numberMatch[0]);
      if (!Number.isFinite(value)) throw invalidResult("数字字面量超出范围");
      return value;
    }

    return this.parsePath(depth);
  }

  private parsePath(depth: number): unknown {
    let value = this.document;
    if (this.source[this.offset] === "$") {
      this.offset += 1;
    } else {
      const root = this.identifier();
      if (root === null) this.syntaxError();
      value = this.member(value, root);
    }

    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] === ".") {
        this.offset += 1;
        this.skipWhitespace();
        const key = this.identifier();
        if (key === null) this.syntaxError();
        this.bump(depth);
        value = this.member(value, key);
        continue;
      }
      if (this.source[this.offset] === "[") {
        this.offset += 1;
        this.skipWhitespace();
        const indexMatch = this.source.slice(this.offset).match(/^\d+/);
        if (!indexMatch) this.syntaxError();
        this.offset += indexMatch[0].length;
        this.skipWhitespace();
        if (this.source[this.offset] !== "]") this.syntaxError();
        this.offset += 1;
        this.bump(depth);
        const index = Number(indexMatch[0]);
        if (!Number.isSafeInteger(index) || !Array.isArray(value) || index >= value.length) {
          throw invalidResult("余额结果路径不存在");
        }
        value = value[index];
        continue;
      }
      return value;
    }
  }

  private identifier(): string | null {
    const match = this.source.slice(this.offset).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!match) return null;
    this.offset += match[0].length;
    return match[0];
  }

  private member(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) {
      throw invalidResult("余额结果路径不存在");
    }
    return (value as Record<string, unknown>)[key];
  }

  private calculate(operator: string, leftValue: unknown, rightValue: unknown): number {
    const left = this.numeric(leftValue);
    const right = this.numeric(rightValue);
    if (operator === "/" && right === 0) throw invalidResult("余额结果表达式不能除以零");
    const result = operator === "+"
      ? left + right
      : operator === "-"
        ? left - right
        : operator === "*"
          ? left * right
          : left / right;
    if (!Number.isFinite(result)) throw invalidResult("余额计算结果不是有限数字");
    return result;
  }

  private numeric(value: unknown): number {
    const number = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(number)) throw invalidResult("余额结果不是有限数字");
    return number;
  }

  private bump(depth: number): void {
    this.complexity += 1;
    if (depth > MAX_EXPRESSION_DEPTH || this.complexity > MAX_EXPRESSION_COMPLEXITY) {
      throw invalidResult("余额结果表达式过于复杂");
    }
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.offset] ?? "")) this.offset += 1;
  }

  private syntaxError(): never {
    throw invalidResult("余额结果表达式语法无效");
  }
}
