import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HelpTip from "./HelpTip";

afterEach(cleanup);

describe("HelpTip", () => {
  it("the help tip opens on focus and closes on Esc", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="About this list">Labels come from the first 50000 series.</HelpTip>);
    const button = screen.getByRole("button", { name: "About this list" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("tooltip").textContent).toBe("Labels come from the first 50000 series.");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("the help tip opens on hover and on click", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="About this list">Some note.</HelpTip>);
    const button = screen.getByRole("button", { name: "About this list" });
    await user.hover(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    await user.unhover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});
