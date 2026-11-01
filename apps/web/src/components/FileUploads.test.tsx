import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { UploadTasks } from "./FileUploads";
import { uploadManager, type UploadTask } from "../lib/file-upload-manager";

const task: UploadTask = { id: "upload", fileName: "notes.txt", mimeType: "text/plain", byteSize: 10,
  image: false, created: false, offset: 0, hashedBytes: 0, status: "failed", error: null };

it("retries a locally cached file without opening a file picker", () => {
  vi.spyOn(uploadManager, "all").mockReturnValue([{ id: "draft", attachments: [], tasks: [{ ...task, cached: true }] }]);
  const retry = vi.spyOn(uploadManager, "retry").mockImplementation(() => {});
  render(<UploadTasks scopeId="draft" />);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledWith("draft", "upload");
});

it("offers the original file picker when cached bytes are unavailable", () => {
  vi.spyOn(uploadManager, "all").mockReturnValue([{ id: "draft", attachments: [], tasks: [{ ...task, status: "needs-file", cacheWarning: true }] }]);
  render(<UploadTasks scopeId="draft" />);
  const input = screen.getByLabelText("选择原文件: notes.txt") as HTMLInputElement;
  const select = vi.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "选择原文件" }));
  expect(select).toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("未能本地暂存");
});
