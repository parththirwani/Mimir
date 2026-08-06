// Web Push client helpers (7.1). Static-export friendly: the VAPID public key is
// fetched from the api (single source of truth) rather than baked at build time.
const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1";

const isSupported =
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

// True when running inside the Tauri desktop shell. Its WebKitGTK WebView has no
// Web Push API, so the desktop path uses native notifications (7.2) instead.
export function inDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// In-app on/off flag for native notifications (OS permission can't be revoked
// programmatically, so disabling clears this flag and stops the firing site).
const NATIVE_FLAG = "mimir:notifications:native";

export async function pushEnabled(): Promise<boolean> {
  if (inDesktopShell()) {
    const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
    return localStorage.getItem(NATIVE_FLAG) === "1" && (await isPermissionGranted());
  }
  if (!isSupported) return false;
  const res = await fetch(`${API}/push/status`, { credentials: "include" });
  return res.ok ? (await res.json()).enabled === true : false;
}

async function getApplicationServerKey(): Promise<ArrayBuffer> {
  const res = await fetch(`${API}/push/public-key`);
  if (!res.ok) throw new Error("push not configured");
  const { publicKey } = (await res.json()) as { publicKey: string };
  const padding = publicKey.replace(/=+$/, "");
  const bin = atob(padding.replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new ArrayBuffer(bin.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return buf;
}

// Register the SW and request the browser for a PushSubscription, then store it.
// Throws a descriptive Error on each failure so the settings UI can show why.
export async function enablePush(): Promise<boolean> {
  if (inDesktopShell()) {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) throw new Error("Desktop notification permission was denied.");
    localStorage.setItem(NATIVE_FLAG, "1");
    return true;
  }
  if (!isSupported) throw new Error("This browser doesn't support Web Push.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Permission was denied. Reset the site's notification permission in the browser, then retry."
        : "Notification permission was not granted.",
    );
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: await getApplicationServerKey(),
  });

  const res = await fetch(`${API}/push/subscribe`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) throw new Error("The push subscription couldn't be saved.");
  return true;
}

export async function disablePush(): Promise<void> {
  if (inDesktopShell()) {
    localStorage.removeItem(NATIVE_FLAG);
    return;
  }
  if (!isSupported) return;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await fetch(`${API}/push/unsubscribe`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  }
}

// Desktop shell: fire a native notification for an incoming event, but only when
// the window isn't focused (a focused window shows it in-app already). No-op in a
// browser — web push's service worker owns that path.
export async function maybeNotifyDesktop(title: string, body: string): Promise<void> {
  if (!inDesktopShell()) return;
  if (localStorage.getItem(NATIVE_FLAG) !== "1") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  const { sendNotification } = await import("@tauri-apps/plugin-notification");
  sendNotification({ title, body });
}
