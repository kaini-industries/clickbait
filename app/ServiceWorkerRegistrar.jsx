"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const bannerStyle = {
  position: "fixed",
  zIndex: 1000,
  insetInline: 12,
  bottom: 12,
  maxWidth: 560,
  marginInline: "auto",
  padding: "12px 14px",
  border: "2px solid #161914",
  borderRadius: 4,
  background: "#FBFBF5",
  color: "#161914",
  boxShadow: "3px 3px 0 #C9D2C4",
  fontFamily:
    "var(--font-ibm-plex-mono), ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.5,
};

const buttonStyle = {
  minHeight: 44,
  marginInlineStart: 12,
  padding: "8px 14px",
  border: "2px solid #161914",
  borderRadius: 3,
  background: "#C8F51F",
  color: "#161914",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};

function currentDocumentAssets() {
  // Always prime the app entry point, not the current URL: the registrar can
  // also render on a 404, whose non-OK response must not block an update.
  const urls = new Set([new URL("/", window.location.origin).href]);

  document
    .querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="icon"][href]')
    .forEach((element) => {
      const url = element.src || element.href;
      if (url) urls.add(url);
    });

  return [...urls];
}

function subscribeToOnlineStatus(callback) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);

  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineStatus() {
  return navigator.onLine;
}

function getServerOnlineStatus() {
  return true;
}

function precacheWithWorker(worker) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error("Service-worker precache timed out."));
    }, 10_000);

    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.ok) resolve();
      else reject(new Error("Service-worker precache failed."));
    };
    worker.postMessage(
      { type: "PRECACHE_URLS", urls: currentDocumentAssets() },
      [channel.port2],
    );
  });
}

export default function ServiceWorkerRegistrar() {
  const [waitingWorker, setWaitingWorker] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const reloadStarted = useRef(false);
  const updateAccepted = useRef(false);
  const isOnline = useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineStatus,
    getServerOnlineStatus,
  );

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return undefined;
    }

    if (process.env.NODE_ENV !== "production") {
      // A production worker previously installed on the same localhost origin
      // can otherwise serve stale chunks during `next dev`.
      const rootWorkerUrl = new URL("/sw.js", window.location.origin).href;
      const rootScope = new URL("/", window.location.origin).href;
      const isRootClickbaitRegistration = (registration) =>
        registration.scope === rootScope &&
        [registration.active, registration.waiting, registration.installing]
          .some((worker) => worker?.scriptURL === rootWorkerUrl);
      const wasControlledByClickbait =
        navigator.serviceWorker.controller?.scriptURL === rootWorkerUrl;
      Promise.all([
        navigator.serviceWorker.getRegistrations().then((registrations) =>
          Promise.all(
            registrations
              .filter(isRootClickbaitRegistration)
              .map((registration) => registration.unregister()),
          ),
        ),
        caches.keys().then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith("clickbait-"))
              .map((key) => caches.delete(key)),
          ),
        ),
      ])
        .then(() => {
          if (
            wasControlledByClickbait &&
            !sessionStorage.getItem("clickbait-dev-worker-cleared")
          ) {
            sessionStorage.setItem("clickbait-dev-worker-cleared", "true");
            window.location.reload();
          }
        })
        .catch((error) => console.error("Could not clear the production service worker", error));
      return undefined;
    }

    sessionStorage.removeItem("clickbait-dev-worker-cleared");

    const handleControllerChange = () => {
      // `clients.claim()` also fires on a first install. Only reload after the
      // user explicitly accepted a waiting update, never during first-run use.
      if (!updateAccepted.current || reloadStarted.current) return;
      reloadStarted.current = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );

    let cancelled = false;

    const offerPreparedUpdate = (worker) => {
      precacheWithWorker(worker)
        .then(() => {
          if (!cancelled) setWaitingWorker(worker);
        })
        .catch((error) => {
          if (process.env.NODE_ENV !== "production") console.error(error);
        });
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return;

        if (registration.waiting && navigator.serviceWorker.controller) {
          offerPreparedUpdate(registration.waiting);
        }

        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          installingWorker.addEventListener("statechange", () => {
            if (
              installingWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              offerPreparedUpdate(installingWorker);
            }
          });
        });

        registration.update().catch(() => {
          // A failed background update must not disrupt the calculator.
        });
      })
      .catch((error) => {
        if (process.env.NODE_ENV !== "production") {
          console.error("Service worker registration failed", error);
        }
      });

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
    };
  }, []);

  const activateUpdate = () => {
    if (!waitingWorker) return;
    setIsUpdating(true);
    updateAccepted.current = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  };

  if (waitingWorker) {
    return (
      <div role="status" aria-live="polite" style={bannerStyle}>
        A new version is ready.
        <button
          type="button"
          style={buttonStyle}
          onClick={activateUpdate}
          disabled={isUpdating}
        >
          {isUpdating ? "Updating…" : "Update now"}
        </button>
      </div>
    );
  }

  if (!isOnline) {
    return (
      <div role="status" aria-live="polite" style={bannerStyle}>
        You are offline. Clickbait will use the last saved app shell; your data
        stays on this device.
      </div>
    );
  }

  return null;
}
