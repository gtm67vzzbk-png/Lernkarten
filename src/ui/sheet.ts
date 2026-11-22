import { h } from './dom';

/** Öffnet ein Blatt (Dialog). Auf dem iPad mittig, auf dem iPhone von unten. */
export function openSheet(title: string, body: Node, opts: { onClose?: () => void } = {}): () => void {
  const close = () => {
    overlay.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => overlay.remove(), 200);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const panel = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('button', { class: 'link', text: 'Fertig', onclick: close })),
    h('div', { class: 'sheet-body' }, body),
  );
  const overlay = h('div', { class: 'overlay', onclick: (e: Event) => e.target === overlay && close() }, panel);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => overlay.classList.add('open'));
  return close;
}

/** Bestätigungsdialog mit zwei Buttons. */
export function confirmDialog(message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const close = openSheet(
      'Bitte bestätigen',
      h(
        'div',
        { class: 'confirm' },
        h('p', { text: message }),
        h(
          'div',
          { class: 'confirm-buttons' },
          h('button', { class: 'btn', text: 'Abbrechen', onclick: () => close() }),
          h('button', {
            class: danger ? 'btn danger' : 'btn primary',
            text: okLabel,
            onclick: () => {
              result = true;
              close();
            },
          }),
        ),
      ),
      { onClose: () => resolve(result) },
    );
  });
}

let toastTimer: number | undefined;

/** Kurze Meldung am unteren Rand. */
export function toast(message: string, ms = 3500): void {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text: message });
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/** Vollflächiger Hinweis, z. B. während des Imports. */
export function busy(message: string): { update: (m: string) => void; done: () => void } {
  const text = h('p', { text: message });
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, h('div', { class: 'spinner' }), text));
  document.body.append(el);
  return { update: (m) => (text.textContent = m), done: () => el.remove() };
}

/** Öffnet die Dateiauswahl. Kein "accept", damit Safari auf dem iPad .apkg-Dateien nicht ausgraut. */
export function pickFiles(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Speichert/teilt eine Datei. Auf iPad/iPhone über das Teilen-Menü („In Dateien sichern“). */
export async function saveFile(name: string, content: string, type: string): Promise<void> {
  const file = new File([content], name, { type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}
