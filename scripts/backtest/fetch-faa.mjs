// Download FAA ATCSCC advisory lists (ground stops and ground delay programs)
// for a date range from the public Advisory Database (fly.faa.gov).
// Usage: node fetch-faa.mjs 2026-07-16 2026-11-12 out.json
import fs from 'node:fs';
const [start, end, out] = process.argv.slice(2);
const cache = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
const strip = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d = new Date(d.getTime() + 86400000)) {
  const day = d.toISOString().slice(0, 10);
  if (cache[day]) continue;
  const url = `https://www.fly.faa.gov/adv/adv_list?whichAdvisories=ATCSCC&advisoryCategory=NotAll&date=${day}&gStop=true&_gStop=on&gDelay=true&_gDelay=on&_airflow=on&_ctop=on&_route=on&_other=on`;
  let html = null;
  for (let attempt = 0; attempt < 3 && !html; attempt++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (r.ok) html = await r.text(); else await new Promise(r2 => setTimeout(r2, 5000)); }
    catch { await new Promise(r2 => setTimeout(r2, 5000)); }
  }
  if (!html) { console.log(day, 'FAILED'); continue; }
  const rows = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(strip);
    if (cells.length >= 5 && /^\d{3}$/.test(cells[0])) rows.push({ n: cells[0], facility: cells[1], title: cells[3], sent: cells[4] });
  }
  cache[day] = rows;
  fs.writeFileSync(out, JSON.stringify(cache));
  console.log(day, rows.length);
  await new Promise(r => setTimeout(r, 1500));
}
