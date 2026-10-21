// Whether this tab was sent back to sign-in because its session ended, to say so on the sign-in
// page. Kept for the tab only; storage may be unavailable, and then nothing is said.
const KEY = "orlok-session-ended";

export function markSessionEnded() {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // Without storage the sign-in page simply shows no notice.
  }
}

export function sessionHasEnded() {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSessionEnded() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
