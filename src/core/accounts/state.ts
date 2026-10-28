import path from 'node:path';
import { z } from 'zod';
import { readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';
import { withLock } from '../../infrastructure/filesystem/lock.js';

/**
 * Account availability marks (`<data dir>/accounts-state.json`).
 *
 * Provider quotas are usually not queryable, so availability is a mark: set
 * by the user ("this account is out of credits until 18:00") or by the
 * conductor when an agent's terminal shows a usage-limit message. Marks are
 * informative: they are shown in plans and in the dashboard, and the user
 * decides whether to switch. Accounts are never rotated automatically.
 */

const markSchema = z.object({
  status: z.enum(['limited']),
  since: z.string(),
  until: z.string().nullable().default(null),
  note: z.string().default(''),
  source: z.enum(['user', 'detected']).default('user'),
});

const fileSchema = z.object({ version: z.literal(1), accounts: z.record(z.string(), markSchema) });

export type AccountMark = z.infer<typeof markSchema>;

export class AccountMarks {
  readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'accounts-state.json');
  }

  async load(now: Date = new Date()): Promise<Record<string, AccountMark>> {
    const text = await readTextIfExists(this.file);
    if (!text) return {};
    try {
      const all = fileSchema.parse(JSON.parse(text)).accounts;
      // Expired marks no longer apply.
      return Object.fromEntries(Object.entries(all).filter(([, m]) => !m.until || new Date(m.until).getTime() > now.getTime()));
    } catch {
      return {};
    }
  }

  private async write(fn: (marks: Record<string, AccountMark>) => void): Promise<void> {
    await withLock(`${this.file}.lock`, { purpose: 'account marks', waitMs: 5000, resource: 'Account marks' }, async () => {
      const marks = await this.load();
      fn(marks);
      await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, accounts: marks }, null, 2)}\n`);
    });
  }

  async markLimited(name: string, options: { note?: string; until?: Date | null; source?: 'user' | 'detected' } = {}): Promise<void> {
    await this.write((marks) => {
      // A user's explicit mark is never overwritten by a detection.
      if (options.source === 'detected' && marks[name]?.source === 'user') return;
      marks[name] = {
        status: 'limited',
        since: new Date().toISOString(),
        until: options.until ? options.until.toISOString() : null,
        note: options.note ?? '',
        source: options.source ?? 'user',
      };
    });
  }

  async clear(name: string): Promise<void> {
    await this.write((marks) => {
      delete marks[name];
    });
  }
}

/** Parse "18:00", "2h", "30m" or an ISO date into a Date (null when empty or invalid). */
export function parseUntil(text: string | undefined, now: Date = new Date()): Date | null {
  const value = text?.trim();
  if (!value) return null;
  const rel = /^(\d+)\s*(m|min|h|d)$/i.exec(value);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? 'm').toLowerCase();
    const ms = unit.startsWith('m') ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return new Date(now.getTime() + ms);
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Usage-limit messages of the agent CLIs (detected in the agent's terminal). */
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit(ed)? (reached|exceeded)/i,
  /you'?ve (hit|reached) your (usage )?limit/i,
  /limit (will )?reset(s)? (at|in)/i,
  /out of credits/i,
  /quota exceeded/i,
];

export function detectUsageLimit(text: string): string | null {
  const lines = text.split('\n').slice(-40);
  for (const line of lines.reverse()) {
    if (LIMIT_PATTERNS.some((p) => p.test(line))) return line.trim().slice(0, 200);
  }
  return null;
}
