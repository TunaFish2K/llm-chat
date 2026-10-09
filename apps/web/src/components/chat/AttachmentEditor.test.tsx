import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttachmentMenu } from "./AttachmentEditor";

describe("AttachmentMenu", () => {
  it("keeps the drawer and labels real file inputs that stay mounted", async () => {
    const uploadFiles = vi.fn(async () => {});
    render(<AttachmentMenu uploadFiles={uploadFiles} />);

    const imageInput = screen.getByLabelText("上传图片") as HTMLInputElement;
    const fileInput = screen.getByLabelText("上传文件") as HTMLInputElement;
    expect(imageInput.type).toBe("file");
    expect(fileInput.type).toBe("file");

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    const imageRow = await screen.findByRole("button", { name: "上传图片" });
    const fileRow = screen.getByRole("button", { name: "上传文件" });
    expect(imageRow.tagName).toBe("LABEL");
    expect(imageRow.getAttribute("for")).toBe(imageInput.id);
    expect(fileRow.getAttribute("for")).toBe(fileInput.id);

    const image = new File(["image"], "reference.png", { type: "image/png" });
    const file = new File(["text"], "notes.txt", { type: "text/plain" });
    fireEvent.change(imageInput, { target: { files: [image] } });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(uploadFiles).toHaveBeenNthCalledWith(1, [image], "image");
    expect(uploadFiles).toHaveBeenNthCalledWith(2, [file], "file");
    expect(imageInput.isConnected && fileInput.isConnected).toBe(true);
  });

  it("can offer images only", () => {
    render(<AttachmentMenu uploadFiles={async () => {}} files={false} />);
    expect(screen.queryByLabelText("上传文件")).toBeNull();
    expect(screen.getByLabelText("上传图片")).toBeInTheDocument();
  });

  it("disables the drawer and inputs while unavailable", () => {
    render(<AttachmentMenu uploadFiles={async () => {}} disabled />);
    expect(screen.getByRole("button", { name: "添加附件" })).toBeDisabled();
    expect(screen.getByLabelText("上传图片")).toBeDisabled();
    expect(screen.getByLabelText("上传文件")).toBeDisabled();
  });
});
