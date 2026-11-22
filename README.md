# Merkwerk

Karteikarten-App im Stil von AnkiMobile – als Web-App (PWA) für iPad und iPhone.
Läuft komplett im Browser, ohne Server und ohne Konto. Jedes Gerät speichert seine
Stapel und seinen Lernfortschritt selbst (IndexedDB).

## Funktionen

- Import von Anki-Paketen (`.apkg`): `collection.anki2`, `collection.anki21` und `collection.anki21b` (zstd)
- Stapel mit Unterstapeln (`3. Semester::Wirtschaftsrecht`), Lernfortschritt wird übernommen
- Doppelter Import erzeugt keine Duplikate (der eigene Fortschritt bleibt erhalten)
- Lernalgorithmus wie Anki (SM-2, Standardoptionen, Fuzz, Tageswechsel um 4 Uhr)
- Standardmäßig ohne Tageslimit (Limits pro Stapel über das Zahnrad einstellbar)
- Bilder aus den Paketen, Lückentext, umgekehrte Karten
- Rückgängig, Tastaturkürzel (Leertaste, 1–4, Z), Backup als JSON-Datei
- Offline nutzbar, „Zum Home-Bildschirm“ wie eine echte App

## Entwickeln

```bash
npm install
npm run dev       # Entwicklungsserver
npm test          # Tests (Lernalgorithmus, .apkg-Import, HTML)
npm run build     # Produktions-Build nach dist/
npm run sample    # erzeugt samples/Beispielstapel.apkg
```

## Veröffentlichen

Die GitHub Action `.github/workflows/deploy.yml` testet und baut bei jedem Push.
Pushes auf `main` werden automatisch auf GitHub Pages veröffentlicht.
Einmalig nötig: *Settings → Pages → Source: „GitHub Actions“*.

## Aufbau

```
src/
  sched/        Lernalgorithmus (scheduler.ts), Zeit/Lerntag (time.ts), Stapel & Limits (queue.ts)
  import/       .apkg-Import (apkg.ts), sql.js-Lader für den Browser
  render/       Karten-HTML: DOMPurify, Lückentext, Bilder, Farben im dunklen Design
  ui/           Stapelübersicht, Lernansicht, Dialoge
  store.ts      App-Zustand + Speicherung in IndexedDB
  db.ts         IndexedDB-Hilfen
tests/          Vitest-Tests, fixtures/buildApkg.ts erzeugt echte .apkg-Dateien
```
