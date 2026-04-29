import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, '../assets/y2kase.css'), 'utf8');
const escapedCss = JSON.stringify(css);

const jsContent = `(function(){
  if (document.getElementById('y2kase-inject')) return;
  var s = document.createElement('style');
  s.id = 'y2kase-inject';
  s.textContent = ${escapedCss};
  document.head.appendChild(s);
  // Also load Google Fonts if not already loaded
  if (!document.querySelector('link[href*="Fredoka"]')) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Fredoka+One&family=Nunito:wght@400;600;700;800&display=swap';
    document.head.appendChild(l);
  }
})();`;

// Deno edge function that serves this JS
const edgeFn = `import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const JS_CONTENT = ${JSON.stringify(jsContent)};

Deno.serve(async (_req: Request) => {
  return new Response(JS_CONTENT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=1800",
    },
  });
});
`;

writeFileSync(resolve(__dirname, '../scripts/y2kase-styles-fn.ts'), edgeFn);
console.log('Edge function written:', edgeFn.length, 'chars');
console.log('JS payload:', jsContent.length, 'chars');
