import type { AppStore } from '../store';
import { formatInterval } from '../sched/scheduler';
import { countsOf, findNode, pickNext, queueKind, type NextCard } from '../sched/queue';
import type { Card, Ease } from '../sched/types';
import { cardSides, fixColorsForDark, resolveImages, sanitize } from '../render/cardHtml';
import { h } from './dom';

type Kind = 'new' | 'learn' | 'review';

const BUTTONS: { ease: Ease; label: string; cls: string }[] = [
  { ease: 1, label: 'Nochmal', cls: 'again' },
  { ease: 2, label: 'Schwer', cls: 'hard' },
  { ease: 3, label: 'Gut', cls: 'good' },
  { ease: 4, label: 'Einfach', cls: 'easy' },
];

export class StudyView {
  private el!: HTMLElement;
  private content!: HTMLElement;
  private scroller!: HTMLElement;
  private bottom!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private current: { card: Card; kind: Kind } | null = null;
  private revealed = false;
  private busy = false;
  private sessionCount = 0;
  private lastAnsweredId: string | undefined;
  private waitTimer: number | undefined;
  private renderToken = 0;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(
    private root: HTMLElement,
    private store: AppStore,
    private deckId: string,
    private onBack: () => void,
  ) {}

  mount(): void {
    const node = findNode(this.store.tree(), this.deckId);
    this.undoBtn = h('button', { class: 'link undo', text: 'Rückgängig', onclick: () => this.undo() });
    this.content = h('div', { class: 'card-content' });
    this.scroller = h('main', { class: 'card-scroll', onclick: () => this.tapCard() }, this.content);
    this.bottom = h('footer', { class: 'study-bottom', onclick: () => this.tapCard() });
    this.el = h(
      'div',
      { class: 'screen study' },
      h(
        'header',
        { class: 'topbar study-bar' },
        h('div', { class: 'side' }, h('button', { class: 'link back', text: 'Stapel', onclick: () => this.leave() })),
        h('div', { class: 'study-title', text: node?.name ?? '' }),
        h('div', { class: 'side right' }, this.undoBtn),
      ),
      this.scroller,
      this.bottom,
    );
    this.root.replaceChildren(this.el);
    document.addEventListener('keydown', this.onKey);
    this.next();
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKey);
    window.clearTimeout(this.waitTimer);
  }

  private leave(): void {
    this.unmount();
    this.onBack();
  }

  private updateUndo(): void {
    this.undoBtn.disabled = !this.store.canUndo();
  }

  private queues() {
    return this.store.queues(this.deckId);
  }

  private next(forced?: { card: Card; kind: Kind }): void {
    window.clearTimeout(this.waitTimer);
    this.revealed = false;
    this.updateUndo();
    const q = this.queues();
    let pick: NextCard;
    if (forced) pick = { kind: 'card', card: forced.card, queue: forced.kind };
    else if (!q) pick = { kind: 'done' };
    else pick = pickNext(q, Date.now(), this.store.scheduler.config.learnAheadSecs, this.sessionCount, this.lastAnsweredId);

    if (pick.kind === 'done') return this.showDone();
    if (pick.kind === 'wait') return this.showWait(pick.until);
    this.current = { card: pick.card, kind: pick.queue };
    void this.renderCard();
  }

  private counts(): HTMLElement {
    const q = this.queues();
    const c = q ? countsOf(q) : { newCount: 0, learnCount: 0, reviewCount: 0 };
    const kind = this.current?.kind;
    const span = (cls: string, n: number, k: Kind) => h('span', { class: `${cls}${kind === k ? ' current' : ''}`, text: String(n) });
    return h(
      'div',
      { class: 'counts', 'aria-label': `${c.newCount} neu, ${c.learnCount} lernen, ${c.reviewCount} wiederholen` },
      span('c-new', c.newCount, 'new'),
      h('span', { class: 'plus', text: ' + ' }),
      span('c-learn', c.learnCount, 'learn'),
      h('span', { class: 'plus', text: ' + ' }),
      span('c-review', c.reviewCount, 'review'),
    );
  }

  private async renderCard(): Promise<void> {
    if (!this.current) return;
    const token = ++this.renderToken;
    const { card } = this.current;
    const sides = cardSides(card);
    const q = h('div', { class: 'q' });
    q.innerHTML = sanitize(sides.question);
    const wrap = h('div', { class: 'card-inner' }, q);
    await this.finishHtml(wrap);
    if (token !== this.renderToken) return;
    this.content.replaceChildren(wrap);
    this.scroller.scrollTop = 0;
    this.scroller.classList.remove('revealed');
    this.bottom.replaceChildren(this.counts(), h('div', { class: 'tap-hint', text: 'Tippen, um die Antwort zu zeigen' }));
    this.bottom.classList.remove('answering');
  }

  private async finishHtml(el: HTMLElement): Promise<void> {
    await resolveImages(el, (n) => this.store.mediaUrl(n));
    // Erst im Dokument lassen sich Farben berechnen – kurz unsichtbar einhängen.
    el.style.visibility = 'hidden';
    document.body.append(el);
    fixColorsForDark(el);
    el.remove();
    el.style.visibility = '';
  }

  private tapCard(): void {
    if (window.getSelection()?.toString()) return;
    if (!this.revealed) void this.reveal();
  }

  private async reveal(): Promise<void> {
    if (!this.current || this.revealed) return;
    this.revealed = true;
    const token = ++this.renderToken;
    const { card } = this.current;
    const sides = cardSides(card);
    const wrap = h('div', { class: 'card-inner' });
    let sep: HTMLElement | null = null;
    if (sides.replaceQuestion) {
      const a = h('div', { class: 'a' });
      a.innerHTML = sanitize(sides.answer);
      wrap.append(a);
    } else {
      const q = h('div', { class: 'q' });
      q.innerHTML = sanitize(sides.question);
      sep = h('hr', { class: 'answer-sep' });
      const a = h('div', { class: 'a' });
      a.innerHTML = sanitize(sides.answer);
      wrap.append(q, sep, a);
    }
    await this.finishHtml(wrap);
    if (token !== this.renderToken) return;
    const scroll = this.scroller.scrollTop;
    this.content.replaceChildren(wrap);
    this.scroller.scrollTop = scroll;
    this.scroller.classList.add('revealed');

    const now = Date.now();
    const secs = this.store.scheduler.previewSecs(card, now, card.id);
    const row = h(
      'div',
      { class: 'answer-buttons' },
      ...BUTTONS.map((b, i) =>
        h(
          'div',
          { class: 'ans-col' },
          h('div', { class: 'ivl', text: formatInterval(secs[i], this.store.scheduler.config.learnAheadSecs) }),
          h('button', {
            class: `ans ${b.cls}`,
            text: b.label,
            onclick: (e: Event) => {
              e.stopPropagation();
              void this.answer(b.ease);
            },
          }),
        ),
      ),
    );
    this.bottom.replaceChildren(this.counts(), row);
    this.bottom.classList.add('answering');

    // Lange Antworten: zur Trennlinie scrollen, falls die Antwort außerhalb des sichtbaren Bereichs liegt.
    if (sep) {
      const top = sep.offsetTop;
      if (top > this.scroller.scrollTop + this.scroller.clientHeight * 0.6) {
        this.scroller.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' });
      }
    }
  }

  private async answer(ease: Ease): Promise<void> {
    if (!this.current || !this.revealed || this.busy) return;
    this.busy = true;
    try {
      const { card, kind } = this.current;
      await this.store.answer(card, ease, kind);
      this.sessionCount++;
      this.lastAnsweredId = card.id;
      this.current = null;
      this.next();
    } finally {
      this.busy = false;
    }
  }

  private async undo(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const card = await this.store.undo();
      if (!card) return;
      this.sessionCount = Math.max(0, this.sessionCount - 1);
      this.lastAnsweredId = undefined;
      // Karte gehört evtl. zu einem anderen Stapel (z. B. nach Wechsel) – nur hier zeigen, wenn passend.
      const inDeck = card.deckId === this.deckId || card.deckId.startsWith(this.deckId + '::');
      this.next(inDeck ? { card, kind: queueKind(card) } : undefined);
    } finally {
      this.busy = false;
    }
  }

  private showDone(): void {
    this.current = null;
    this.renderToken++;
    this.content.replaceChildren(
      h(
        'div',
        { class: 'done' },
        h('div', { class: 'done-icon', 'aria-hidden': 'true' }),
        h('h2', { text: 'Glückwunsch! Du hast diesen Stapel für heute fertig gelernt.' }),
        h('button', { class: 'btn primary', text: 'Zur Stapelübersicht', onclick: () => this.leave() }),
      ),
    );
    this.bottom.replaceChildren();
    this.bottom.classList.remove('answering');
  }

  private showWait(until: number): void {
    this.current = null;
    this.renderToken++;
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    this.content.replaceChildren(
      h(
        'div',
        { class: 'done' },
        h('h2', { text: 'Gerade ist keine Karte fällig.' }),
        h('p', { text: `Die nächste Lernkarte ist in ${mins} Min. dran. Du kannst hier warten oder später weitermachen.` }),
        h('button', { class: 'btn primary', text: 'Zur Stapelübersicht', onclick: () => this.leave() }),
      ),
    );
    this.bottom.replaceChildren(this.counts());
    this.waitTimer = window.setTimeout(() => this.next(), 15_000);
  }

  private handleKey(e: KeyboardEvent): void {
    if (document.querySelector('.overlay')) return;
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void this.undo();
      }
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!this.current) return;
      if (!this.revealed) void this.reveal();
      else void this.answer(3);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      if (this.revealed) void this.answer(Number(e.key) as Ease);
    } else if (e.key === 'z' || e.key === 'u') {
      void this.undo();
    } else if (e.key === 'Escape') {
      this.leave();
    }
  }
}
