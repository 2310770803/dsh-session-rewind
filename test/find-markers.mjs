// Search decompressed session logs for a needle and print the sessions + events.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const NEEDLE = process.argv[2] ?? 'session-rewind';
const ROOT = 'C:/Users/23107/.dsh/sessions';

const hits = [];
for (const workspace of readdirSync(ROOT)) {
  const workspaceDir = join(ROOT, workspace);
  if (!statSync(workspaceDir).isDirectory()) continue;
  for (const session of readdirSync(workspaceDir)) {
    const sessionDir = join(workspaceDir, session);
    if (!statSync(sessionDir).isDirectory()) continue;
    const file = join(sessionDir, 'session.v4.jsonl.zstd');
    let text;
    try {
      text = zstdDecompressSync(readFileSync(file)).toString('utf8');
    } catch {
      continue;
    }
    if (!text.includes(NEEDLE)) continue;
    const lines = text.split('\n').filter((line) => line !== '');
    const marked = lines.filter((line) => line.includes(NEEDLE));
    hits.push({
      session,
      modified: statSync(file).mtime.toISOString(),
      events: lines.length,
      marked: marked.length,
      samples: marked.slice(-2).map((line) => line.slice(0, 260)),
    });
  }
}

hits.sort((a, b) => (a.modified < b.modified ? 1 : -1));
console.log(`sessions containing ${JSON.stringify(NEEDLE)}: ${hits.length}`);
for (const hit of hits.slice(0, 6)) {
  console.log(`\n=== ${hit.session}`);
  console.log(`modified: ${hit.modified}  events: ${hit.events}  marked: ${hit.marked}`);
  for (const sample of hit.samples) console.log(`  ${sample}`);
}
