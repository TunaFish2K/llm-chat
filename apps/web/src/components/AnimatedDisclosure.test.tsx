import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { expect, it, vi } from "vitest";
import { HistoryRendering } from "../lib/history-rendering";
import { AnimatedDisclosure } from "./AnimatedDisclosure";

it("does not mount collapsed content and retains its state after the first opening", async () => {
  const mounted = vi.fn(), unmounted = vi.fn();
  function Content() {
    const [value, setValue] = useState(0);
    useEffect(() => { mounted(); return unmounted; }, []);
    return <button onClick={() => setValue(value + 1)}>Value {value}</button>;
  }
  const { container } = render(<AnimatedDisclosure lazy className="test" summary="Details"><Content /></AnimatedDisclosure>);
  expect(mounted).not.toHaveBeenCalled();
  const summary = container.querySelector("summary")!;
  fireEvent.click(summary);
  expect(summary).toHaveAttribute("aria-expanded", "true");
  expect(mounted).not.toHaveBeenCalled();
  const control = await screen.findByRole("button", { name: "Value 0" }, { timeout: 5_000 });
  fireEvent.click(control);
  fireEvent.click(summary);
  await waitFor(() => expect(container.querySelector("details")).not.toHaveAttribute("open"));
  expect(unmounted).not.toHaveBeenCalled();
  fireEvent.click(summary);
  expect(screen.getByRole("button", { name: "Value 1" })).toBe(control);
  expect(mounted).toHaveBeenCalledOnce();
});

it("waits for shell rendering admission and cancels a closed disclosure's pending mount", async () => {
  const mounted = vi.fn();
  function Content() { useEffect(mounted, []); return <span>Loaded detail</span>; }
  const view = (allowed: boolean, open: boolean) => <HistoryRendering value={allowed}>
    <AnimatedDisclosure lazy open={open} className="test" summary="Details"><Content /></AnimatedDisclosure>
  </HistoryRendering>;
  const { rerender } = render(view(false, true));
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(mounted).not.toHaveBeenCalled();
  rerender(view(true, true));
  rerender(view(true, false));
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(mounted).not.toHaveBeenCalled();
  rerender(view(true, true));
  await screen.findByText("Loaded detail", {}, { timeout: 5_000 });
  expect(mounted).toHaveBeenCalledOnce();
});
