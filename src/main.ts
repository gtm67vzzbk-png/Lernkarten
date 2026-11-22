import './styles.css';
import { AppStore } from './store';
import { renderDeckList } from './ui/deckList';
import { StudyView } from './ui/study';
import { h } from './ui/dom';
import { busy, confirmDialog, openSheet, pickFiles, saveFile, toast } from './ui/sheet';
import { allCards, UNLIMITED } from './sched/queue';
import { registerSW } from 'virtual:pwa-register';

const app = document.getElementById('app')!;
const store = new AppStore();
let study: StudyView | null = null;

function showDecks(): void {
  study?.unmount();
  study = null;
  renderDeckList(app, store, {
    study: (id) => {
      study = new StudyView(app, store, id, showDecks);
      study.mount();
    },
    importFiles: () => void importFiles(),
    backup: openBackup,
    settings: openSettings,
  });
}

// ---------------------------------------------------------------- Import

async function importFiles(): Promise<void> {
  const files = await pickFiles(true);
  if (!files.length) return;
  const b = busy('Import wird vorbereitet …');
  const messages: string[] = [];
  try {
    const [{ parseApkg }, { loadSql }] = await Promise.all([import('./import/apkg'), import('./import/sqlBrowser')]);
    for (const [i, f] of files.entries()) {
      b.update(files.length > 1 ? `Importiere ${i + 1} von ${files.length}: ${f.name}` : `Importiere ${f.name} …`);
      try {
        if (!/\.(apkg|colpkg|zip)$/i.test(f.name)) throw new Error('Bitte eine .apkg-Datei auswählen.');
        const res = await parseApkg(f, loadSql);
        const sum = await store.applyImport(res);
        const parts = [`${sum.added} neue Karten`];
        if (sum.updated) parts.push(`${sum.updated} schon vorhanden (aktualisiert)`);
        messages.push(`${sum.decks.join(', ') || f.name}: ${parts.join(', ')}`);
      } catch (e) {
        console.error(e);
        messages.push(`${f.name}: ${(e as Error).message || 'Import fehlgeschlagen'}`);
      }
    }
  } catch (e) {
    console.error(e);
    messages.push('Der Import konnte nicht geladen werden. Bitte Internetverbindung prüfen und erneut versuchen.');
  } finally {
    b.done();
  }
  showDecks();
  openSheet('Import abgeschlossen', h('div', { class: 'sheet-text' }, ...messages.map((m) => h('p', { text: m }))));
}

// ---------------------------------------------------------------- Backup

function openBackup(): void {
  const close = openSheet(
    'Backup',
    h(
      'div',
      { class: 'sheet-text' },
      h('p', {
        text: 'Sichere deine Stapel und deinen Lernfortschritt als Datei, z. B. in der Dateien-App oder in iCloud Drive. So kannst du ihn auch auf ein anderes Gerät übertragen.',
      }),
      h('button', {
        class: 'btn primary wide',
        text: 'Backup exportieren',
        onclick: async () => {
          const data = JSON.stringify(store.exportBackup());
          const d = new Date();
          const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          await saveFile(`merkwerk-backup-${stamp}.json`, data, 'application/json');
        },
      }),
      h('button', {
        class: 'btn wide',
        text: 'Backup einspielen',
        onclick: async () => {
          const [file] = await pickFiles(false);
          if (!file) return;
          const ok = await confirmDialog(
            'Das Backup wird eingespielt. Gleiche Karten auf diesem Gerät werden mit dem Stand aus dem Backup überschrieben. Fortfahren?',
            'Einspielen',
          );
          if (!ok) return;
          try {
            const n = await store.importBackup(JSON.parse(await file.text()));
            close();
            showDecks();
            toast(`Backup eingespielt: ${n} Karten.`);
          } catch (e) {
            toast((e as Error).message.startsWith('Diese Datei') ? (e as Error).message : 'Die Datei konnte nicht gelesen werden.');
          }
        },
      }),
      h('p', { class: 'hint', text: 'Hinweis: Bilder sind nicht im Backup enthalten. Importiere dafür die .apkg-Datei auf dem neuen Gerät erneut – dein Fortschritt bleibt erhalten.' }),
    ),
  );
}

