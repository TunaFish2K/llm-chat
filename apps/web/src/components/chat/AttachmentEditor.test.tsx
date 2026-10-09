import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttachmentMenu } from "./AttachmentEditor";

describe("AttachmentMenu", () => {
  it("uses directly activated native inputs for images and files", () => {
    const uploadFiles = vi.fn(async () => {});
    render(<AttachmentMenu uploadFiles={uploadFiles} />);

    const imageInput = screen.getByLabelText("上传图片") as HTMLInputElement;
    const fileInput = screen.getByLabelText("上传文件") as HTMLInputElement;
    expect(imageInput.hidden).toBe(false);
    expect(fileInput.hidden).toBe(false);

    const image = new File(["image"], "reference.png", { type: "image/png" });
    const file = new File(["text"], "notes.txt", { type: "text/plain" });
    fireEvent.change(imageInput, { target: { files: [image] } });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(uploadFiles).toHaveBeenNthCalledWith(1, [image], "image");
    expect(uploadFiles).toHaveBeenNthCalledWith(2, [file], "file");
  });

  it("disables both native controls while unavailable", () => {
    render(<AttachmentMenu uploadFiles={async () => {}} disabled />);
    expect(screen.getByLabelText("上传图片")).toBeDisabled();
    expect(screen.getByLabelText("上传文件")).toBeDisabled();
  });
});
