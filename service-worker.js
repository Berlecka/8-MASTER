/* ============================================================================
 *  service-worker.js — 8-Master PWA
 *  Version : 11 (Forcer la mise à jour du cache)
 * ========================================================================== */

const CACHE_NAME = '8master-v4';
const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './engine-8master.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];

// Installation : pré-cache tous les fichiers
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()) // Force l'activation immédiate
      .catch((err) => console.error('[SW] install error:', err))
  );
});

// Activation : nettoie les anciens caches (v4.4, v5.1, etc.)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Suppression de l\'ancien cache:', key);
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim()) // Prend le contrôle des onglets ouverts
  );
});

// Fetch : cache-first, réseau en fallback
self.addEventListener('fetch', (event) => {
  // On ne gère que les requêtes GET (pas les requêtes Supabase POST, etc.)
  if (event.request.method !== 'GET') return;
  
  // Ignorer les requêtes vers Supabase (on veut toujours du réseau frais pour l'auth)
  if (event.request.url.includes('supabase.co')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // ✅ CORRECTION m3 : Fallback HTML uniquement pour la navigation
        // Si c'est une page, on renvoie index.html. Si c'est une image ou un script, on renvoie une erreur.
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    })
  );
});
