// Rendert public/favicon.svg in die PNG-Icons (einmalig, Ergebnis ist eingecheckt).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../public/favicon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['apple-touch-icon.png', 180, false],
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-512-maskable.png', 512, true],
  ];
  for (const [name, size, maskable] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    // iOS rundet die Ecken selbst ab -> Apple-Icon und Maskable ohne eigene Rundung.
    const fullBleed = name.startsWith('apple') || maskable;
    let s = svg;
    if (fullBleed) s = s.replace('rx="112"', 'rx="0"');
    if (maskable) s = s.replace('<rect x="150"', '<g transform="translate(51 51) scale(.8)"><rect x="150"').replace('</svg>', '</g></svg>');
    await page.setContent(`<html><body style="margin:0;background:transparent">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, '../public', name), omitBackground: !fullBleed, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
})();
