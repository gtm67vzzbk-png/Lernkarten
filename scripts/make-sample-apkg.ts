// Erzeugt samples/Beispielstapel.apkg zum Ausprobieren (Format anki21b, mit zstd).
// Aufruf: npm run sample
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildApkg } from '../tests/fixtures/buildApkg.ts';

const box = (color: string, text: string) =>
  `<div style="background:${color};border-radius:8px;padding:8px 12px;margin-top:8px">${text}</div>`;

const notes = [
  { guid: 's1', deck: '3. Semester::Wirtschaftsrecht', fields: ['Was ist ein <b>Vertrag</b>?', 'Zwei übereinstimmende <b>Willenserklärungen</b>:<ul><li>Angebot</li><li>Annahme</li></ul>'] },
  { guid: 's2', deck: '3. Semester::Wirtschaftsrecht', fields: ['Wann ist man <i>voll geschäftsfähig</i>?', 'Ab Vollendung des 18. Lebensjahres (§ 2 BGB).' + box('#fff3c4', '<b>Merke:</b> beschränkt geschäftsfähig ab 7 Jahren')] },
  { guid: 's3', deck: '3. Semester::Wirtschaftsrecht', fields: ['Was regelt § 433 BGB?', 'Die vertragstypischen Pflichten beim <b>Kaufvertrag</b>.'] },
  { guid: 's4', deck: '3. Semester::BWL', fields: ['Formel für den <b>Gewinn</b>?', 'Gewinn = Erlöse − Kosten'] },
  { guid: 's5', deck: '3. Semester::BWL', fields: ['Was bedeutet <i>ROI</i>?', 'Return on Investment<br>= Gewinn / investiertes Kapital'] },
  { guid: 's6', deck: 'Englisch', fields: ['der Hund', 'the dog'], cards: [{ ord: 0 }, { ord: 1 }] },
  { guid: 's7', deck: 'Englisch', fields: ['die Katze', 'the cat'] },
  { guid: 's8', deck: 'Englisch', cloze: true, fields: ['Die Hauptstadt von England ist {{c1::London}}.', 'Fluss: Themse'] },
];

const crt = Math.floor(new Date(new Date().getFullYear(), 0, 1, 4).getTime() / 1000);
const data = await buildApkg({ format: 'anki21b', crt, notes });
mkdirSync('samples', { recursive: true });
writeFileSync('samples/Beispielstapel.apkg', data);
console.log('samples/Beispielstapel.apkg geschrieben');
