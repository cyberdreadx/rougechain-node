import { render, screen } from "@testing-library/react";
it("mounts the standalone showcase", () => {
  render(<h1>RougeChain</h1>);
  expect(screen.getByRole("heading")).toHaveTextContent("RougeChain");
});
