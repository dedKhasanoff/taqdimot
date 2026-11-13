# vendor/ — eski brauzerlar (smart TV) uchun kutubxonalar

Sayt yangi brauzerlarda kutubxonalarni CDN'dan oladi. Eski brauzer (taxminan Chrome 64–93,
ko'p Samsung Tizen / LG webOS televizorlar) aniqlansa, `index.html` va `pdf.html` shu papkadagi
fayllarni yuklaydi. Aniqlash: brauzer `??=`, `?.`, private class field va static block'ni tushunmasa.

| Fayl | Manba | Qanday yig'ilgan |
|---|---|---|
| `compat.js` | core-js 3.39.0 + AbortController stub | `esbuild compat-entry.js --bundle --format=iife --target=chrome53 --minify` |
| `supabase.legacy.js` | @supabase/supabase-js 2.93.3 | `esbuild entry.js --bundle --format=iife --global-name=supabase --target=chrome63 --minify` (`entry.js`: `export * from '@supabase/supabase-js'`) |
| `pdf.legacy.min.js` | pdfjs-dist 3.11.174 `legacy/build/pdf.min.js` | `esbuild ... --target=chrome63 --minify` |
| `pdf.legacy.worker.min.js` | pdfjs-dist 3.11.174 `legacy/build/pdf.worker.min.js` | `esbuild ... --target=chrome63 --minify` |

`compat.js` polyfill'lari: globalThis, Object.fromEntries / hasOwn, Array flat / flatMap / at,
String replaceAll / at / trimStart / trimEnd, Promise allSettled / finally, structuredClone.

Kutubxona versiyasi o'zgarsa (index.html'dagi CDN havolasi), bu fayllarni ham shu buyruqlar bilan qayta yig'ing.
Sinash: `https://taqdimo.netlify.app/?legacy=1` eski yo'lni, `?tv=1` televizor rejimini yoqadi (`?tv=0` o'chiradi).
