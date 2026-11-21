// Check a shows list against the site's own titles before harvesting, so a
// name that differs ("Magi: The Labyrinth of Magic" for "Magi") is found here
// instead of costing a site request per miss. Reads tools/site-titles.txt, one
// title per line, exported from AnimePahe's anime list.
//
//   node tools/check-names.mjs [list file]
//
// Exit 1 when a term matches nothing: the harvester would report it as a miss.
import { readFileSync } from 'node:fs';
import { fold } from './harvest-page.mjs';

const path = process.argv[2] || 'tools/shows-priority.txt';
const site = readFileSync('tools/site-titles.txt', 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((t) => ({ t, f: fold(t) }));

const words = (s) => new Set(fold(s).split(' ').filter(Boolean));
const alike = (a, b) => {
  const A = words(a);
  const B = words(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
};

const terms = readFileSync(path, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('|')[0].trim());

let bad = 0;
for (const term of terms) {
  const f = fold(term);
  const own = site.filter((s) => s.f === f || s.f.indexOf(f + ' ') === 0);
  if (own.length) continue;
  bad++;
  const near = site
    .map((s) => ({ t: s.t, sc: alike(term, s.t) }))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 3)
    .filter((x) => x.sc >= 0.34);
  console.log('miss  ' + term);
  for (const n of near) console.log('        ' + n.sc.toFixed(2) + '  ' + n.t);
  if (!near.length) console.log('        (nothing similar on the site)');
}

console.log(`\n${terms.length - bad}/${terms.length} terms match a site title; ${bad} to fix`);
process.exit(bad ? 1 : 0);