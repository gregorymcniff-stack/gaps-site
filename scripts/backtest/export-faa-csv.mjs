// Export the downloaded FAA ATCSCC advisory lists as one CSV for open data.
// Usage: node export-faa-csv.mjs faa-adv.json ../../public/data/faa-advisories.csv
import fs from 'node:fs';
const [inPath, outPath] = process.argv.slice(2);
const faa = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const NEW_PROGRAM = /GROUND STOP|GROUND DELAY PROGRAM/, NOT_NEW = /CNX|CANCEL|PROPOSED|REVIS|EXTEN|COMPRESS|UPDATE|AMEND|MODIF/;
const isUS = fac => { const ap = fac.split('/')[0].trim(); return /^[A-Z0-9]{3}$/.test(ap) || /^K[A-Z]{3}$/.test(ap); };
const cell = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const lines = ['advisory_date,advisory_number,facility,airport,title,sent_utc,counted_as_new_us_program,program_type'];
for (const day of Object.keys(faa).sort()) for (const r of faa[day]) {
  const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(r.sent);
  const sent = m ? new Date(Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5])).toISOString() : '';
  const title = r.title.toUpperCase(), counted = NEW_PROGRAM.test(title) && !NOT_NEW.test(title) && isUS(r.facility);
  lines.push([day, r.n, r.facility, r.facility.split('/')[0].trim(), r.title, sent, counted ? 1 : 0, counted ? (/GROUND STOP/.test(title) ? 'GS' : 'GDP') : ''].map(cell).join(','));
}
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(lines.length - 1, 'advisories,', lines.filter(l => /,1,(GS|GDP)$/.test(l)).length, 'counted as new US programs');
