import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Modal } from "./AnimatedModal";
import { Presence } from "../lib/motion";
import { dismissBackLayer } from "../lib/mobile-navigation";

it("keeps the exiting dialog as a back layer and blocks duplicate actions", async () => {
  const outerClose = vi.fn(), save = vi.fn();
  function Nested() {
    const [open, setOpen] = useState(true);
    return <><Modal title="Outer" onClose={outerClose}><button>Outer action</button></Modal>
      <Presence>{open ? <Modal title="Inner" onClose={() => setOpen(false)} footer={<button onClick={save}>Save</button>}>Inner text</Modal> : null}</Presence>
    </>;
  }
  render(<Nested />);
  act(() => { dismissBackLayer(); });
  const exiting = document.querySelector('[role="dialog"][aria-label="Inner"]')!;
  expect(exiting).toHaveAttribute("inert");
  expect(exiting).toHaveAttribute("aria-hidden", "true");
  fireEvent.click(exiting.querySelector('.modal-footer button')!);
  act(() => { dismissBackLayer(); });
  expect(save).not.toHaveBeenCalled();
  expect(outerClose).not.toHaveBeenCalled();
  await waitFor(() => expect(document.querySelector('[role="dialog"][aria-label="Inner"]')).toBeNull());
  await act(async () => {});
  act(() => { dismissBackLayer(); });
  expect(outerClose).toHaveBeenCalledOnce();
});

it("restores interaction and focus when an exit is interrupted", () => {
  const close = vi.fn();
  const modal = <Modal title="Reopen" onClose={close}>Content</Modal>;
  const view = render(<><button>Outside</button><Presence>{modal}</Presence></>);
  view.rerender(<><button>Outside</button><Presence>{null}</Presence></>);
  expect(document.querySelector('[role="dialog"]')).toHaveAttribute("inert");
  // Browsers move focus away when the focused subtree becomes inert.
  screen.getByRole("button", { name: "Outside" }).focus();
  view.rerender(<><button>Outside</button><Presence>{modal}</Presence></>);
  const reopened = screen.getByRole("dialog");
  expect(reopened).not.toHaveAttribute("inert");
  expect(reopened.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});
