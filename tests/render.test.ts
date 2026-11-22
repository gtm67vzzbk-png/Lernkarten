// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cardSides, sanitize } from '../src/render/cardHtml';
import type { Card } from '../src/sched/types';

const base: Card = {
  id: 'x', deckId: 'A', noteGuid: 'g', ord: 0, fields: [], cloze: false, mod: 0,
  ctype: 0, queue: 0, due: 0, ivl: 0, factor: 0, reps: 0, lapses: 0, step: 0,
};

describe('HTML der Karten', () => {
  it('entfernt Skripte und Event-Handler, behält Formatierung', () => {
    const html = sanitize(
      '<b>fett</b><script>alert(1)</script><img src=x onerror="alert(1)"><div style="background:#ffd">Box</div><ul><li>a</li></ul><br>',
    );
    expect(html).not.toContain('script');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<b>fett</b>');
    expect(html).toContain('style="background:#ffd"');
    expect(html).toContain('<ul><li>a</li></ul>');
    expect(html).toContain('data-media="x"');
  });

  it('entfernt <style>, damit Karten die App nicht umgestalten', () => {
    expect(sanitize('<style>body{display:none}</style>Hallo')).toBe('Hallo');
  });

  it('Feld 1 = Frage, Feld 2 = Antwort; umgekehrte Karte tauscht', () => {
    expect(cardSides({ ...base, fields: ['F', 'A'] })).toMatchObject({ question: 'F', answer: 'A' });
    expect(cardSides({ ...base, ord: 1, fields: ['F', 'A'] })).toMatchObject({ question: 'A', answer: 'F' });
  });

  it('Lückentext', () => {
    const s = cardSides({ ...base, cloze: true, fields: ['{{c1::Berlin}} ist in {{c2::Deutschland::Land}}', 'Extra'] });
    expect(s.question).toBe('<span class="cloze">[…]</span> ist in Deutschland');
    expect(s.answer).toContain('<span class="cloze">Berlin</span> ist in Deutschland');
    expect(s.answer).toContain('Extra');
    const s2 = cardSides({ ...base, ord: 1, cloze: true, fields: ['{{c1::Berlin}} ist in {{c2::Deutschland::Land}}', ''] });
    expect(s2.question).toBe('Berlin ist in <span class="cloze">[Land]</span>');
  });

  it('entfernt Sound-Tags', () => {
    expect(cardSides({ ...base, fields: ['Hallo [sound:a.mp3]', 'B'] }).question).toBe('Hallo ');
  });
});
