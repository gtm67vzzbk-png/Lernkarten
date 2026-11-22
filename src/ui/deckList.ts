import type { AppStore } from '../store';
import { allCards, countsOf, type DeckNode } from '../sched/queue';
import { h } from './dom';

export interface DeckListActions {
  study: (deckId: string) => void;
  importFiles: () => void;
  backup: () => void;
  settings: () => void;
}

function countsLine(store: AppStore, node: DeckNode, now: number): HTMLElement {
  const c = countsOf(store.queuesFor(node, now));
  const total = c.newCount + c.learnCount + c.reviewCount;
  return h(
    'div',
    { class: 'deck-counts' },
    h('span', { class: 'total', text: `${total} Aufsummiert` }),
    h('span', { class: 'bar', text: ' | ' }),
    h('span', { class: 'c-new', text: `${c.newCount} Neu` }),
    ' · ',
    h('span', { class: 'c-learn', text: `${c.learnCount} Lernen` }),
    ' · ',
    h('span', { class: 'c-review', text: `${c.reviewCount} Wiederholen` }),
  );
}

export function renderDeckList(root: HTMLElement, store: AppStore, actions: DeckListActions): void {
  const now = Date.now();
  const tree = store.tree().filter((n) => allCards(n).length > 0);

  const rows = (node: DeckNode, out: HTMLElement[]) => {
    const kids = node.children.filter((c) => allCards(c).length > 0);
    const collapsed = store.collapsed.has(node.id);
    const toggle = kids.length
      ? h('button', {
          class: `toggle${collapsed ? '' : ' open'}`,
          'aria-label': collapsed ? 'Unterstapel aufklappen' : 'Unterstapel zuklappen',
          'aria-expanded': String(!collapsed),
          onclick: async (e: Event) => {
            e.stopPropagation();
            await store.toggleCollapsed(node.id);
            renderDeckList(root, store, actions);
          },
        })
      : h('span', { class: 'toggle-spacer' });
    out.push(
      h(
        'div',
        {
          class: `deck-row depth-${Math.min(node.depth, 6)}`,
          role: 'button',
          tabindex: '0',
          onclick: () => actions.study(node.id),
          onkeydown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), actions.study(node.id)),
        },
        toggle,
        h('div', { class: 'deck-info' }, h('div', { class: 'deck-name', text: node.name }), countsLine(store, node, now)),
        h('span', { class: 'chevron', 'aria-hidden': 'true' }),
      ),
    );
    if (!collapsed) kids.forEach((k) => rows(k, out));
  };

  const list = h('div', { class: 'deck-list' });
  for (const top of tree) {
    const out: HTMLElement[] = [];
    rows(top, out);
    list.append(h('section', { class: 'deck-card' }, ...out));
  }
  if (!tree.length) {
    list.append(
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-icon', 'aria-hidden': 'true' }),
        h('h2', { text: 'Noch keine Stapel' }),
        h('p', { text: 'Tippe unten links auf „Importieren“ und wähle eine .apkg-Datei aus, z. B. aus der Dateien-App.' }),
      ),
    );
  }

  root.replaceChildren(
    h(
      'div',
      { class: 'screen decks' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'side' }),
        h('h1', { text: 'Stapelübersicht' }),
        h('div', { class: 'side right' }, h('button', { class: 'icon-btn gear', 'aria-label': 'Einstellungen', onclick: actions.settings })),
      ),
      h('main', { class: 'scroll' }, list),
      h(
        'footer',
        { class: 'bottombar' },
        h('button', { class: 'link', text: 'Importieren', onclick: actions.importFiles }),
        h('button', { class: 'link', text: 'Backup', onclick: actions.backup }),
      ),
    ),
  );
}
