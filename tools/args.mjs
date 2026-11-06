// tools/args.mjs — shared command-line parsing for the data tools. Every build/fetch tool accepts the same optional
// extent and output selectors on top of its positional arguments, defaulting to exactly the city-frame behaviour:
//   --extent minE,minN,maxE,maxN   LV95 extent to work on instead of the world frame (js/geneva-frame.js FRAME.lv95)
//   --out <path>                   output file (build tools; the fetch tools write their JSON cache instead)
//   --cache-suffix <dir>           sub-directory of tools/data/cache/ for the fetched JSON (the canton tiles use
//                                  "canton/<E>-<N>"); empty (the default) keeps today's flat cache file names
//   --trees <path>                 trees JSON for the ortho tree removal (default tools/data/cache/geneva_trees.json)
//   --download                     (ortho) re-fetch the raw mosaic instead of reusing the cached one
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(DIR, 'data', 'cache');

export function parseArgs(argv) {
  const a = { extent: null, out: null, cacheSuffix: null, trees: null, download: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--extent') a.extent = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--cache-suffix') a.cacheSuffix = argv[++i];
    else if (v === '--trees') a.trees = argv[++i];
    else if (v === '--download') a.download = true;
    else a.positional.push(v);
  }
  return a;
}

// '--extent minE,minN,maxE,maxN' -> [minE, minN, maxE, maxN] (LV95), or null
export function parseExtent(s) {
  if (s == null) return null;
  const e = s.split(',').map(Number);
  if (e.length !== 4 || e.some((v) => !Number.isFinite(v))) throw new Error(`bad --extent: ${s}`);
  return e;
}

// The JSON cache file for a SITG layer, under CACHE (or CACHE/<cacheSuffix>/ when one is given)
export function cacheFile(cacheSuffix, name) {
  return cacheSuffix ? path.join(CACHE, cacheSuffix, name) : path.join(CACHE, name);
}
