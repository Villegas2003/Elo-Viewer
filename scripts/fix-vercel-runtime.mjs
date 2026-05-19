// Post-build: reescribe .vc-config.json para usar nodejs20.x
// El adapter @astrojs/vercel@7.8.2 hardcodea nodejs18.x, que Vercel ya no soporta.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const RUNTIME = 'nodejs20.x';
const fnDir = '.vercel/output/functions';

if (!existsSync(fnDir)) {
  console.log('[fix-vercel-runtime] No functions directory, skipping');
  process.exit(0);
}

let patched = 0;
for (const d of readdirSync(fnDir)) {
  const p = join(fnDir, d, '.vc-config.json');
  if (!existsSync(p)) continue;
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  if (cfg.runtime !== RUNTIME) {
    const prev = cfg.runtime;
    cfg.runtime = RUNTIME;
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    console.log(`[fix-vercel-runtime] ${d}: ${prev} → ${RUNTIME}`);
    patched++;
  }
}
console.log(`[fix-vercel-runtime] Patched ${patched} function(s) to ${RUNTIME}`);
