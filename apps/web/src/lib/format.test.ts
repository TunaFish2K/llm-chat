import { describe, expect, it, vi } from "vitest";
import { errorMessage, fileToBase64, formatBytes, formatTime, formatTokens } from "./format";

describe("format helpers", () => {
  it("formats absent and scaled values", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime(1_700_000_000_000)).not.toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB");
  });

  it("normalizes errors", () => {
    expect(errorMessage(new Error("broken"))).toBe("broken");
    expect(errorMessage(404)).toBe("404");
  });

  it("extracts base64 file contents and reports read failures", async () => {
    class Reader {
      result: string | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(file: File) {
        if (file.name === "bad") this.onerror?.();
        else {
          this.result = file.name === "plain" ? "raw" : "data:text/plain;base64,aGVsbG8=";
          this.onload?.();
        }
      }
    }
    vi.stubGlobal("FileReader", Reader);
    await expect(fileToBase64(new File(["hello"], "hello.txt"))).resolves.toBe("aGVsbG8=");
    await expect(fileToBase64(new File(["raw"], "plain"))).resolves.toBe("raw");
    await expect(fileToBase64(new File([], "bad"))).rejects.toThrow("读取文件失败");
  });
});
