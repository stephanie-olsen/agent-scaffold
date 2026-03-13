// regen-memory.mjs — Regenerate MEMORY.md from graph boot context + dynamic stats
// Run at session start or heartbeat to keep MEMORY.md fresh.
import { MemoryGraph } from '../../lib/graph-memory/index.mjs';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

const workDir = resolve(import.meta.dirname, '../..');
const dbPath = resolve(workDir, 'data', 'memory-graph.sqlite');
const outPath = resolve(workDir, 'MEMORY.md');

// Generate dynamic workspace stats
function getStats() {
  const lines = [];
  try {
    const total = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM nodes WHERE weight > 0.1;"`, { encoding: 'utf-8', timeout: 3000 }).trim();
    const recent = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM nodes WHERE created_at > (strftime('%s','now','-24 hours') * 1000);"`, { encoding: 'utf-8', timeout: 3000 }).trim();
    lines.push(`- **Graph:** ${total} active nodes, ${recent} added in last 24h`);
  } catch {}
  try {
    const queuePath = resolve(workDir, 'data/exploration-queue.json');
    if (existsSync(queuePath)) {
      const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
      lines.push(`- **Exploration queue:** ${queue.items?.length ?? 0} items`);
    }
  } catch {}
  try {
    const outboxPath = resolve(workDir, 'for-steph/homepage/outbox.json');
    if (existsSync(outboxPath)) {
      const outbox = JSON.parse(readFileSync(outboxPath, 'utf-8'));
      if (outbox.length > 0) lines.push(`- **Outbox:** ${outbox.length} item(s) to share with Steph`);
    }
  } catch {}
  try {
    const thinkingDir = resolve(workDir, 'thinking');
    if (existsSync(thinkingDir)) {
      const threads = readdirSync(thinkingDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
      if (threads.length > 0) lines.push(`- **Active threads:** ${threads.map(f => f.replace('.md', '')).join(', ')}`);
    }
  } catch {}
  return lines.length > 0 ? `## Workspace State\n${lines.join('\n')}\n` : '';
}

const mem = new MemoryGraph(dbPath);
const boot = mem.bootContext();
const stats = getStats();
const header = `# MEMORY.md — Auto-generated from graph memory
# Do not edit manually — changes will be overwritten on next regeneration.
# To update memory, use the graph: lib/graph-memory/
# Backup: MEMORY.md.bak | Database: data/memory-graph.sqlite
# Last regenerated: ${new Date().toISOString()}

${stats}
`;
writeFileSync(outPath, header + boot);
console.log(`Wrote ${outPath} (${(header + boot).length} chars)`);
mem.close();
