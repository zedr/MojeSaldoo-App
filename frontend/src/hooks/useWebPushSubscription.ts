/**
 * useWebPushSubscription — subscribes the browser to Web Push notifications (VAPID).
 *
 * Works on any modern browser (Chrome, Firefox, Edge, Safari 16.4+) without Firebase.
 * On browsers that don't support Push API, silently does nothing.
 *
 * Flow:
 *   1. Register our service worker (public/sw.js)
 *   2. Fetch VAPID public key from backend (GET /api/auth/push-public-key/)
 *   3. Subscribe via PushManager.subscribe()
 *   4. Send subscription to backend (POST /api/auth/push-subscription/)
 *
 * Call once after the user is authenticated (e.g. from AppLayout).
 */

import { useEffect } from 'react';
import { api } from '@/services/api';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const bytes = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) bytes[i] = rawData.charCodeAt(i);
  return bytes;
}

async function subscribeWebPush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    // Browser doesn't support Web Push — silently skip
    return;
  }

  // Request notification permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  try {
    // Register service worker
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    // Fetch VAPID public key
    const data = await api.get<{ public_key: string }>('/auth/push-public-key/');
    const applicationServerKey = urlBase64ToUint8Array(data.public_key);

    // Check if already subscribed
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    const { endpoint, keys } = subscription.toJSON() as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    // Register subscription with backend
    await api.post('/auth/push-subscription/', {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
  } catch (err) {
    // Non-fatal — push is a nice-to-have
    console.warn('[WebPush] Subscription failed:', err);
  }
}

export function useWebPushSubscription(): void {
  useEffect(() => {
    void subscribeWebPush();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
