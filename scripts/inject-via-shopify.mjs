/**
 * Uploads y2kase CSS as a JS injection file to Shopify's CDN,
 * then creates a Script Tag so it runs on every storefront page.
 * No write_themes needed — uses write_files + write_script_tags.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function readEnv() {
  let t = readFileSync(resolve(ROOT, '.env'), 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const env = {};
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return env;
}

const env   = readEnv();
const TOKEN = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOP  = env.SHOPIFY_SHOP;
const BASE  = `https://${SHOP}/admin/api/2025-04`;

const css = readFileSync(resolve(ROOT, 'assets/y2kase.css'), 'utf8');

const jsPayload = `(function(){
  if(document.getElementById('y2kase-inject'))return;
  var s=document.createElement('style');
  s.id='y2kase-inject';
  s.textContent=${JSON.stringify(css)};
  document.head.appendChild(s);
  if(!document.querySelector('link[href*="Fredoka"]')){
    var l=document.createElement('link');
    l.rel='stylesheet';
    l.href='https://fonts.googleapis.com/css2?family=Fredoka+One&family=Nunito:wght@400;600;700;800&display=swap';
    document.head.appendChild(l);
  }
})();`;

async function gql(query, variables = {}) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-04/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

// ── Step 1: Create a staged upload ──────────────────────────────────────────
console.log('Step 1: Creating staged upload on Shopify CDN...');
const stageRes = await gql(`
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`, {
  input: [{
    filename: 'y2kase-inject.js',
    mimeType: 'application/javascript',
    httpMethod: 'POST',
    resource: 'FILE',
    fileSize: String(Buffer.byteLength(jsPayload, 'utf8')),
  }],
});

if (stageRes.errors || stageRes.data?.stagedUploadsCreate?.userErrors?.length) {
  console.error('Stage upload failed:', JSON.stringify(stageRes).slice(0, 400));
  process.exit(1);
}

const target = stageRes.data.stagedUploadsCreate.stagedTargets[0];
console.log('  Got upload target:', target.url.slice(0, 60) + '...');
console.log('  Resource URL will be:', target.resourceUrl);

// ── Step 2: Upload the file ──────────────────────────────────────────────────
console.log('Step 2: Uploading JS to Shopify CDN...');
const formData = new FormData();
for (const param of target.parameters) {
  formData.append(param.name, param.value);
}
formData.append('file', new Blob([jsPayload], { type: 'application/javascript' }), 'y2kase-inject.js');

const uploadRes = await fetch(target.url, { method: 'POST', body: formData });
console.log('  Upload status:', uploadRes.status);
if (uploadRes.status >= 300 && uploadRes.status !== 204) {
  const txt = await uploadRes.text();
  console.error('  Upload failed:', txt.slice(0, 300));
  process.exit(1);
}

// ── Step 3: Register the file in Shopify ────────────────────────────────────
console.log('Step 3: Registering file in Shopify Files...');
const fileRes = await gql(`
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        ... on GenericFile { url }
        ... on MediaImage { image { url } }
      }
      userErrors { field message }
    }
  }
`, {
  files: [{
    contentType: 'FILE',
    originalSource: target.resourceUrl,
    filename: 'y2kase-inject.js',
  }],
});

if (fileRes.errors || fileRes.data?.fileCreate?.userErrors?.length) {
  console.error('File create failed:', JSON.stringify(fileRes).slice(0, 400));
  process.exit(1);
}

const createdFile = fileRes.data.fileCreate.files[0];
let fileUrl = createdFile?.url || target.resourceUrl;
console.log('  File registered:', createdFile?.id);
console.log('  URL:', fileUrl);

// Wait a moment for file processing
if (!fileUrl || createdFile?.fileStatus === 'PROCESSING') {
  console.log('  File still processing — using resourceUrl directly...');
  fileUrl = target.resourceUrl;
}

// ── Step 4: Remove any existing y2kase script tags ──────────────────────────
console.log('Step 4: Cleaning up old script tags...');
const existingTags = await fetch(`${BASE}/script_tags.json`, {
  headers: { 'X-Shopify-Access-Token': TOKEN },
}).then(r => r.json());

for (const tag of (existingTags.script_tags || [])) {
  if (tag.src.includes('y2kase') || tag.src.includes('splyrpabyvdzrrbveqjw')) {
    await fetch(`${BASE}/script_tags/${tag.id}.json`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': TOKEN },
    });
    console.log('  Deleted old tag:', tag.src.slice(0, 60));
  }
}

// ── Step 5: Create the Script Tag ───────────────────────────────────────────
console.log('Step 5: Creating Shopify Script Tag...');
const tagRes = await fetch(`${BASE}/script_tags.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    script_tag: {
      event: 'onload',
      src: fileUrl,
      display_scope: 'all',
    },
  }),
}).then(r => r.json());

if (tagRes.script_tag) {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ✅ SUCCESS! Script tag live on y2kase.com');
  console.log('  ID:', tagRes.script_tag.id);
  console.log('  URL:', tagRes.script_tag.src);
  console.log('\n  Your Y2K styles are now injected on every storefront page!');
  console.log('  Check https://y2kase.com — hard-refresh (Ctrl+Shift+R) to see changes.');
  console.log('══════════════════════════════════════════════════════════\n');
} else {
  console.error('Script tag creation failed:', JSON.stringify(tagRes).slice(0, 400));
}