// ---------------------------------------------------------------- Einstellungen

function numberField(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const show = (v: number) => (v >= UNLIMITED ? '' : String(v));
  const input = h('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: 'ohne Limit', value: show(value) });
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    const v = raw === '' ? UNLIMITED : Math.max(0, Math.min(UNLIMITED, Math.round(Number(raw) || 0)));
    input.value = show(v);
    onChange(v);
  });
  return h('label', { class: 'field' }, h('span', { text: label }), input);
}

function openSettings(): void {
  const deckRows = store
    .tree()
    .filter((n) => allCards(n).length)
    .map((n) =>
      h(
        'div',
        { class: 'settings-deck' },
        h('div', {}, h('div', { class: 'deck-name', text: n.name }), h('div', { class: 'hint', text: `${allCards(n).length} Karten` })),
        h('button', {
          class: 'btn danger small',
          text: 'Löschen',
          onclick: async () => {
            const ok = await confirmDialog(`Stapel „${n.name}“ mit allen Unterstapeln und dem Lernfortschritt löschen?`, 'Löschen', true);
            if (!ok) return;
            await store.deleteDeck(n.id);
            closeSettings();
            showDecks();
            toast(`„${n.name}“ wurde gelöscht.`);
          },
        }),
      ),
    );

  const closeSettings = openSheet(
    'Einstellungen',
    h(
      'div',
      { class: 'sheet-text' },
      h('h3', { text: 'Tageslimits pro Stapel (Standard: ohne Limit)' }),
      numberField('Neue Karten pro Tag', store.settings.newPerDay, (v) => void store.saveSettings({ ...store.settings, newPerDay: v }).then(showDecks)),
      numberField('Wiederholungen pro Tag', store.settings.reviewsPerDay, (v) => void store.saveSettings({ ...store.settings, reviewsPerDay: v }).then(showDecks)),
      h('p', { class: 'hint', text: 'Feld leer lassen = ohne Limit. Der neue Lerntag beginnt jeweils um 4:00 Uhr nachts.' }),
      h('h3', { text: 'Stapel' }),
      ...(deckRows.length ? deckRows : [h('p', { class: 'hint', text: 'Noch keine Stapel vorhanden.' })]),
      h('h3', { text: 'Tastatur' }),
      h('p', { class: 'hint', text: 'Leertaste: Antwort zeigen bzw. „Gut“ · 1–4: Nochmal, Schwer, Gut, Einfach · Z oder ⌘Z: Rückgängig · Esc: zurück' }),
      h('p', { class: 'hint', text: `Merkwerk · Version ${__APP_VERSION__}` }),
    ),
  );
}

// ---------------------------------------------------------------- Start

async function start(): Promise<void> {
  try {
    await store.load();
  } catch (e) {
    console.error(e);
    app.replaceChildren(
      h('div', { class: 'fatal' }, h('h2', { text: 'Die Daten konnten nicht geladen werden.' }), h('p', { text: String((e as Error).message ?? e) })),
    );
    return;
  }
  showDecks();
  // Daten möglichst vor automatischem Löschen durch den Browser schützen.
  void navigator.storage?.persist?.().catch(() => undefined);
}

// Pinch-Zoom in iOS verhindern (Doppeltipp-Zoom verhindert CSS: touch-action: manipulation).
document.addEventListener('gesturestart', (e) => e.preventDefault());

// Neuer Tag: beim Zurückkehren in die App die Übersicht aktualisieren.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !study) showDecks();
});

const updateSW = registerSW({
  onNeedRefresh() {
    const bar = h(
      'button',
      {
        class: 'update-bar',
        onclick: () => void updateSW(true),
      },
      'Neue Version verfügbar – tippen zum Aktualisieren',
    );
    document.body.append(bar);
  },
});

void start();
