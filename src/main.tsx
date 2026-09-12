/**
 * The browser entry point. Styles first, then the app; encryption lives in
 * `src/lib/e2ee.ts` and is imported by the screens that need it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";

import { App } from "./app";

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
