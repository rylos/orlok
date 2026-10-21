import { apiFetch } from "./api";

// Web push on this browser (R-CHAT-7). Service workers and push exist only on https or
// localhost, so over plain http on a LAN address only email notifications are available.

export type PushSupport = "supported" | "insecure" | "unsupported";

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) {
    return "insecure";
  }
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    ? "supported"
    : "unsupported";
}

// The VAPID public key is URL-safe base64.
function keyBytes(base64Url: string) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + padding).replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

export async function currentPushSubscription() {
  if (pushSupport() !== "supported") {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export class PushPermissionError extends Error {}

// The browser has no push service to deliver through: Brave keeps it off unless "Use Google
// services for push messaging" is enabled, and some privacy-hardened browsers never offer one.
export class PushServiceError extends Error {
  constructor(readonly brave: boolean) {
    super("The browser's push service is not available");
  }
}

async function isBrave() {
  const brave = (navigator as Navigator & { brave?: { isBrave(): Promise<boolean> } }).brave;
  return brave ? await brave.isBrave().catch(() => false) : false;
}

export async function subscribeToPush(vapidPublicKey: string) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushPermissionError("Notifications are not allowed");
  }
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(vapidPublicKey),
      });
    } catch (error) {
      // "Registration failed - push service error" is an AbortError: no push service.
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PushServiceError(await isBrave());
      }
      throw error;
    }
  }
  await apiFetch<void>("/me/push-subscriptions", {
    method: "POST",
    body: subscription.toJSON(),
  });
  return subscription;
}

export async function unsubscribeFromPush() {
  const subscription = await currentPushSubscription();
  if (!subscription) {
    return;
  }
  await apiFetch<void>("/me/push-subscriptions", {
    method: "DELETE",
    body: { endpoint: subscription.endpoint },
  });
  await subscription.unsubscribe();
}
