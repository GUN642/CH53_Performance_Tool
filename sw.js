// CH-53 Performance Tool — Service Worker
// Ziel: nach dem ERSTEN erfolgreichen Laden funktioniert das Tool komplett ohne Internet.
//
// CACHE_VERSION bei jedem inhaltlichen Update der Datei(en) hochzählen — das erzeugt
// automatisch einen neuen Cache-Namen, alte Caches werden beim Aktivieren gelöscht.
const CACHE_VERSION = 'v3.7.0';
const APP_CACHE = 'ch53-app-' + CACHE_VERSION;
const RUNTIME_CACHE = 'ch53-runtime-' + CACHE_VERSION;

// Eigene Dateien: müssen beim Install erfolgreich vorgeladen werden.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

// Google-Fonts-Stylesheet der Seite — wird beim Install direkt mitgeladen (siehe unten).
const FONTS_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@500;600;700&display=swap';

// Lädt das Google-Fonts-Stylesheet und alle darin referenzierten Schriftdateien vor.
// Wichtig: Ressourcen, die die Seite selbst beim allerersten Laden anfragt, laufen NICHT
// durch den fetch-Handler (der Service Worker übernimmt die Kontrolle erst danach). Ohne
// dieses Vorladen wären die Schriftdateien beim zweiten (evtl. bereits offline) Laden nicht
// im Cache. Schlägt das Nachladen fehl (kein Internet bei Installation), wird nur geloggt —
// die Kernfunktion des Tools hängt nicht an den Web-Fonts, es fällt auf System-Schriften zurück.
// Bricht eine Fetch-Zusage ab, wenn sie zu lange dauert (langsames/instabiles Netz),
// damit die Installation des Service Workers dadurch nicht blockiert wird.
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { mode: 'cors', signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function precacheFonts(cache) {
  try {
    const cssRes = await fetchWithTimeout(FONTS_CSS_URL, 6000);
    if (!cssRes.ok) return;
    const cssText = await cssRes.clone().text();
    await cache.put(FONTS_CSS_URL, cssRes);
    const urls = [...cssText.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
    await Promise.all(urls.map(async (u) => {
      try {
        const r = await fetchWithTimeout(u, 6000);
        if (r.ok) await cache.put(u, r);
      } catch (e) { /* einzelne Schriftdatei nicht erreichbar/zu langsam — ignorieren */ }
    }));
  } catch (e) {
    console.warn('Google Fonts konnten nicht vorgeladen werden (kein/langsames Internet bei Installation):', e);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)),
      caches.open(RUNTIME_CACHE).then((cache) => precacheFonts(cache))
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((n) => n !== APP_CACHE && n !== RUNTIME_CACHE)
        .map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

function isOwnOrigin(url) {
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Seitenaufrufe (Navigation): online = neueste Version holen, offline = aus dem Cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (isOwnOrigin(url)) {
    // Eigene Dateien: Cache-First, da sie zusammen mit dem Service Worker versioniert sind.
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
    return;
  }

  // Externe Ressourcen (Fonts, PDF-Bibliotheken): Stale-While-Revalidate.
  // Sofort aus dem Cache antworten, falls vorhanden, und im Hintergrund aktualisieren,
  // sobald wieder Internet verfügbar ist. Erster Zugriff braucht zwingend Internet.
  event.respondWith(
    caches.open(RUNTIME_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
