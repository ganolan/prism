#!/usr/bin/env node
/**
 * Renders client/public/favicon.svg to the PNG sizes browsers without SVG
 * favicon support need (Safari; iOS home screen / bookmarks):
 *   favicon-32.png, apple-touch-icon.png (180×180).
 * Re-run after editing favicon.svg:  node scripts/render-favicons.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public');
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
// iOS rounds the touch icon itself and paints transparent corners black, so
// that one is rendered full-bleed (the tile's rounded clip removed).
const TARGETS = [
  { file: 'favicon-32.png', size: 32, svg },
  { file: 'apple-touch-icon.png', size: 180, svg: svg.replace(' rx="14"', '') },
];

const browser = await chromium.launch();
try {
  for (const { file, size, svg: source } of TARGETS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
    );
    await page.screenshot({ path: join(pub, file), omitBackground: true });
    await page.close();
    console.log(`wrote ${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
