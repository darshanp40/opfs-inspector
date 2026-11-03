import { chromium, firefox, webkit } from 'playwright';

const all = [
  { name: 'chromium', type: chromium },
  { name: 'firefox', type: firefox },
  { name: 'webkit', type: webkit },
];

// ENGINES=chromium,webkit runs a subset.
const wanted = process.env.ENGINES ? process.env.ENGINES.split(',') : null;
export const engines = all.filter((e) => !wanted || wanted.includes(e.name));
