import { describe, expect, it, vi } from "vitest";
import {
  BalanceError,
  BalanceService,
  evaluateBalanceExpression,
  type BalanceConnection
} from "./balance";

describe("balance expression parser", () => {
  it("evaluates paths, array indexes, literals, precedence, parentheses, and unary operators", () => {
    const document = {
      account: { buckets: [{ amount: "120.5" }, { amount: 9 }] },
      adjustment: 3
    };
    expect(evaluateBalanceExpression("account.buckets[0].amount / 10 + adjustment * 2", document)).toBe(18.05);
    expect(evaluateBalanceExpression("-($.account.buckets[1].amount - 4) + +2", document)).toBe(-3);
    expect(evaluateBalanceExpression("(2 + 3) * 4", document)).toBe(20);
  });

  it.each([
    ["missing.value", {}, "missing path"],
    ["items[2]", { items: [1] }, "missing index"],
    ["value / 0", { value: 1 }, "division by zero"],
    ["value +", { value: 1 }, "invalid syntax"],
    ["value", { value: "NaN" }, "NaN string"],
    ["1e999", {}, "infinite literal"],
    ["(".repeat(40) + "1" + ")".repeat(40), {}, "excess depth"]
  ])("rejects invalid or unsafe expression results: %s (%s)", (expression, document, _label) => {
    expect(() => evaluateBalanceExpression(expression, document)).toThrowError(
      expect.objectContaining({ code: "balance_invalid_result" })
    );
  });
});

