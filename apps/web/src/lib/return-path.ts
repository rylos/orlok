// The page someone asked for before signing in (a link from Telegram, an email, a bookmark, or the
// page open when the session ended), to open it after signing in instead of the home. It travels
// in the history state of the sign-in page, never in the address, and only a path of this app is
// followed: nothing that leads to another site.

// Signing out on purpose leaves nothing to come back to: the next person to sign in on this tab
// may be someone else.
let signedOut = false;

export function markSignedOut() {
  signedOut = true;
}

export function clearSignedOut() {
  signedOut = false;
}

// The state for the sign-in page, from the page that was asked for.
export function returnState(location: { pathname: string; search: string; hash: string }) {
  const from = `${location.pathname}${location.search}${location.hash}`;
  return signedOut || location.pathname === "/" ? undefined : { from };
}

// Where to go after signing in: the page remembered, when it is a path of this app.
export function returnPath(state: unknown) {
  const from =
    typeof state === "object" && state !== null && "from" in state ? state.from : undefined;
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) {
    return "/";
  }
  if (from.includes("\\") || /^\/(login|setup)(\/|$|\?|#)/.test(from)) {
    return "/";
  }
  return from;
}
