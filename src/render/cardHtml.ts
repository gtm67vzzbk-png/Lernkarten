import DOMPurify from 'dompurify';
import type { Card } from '../sched/types';

export interface CardSides {
  question: string;
  answer: string;
  /** Bei Lückentext ersetzt die Antwortseite die Frage komplett. */
  replaceQuestion: boolean;
}

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

function cloze(text: string, ord: number, reveal: boolean): string {
  return text.replace(CLOZE_RE, (_m, n: string, content: string, hint?: string) => {
    if (Number(n) !== ord) return content;
    if (reveal) return `<span class="cloze">${content}</span>`;
    return `<span class="cloze">[${hint ? hint : '…'}]</span>`;
  });
}

/** Entfernt Anki-Sound-Tags wie [sound:datei.mp3]. */
function stripSound(html: string): string {
  return html.replace(/\[sound:[^\]]*\]/g, '');
}

/** Liefert das (noch nicht bereinigte) HTML für Frage und Antwort. */
export function cardSides(card: Card): CardSides {
  const f = card.fields.map(stripSound);
  if (card.cloze) {
    const ord = card.ord + 1;
    const extra = f.slice(1).filter((x) => x.trim()).join('<br>');
    return {
      question: cloze(f[0] ?? '', ord, false),
      answer: cloze(f[0] ?? '', ord, true) + (extra ? `<hr class="answer-sep">${extra}` : ''),
      replaceQuestion: true,
    };
  }
  // Umgekehrte Karten ("Einfach (mit umgekehrter Karte)"): Feld 2 fragt, Feld 1 antwortet.
  if (card.ord === 1 && f.length >= 2) return { question: f[1], answer: f[0], replaceQuestion: false };
  return { question: f[0] ?? '', answer: f[1] ?? '', replaceQuestion: false };
}

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  // Keine Ereignis-Attribute; DOMPurify entfernt sie ohnehin, hier zur Sicherheit.
  if (data.attrName.startsWith('on')) data.keepAttr = false;
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  // Lokale Bilder nicht sofort laden (würde ins Leere gehen), sondern später aus IndexedDB auflösen.
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    if (src && !/^(https?:|data:|blob:)/i.test(src)) {
      node.setAttribute('data-media', src);
      node.removeAttribute('src');
    }
  }
  // Links in einem neuen Fenster öffnen, damit die App nicht verlassen wird.
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Bereinigt HTML: keine Skripte, keine Styles, die die App verändern könnten. */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'],
    FORBID_ATTR: ['id'],
    ALLOW_DATA_ATTR: false,
  });
}

// ------------------------------------------------------------ Farben im dunklen Design

function parseColor(value: string, probe: HTMLElement): [number, number, number, number] | null {
  if (!value || value === 'transparent' || value === 'inherit' || value === 'initial') return null;
  probe.style.color = '';
  probe.style.color = value;
  const c = getComputedStyle(probe).color;
  const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

function luminance([r, g, b]: [number, number, number, number]): number {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Viele Karten sind für helle Hintergründe gestaltet. Damit sie im dunklen Design lesbar
 * bleiben: dunkle Schrift auf dunklem Grund wird hell; helle Boxen bekommen dunkle Schrift.
 */
export function fixColorsForDark(root: HTMLElement): void {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  try {
    const walk = (el: HTMLElement, onLight: boolean) => {
      let light = onLight;
      const bg = parseColor(el.style.backgroundColor || el.getAttribute('bgcolor') || '', probe);
      if (bg && bg[3] > 0.3) light = luminance(bg) > 0.4;
      const colorAttr = el.tagName === 'FONT' ? el.getAttribute('color') ?? '' : '';
      const fg = parseColor(el.style.color || colorAttr, probe);
      if (fg) {
        const l = luminance(fg);
        if (!light && l < 0.06) {
          el.style.color = '#f2f2f7';
          if (colorAttr) el.removeAttribute('color');
        } else if (light && l > 0.6) {
          el.style.color = '#111';
          if (colorAttr) el.removeAttribute('color');
        }
      } else if (light !== onLight && light) {
        el.style.color = '#111';
      }
      for (const child of Array.from(el.children)) walk(child as HTMLElement, light);
    };
    for (const child of Array.from(root.children)) walk(child as HTMLElement, false);
  } finally {
    probe.remove();
  }
}

/** Ersetzt Bildquellen durch Object-URLs der gespeicherten Mediendateien. */
export async function resolveImages(root: HTMLElement, getUrl: (name: string) => Promise<string | null>): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-media]'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('data-media') ?? '';
      let name = src;
      try {
        name = decodeURIComponent(src);
      } catch {
        /* Name bleibt */
      }
      const url = await getUrl(name);
      if (url) img.src = url;
      else img.replaceWith(Object.assign(document.createElement('span'), { className: 'missing-img', textContent: `[Bild fehlt: ${name}]` }));
    }),
  );
}
