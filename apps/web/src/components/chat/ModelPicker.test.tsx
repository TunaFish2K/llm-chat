import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeConnection, makeModel } from "../../../test/fixtures";
import { ModelPicker } from "./ModelPicker";

function media(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(hover: none) and (pointer: coarse)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  };
}

function picker() {
  return (
    <ModelPicker
      effectiveModelId="model-1"
      explicitValue="model-1"
      agentModelId="model-1"
      models={[makeModel()]}
      connections={[makeConnection()]}
      disabled={false}
      onChange={() => undefined}
    />
  );
}

describe("ModelPicker", () => {
  it("focuses search when opened on a desktop pointer", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(media(false));
    const user = userEvent.setup();
    render(picker());

    await user.click(screen.getByRole("button", { name: "选择模型" }));
    expect(await screen.findByRole("searchbox", { name: "搜索模型" })).toHaveFocus();
  });

  it("does not focus search when opened on a touch layout", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(media(true));
    const user = userEvent.setup();
    render(picker());

    await user.click(screen.getByRole("button", { name: "选择模型" }));
    expect(await screen.findByRole("searchbox", { name: "搜索模型" })).not.toHaveFocus();
  });
});