describe("BalanceService", () => {
  it("uses the connection origin and provider headers for a bounded GET", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      Response.json({ account: { cents: "1250" } })
    ));
    const service = new BalanceService({ fetch: fetchMock as typeof fetch, now: () => 100 });
    const result = await service.get(connection());

    expect(result).toEqual({ connectionId: "connection", value: 12.5, fetchedAt: 100, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://provider.test/account/balance?currency=usd");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({ authorization: "Bearer api-secret", "X-Tenant": "tenant-secret" });
  });

  it("caches successful results for two minutes and bypasses stale entries on refresh or updates", async () => {
    let now = 1_000;
    let value = 10;
    const fetchMock = vi.fn(async () => Response.json({ account: { cents: value * 100 } }));
    const service = new BalanceService({ fetch: fetchMock as typeof fetch, now: () => now });
    const initial = connection();

    expect((await service.get(initial)).cached).toBe(false);
    value = 20;
    now += 1_000;
    expect(await service.get(initial)).toEqual({ connectionId: "connection", value: 10, fetchedAt: 1_000, cached: true });
    expect((await service.get(initial, true)).value).toBe(20);
    value = 30;
    expect((await service.get({ ...initial, updatedAt: initial.updatedAt + 1 })).value).toBe(30);
    value = 40;
    now += 120_001;
    expect((await service.get({ ...initial, updatedAt: initial.updatedAt + 1 })).value).toBe(40);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not cache failures and sanitizes upstream response bodies", async () => {
    const rejected = new Response(JSON.stringify({ error: { message: "api-secret leaked" } }), { status: 401 });
    const rejectedText = vi.spyOn(rejected, "text");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(Response.json({ account: {} }))
      .mockResolvedValueOnce(Response.json({ account: { cents: 500 } }));
    const service = new BalanceService({ fetch: fetchMock as typeof fetch });

    const upstream = await service.get(connection()).then(
      () => { throw new Error("expected upstream failure"); },
      (error: unknown) => error as BalanceError
    );
    expect(upstream).toMatchObject({ code: "balance_upstream_error", statusCode: 502 });
    expect(upstream.message).not.toContain("api-secret");
    expect(rejectedText).not.toHaveBeenCalled();
    await expect(service.get(connection())).rejects.toMatchObject({ code: "balance_invalid_result" });
    await expect(service.get(connection())).rejects.toMatchObject({ code: "balance_invalid_result" });
    await expect(service.get(connection())).resolves.toMatchObject({ value: 5, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("cancels an unbounded chunked success response before materializing it", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 2) throw new Error("read past response limit");
        controller.enqueue(new Uint8Array(600 * 1024));
      },
      cancel() {
        cancelled = true;
      }
    }, { highWaterMark: 0 });
    const service = new BalanceService({
      fetch: vi.fn(async () => new Response(body)) as typeof fetch
    });

    await expect(service.get(connection())).rejects.toMatchObject({ code: "balance_invalid_result" });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it("keeps a still-valid successful entry when an explicit refresh fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ account: { cents: 700 } }))
      .mockRejectedValueOnce(new Error("network failed"));
    const service = new BalanceService({ fetch: fetchMock as typeof fetch, now: () => 1_000 });
    await expect(service.get(connection())).resolves.toMatchObject({ value: 7, cached: false });
    await expect(service.get(connection(), true)).rejects.toMatchObject({ code: "balance_upstream_error" });
    await expect(service.get(connection())).resolves.toMatchObject({ value: 7, cached: true });
  });

  it("rejects disabled and cross-origin configurations without fetching", async () => {
    const fetchMock = vi.fn();
    const service = new BalanceService({ fetch: fetchMock as typeof fetch });
    const disabled = connection();
    delete disabled.balanceConfig;
    await expect(service.get(disabled)).rejects.toMatchObject({
      code: "balance_disabled"
    });
    await expect(service.get({
      ...connection(),
      balanceConfig: { enabled: true, apiPath: "//attacker.test/balance", resultExpression: "value" }
    })).rejects.toMatchObject({ code: "balance_invalid_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function connection(): BalanceConnection {
  return {
    id: "connection",
    providerId: "custom",
    protocol: "openai-chat",
    baseUrl: "https://user:password@provider.test/v1",
    apiKey: "api-secret",
    secretHeaders: { "X-Tenant": "tenant-secret" },
    updatedAt: 1,
    balanceConfig: {
      enabled: true,
      apiPath: "/account/balance?currency=usd",
      resultExpression: "account.cents / 100"
    }
  };
}

it.each([
  ["", {}], ["1".repeat(1025), {}], ["1 2", {}], ["(1+2", {}],
  ["value.", { value: {} }], ["value[-1]", { value: [] }], ["value[0", { value: [1] }],
  ["value[99999999999999999999]", { value: [1] }], ["value[0]", { value: {} }],
  ["value", { value: null }], ["value", { value: "  " }], ["value.x", { value: 2 }],
  ["1e308 * 1e308", {}], [Array(140).fill("1").join("+"), {}]
])("rejects malformed balance expression %s", (expression, document) => {
  expect(() => evaluateBalanceExpression(expression as string, document)).toThrowError(expect.objectContaining({ code: "balance_invalid_result" }));
});

it("validates balance endpoint schemes and paths before network access", async () => {
  const fetcher = vi.fn();
  const service = new BalanceService({ fetch: fetcher });
  for (const baseUrl of ["not a URL", "file:///tmp/balance"]) {
    await expect(service.get({ ...connection(), baseUrl })).rejects.toMatchObject({ code: "balance_invalid_config" });
  }
  for (const apiPath of ["relative", "/account\\balance"]) {
    await expect(service.get({ ...connection(), balanceConfig: { ...connection().balanceConfig!, apiPath } })).rejects.toMatchObject({ code: "balance_invalid_config" });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("bounds declared response sizes and reports absent or broken response streams", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "1048577" } }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("socket reset")); } })));
  const service = new BalanceService({ fetch: fetcher });
  await expect(service.get(connection())).rejects.toMatchObject({ code: "balance_invalid_result" });
  await expect(service.get(connection())).rejects.toMatchObject({ code: "balance_invalid_result" });
  await expect(service.get(connection())).rejects.toMatchObject({ code: "balance_upstream_error" });
});

it("shares cached balances across header order changes and expires other connection entries", async () => {
  let now = 0;
  const fetcher = vi.fn(async () => Response.json({ account: { cents: 100 } }));
  const service = new BalanceService({ fetch: fetcher, now: () => now, cacheTtlMs: 10 });
  const first = { ...connection(), secretHeaders: { "X-Z": "z", "X-A": "a" } };
  await service.get(first);
  expect((await service.get({ ...first, secretHeaders: { "X-A": "a", "X-Z": "z" } })).cached).toBe(true);
  now = 20;
  await service.get({ ...first, id: "another" });
  expect((await service.get(first)).cached).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
