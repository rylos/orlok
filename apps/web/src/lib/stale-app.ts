// A page left open across a deploy asks for a piece of the app that the server has replaced: the
// build it came from is gone, and every file in it is named after its contents, so the old name
// is a 404 for ever. Nothing in the page can recover from that — it has to be loaded again.

// A failed dynamic import, in the words the browsers use for it.
const STALE = /dynamically imported module|Importing a module script failed|module script failed/i;

export function isStaleAppError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return STALE.test(message);
}

const RELOADED_AT = "orlok-reloaded-at";
// Long enough that a server that truly cannot serve the file leaves a readable error on screen
// instead of a page reloading itself for ever.
const QUIET_MS = 30_000;

export function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < QUIET_MS) {
      return false;
    }
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // Storage unavailable: one reload is still better than a page that cannot go on.
  }
  window.location.reload();
  return true;
}
