import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canShareFile, downloadAsset, shareAsset } from "./asset-file";

const share = vi.fn();
const canShare = vi.fn(() => true);
const fetchMock = vi.fn();
let sequence = 0;

// jsdom's Blob is not one undici's Response reads, so fetch resolves to a minimal stand-in.
function served(body: string, type: string, status = 200) {
  return { ok: status < 400, status, blob: async () => new Blob([body], { type }) };
}

function asset(mimeType?: string) {
  return { url: `/api/files/a${++sequence}?v=sha`, fileName: "report", mimeType };
}

describe("asset files", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async () => served("png", "image/png"));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    share.mockReset();
    canShare.mockClear();
    fetchMock.mockReset();
  });

  it("shares the fetched file with its extension and ignores a closed share sheet", async () => {
    share.mockResolvedValueOnce(undefined);
    await expect(shareAsset(asset())).resolves.toBe("shared");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/files/"), expect.objectContaining({ cache: "reload" }));
    expect((share.mock.calls[0]![0] as ShareData).files![0]!.name).toBe("report.png");

    share.mockRejectedValueOnce(new DOMException("closed", "AbortError"));
    await expect(shareAsset(asset())).resolves.toBe("cancelled");
  });

  it("asks for another tap when fetching outlasted it, then shares the kept file", async () => {
    const source = asset();
    share.mockRejectedValueOnce(new DOMException("no activation", "NotAllowedError"));
    await expect(shareAsset(source)).resolves.toBe("retry");
    share.mockResolvedValueOnce(undefined);
    await expect(shareAsset(source)).resolves.toBe("shared");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A refusal right after a fresh tap is the browser's own, so it is not retried forever.
    share.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    await expect(shareAsset(source)).rejects.toThrow("blocked");
  });

  it("names attachments by their stored type instead of the served octet-stream", async () => {
    fetchMock.mockImplementationOnce(async () => served("%PDF", "application/octet-stream"));
    share.mockResolvedValueOnce(undefined);
    await shareAsset({ ...asset("application/pdf"), fileName: "report.pdf" });
    expect((share.mock.calls[0]![0] as ShareData).files![0]!.type).toBe("application/pdf");
  });

  it("reports failed fetches and downloads through a link", async () => {
    fetchMock.mockImplementationOnce(async () => served("", "text/plain", 404));
    await expect(shareAsset(asset())).rejects.toThrow("HTTP 404");

    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    await downloadAsset(asset());
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("offers sharing only where the browser accepts the file type", () => {
    expect(canShareFile("a.pdf", "application/pdf")).toBe(true);
    canShare.mockReturnValueOnce(false);
    expect(canShareFile("a.zip", "application/zip")).toBe(false);
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    expect(canShareFile("a.png", "image/png")).toBe(false);
  });
});
