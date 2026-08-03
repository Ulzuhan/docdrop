/**
 * Next calls `register` in EVERY runtime, including the Edge Runtime, where `fs` and
 * `process.cwd()` do not exist. That is why the real startup lives in a separate file
 * imported only under Node: importing it from here — even inside an `if` — would still
 * pull it into the Edge bundle and break the build. This is the pattern Next
 * documents.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
