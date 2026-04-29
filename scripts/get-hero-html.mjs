const r = await fetch('https://y2kase.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
const html = await r.text();
const start = html.indexOf('class="hero');
if (start < 0) { console.log('Hero not found'); process.exit(); }
const chunk = html.slice(start, start + 3000).replace(/<script[\s\S]*?<\/script>/g, '');
console.log(chunk);
