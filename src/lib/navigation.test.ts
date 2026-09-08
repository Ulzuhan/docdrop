import { afterEach, expect, it, vi } from "vitest";
import { routeParams } from "./navigation";

afterEach(() => vi.unstubAllGlobals());
it("reads parameters supplied by Go, not the browser URL", () => {
  vi.stubGlobal("document", { getElementById: (id: string) => id === "app" ? { dataset: { fileId: "file", guestToken: "guest" } } : null });
  vi.stubGlobal("location", { pathname: "/guest/untrusted" });
  expect(routeParams()).toEqual({ id: "file", token: "guest" });
});
it("handles an absent root without inventing a capability", () => {
  vi.stubGlobal("document", { getElementById: () => null });
  expect(routeParams()).toEqual({ id: "", token: "" });
});
