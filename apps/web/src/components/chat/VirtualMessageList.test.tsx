import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { makeMessage } from "../../../test/fixtures";
import { HistoryRendering } from "../../lib/history-rendering";
import { VirtualMessageList } from "./VirtualMessageList";

it.each([10, 12, 13])("windows %i messages after shell admission instead of mounting the whole history", async count => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("chat-scroll") ? 500 : 200;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(360);
  const messages = Array.from({ length: count }, (_, index) => makeMessage({ id: `item-${index}`, role: "user", text: `History ${index}` }));
  const rendered = vi.fn(message => <article>{message.text}</article>);
  function View({ allowed }: { allowed: boolean }) {
    const scroller = useRef<HTMLDivElement>(null);
    return <HistoryRendering value={allowed}><div className="chat-scroll" ref={scroller}>
      <VirtualMessageList messages={messages} scroller={scroller} following renderMessage={rendered} />
    </div></HistoryRendering>;
  }
  const { rerender, container } = render(<View allowed={false} />);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(rendered).not.toHaveBeenCalled();
  rerender(<View allowed />);
  await waitFor(() => expect(container.querySelectorAll("article").length).toBeGreaterThan(0), { timeout: 5_000 });
  expect(container.querySelectorAll("article").length).toBeLessThan(count);
  const mounted = container.querySelector("article");
  rerender(<View allowed={false} />);
  expect(container.querySelector("article")).toBe(mounted);
});
