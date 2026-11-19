// Paris local time for any date (history.ts only knows 2026's clock changes),
// and a small seeded random source per key, so a day always gets the same values.

import { mulberry32, normalFrom } from './history.ts';

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Paris offset from UTC in ms at an instant. */
export function parisOffsetMs(ms: number) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Paris local date (YYYY-MM-DD) of an instant. */
export function parisDate(ms: number) {
  return new Date(ms + parisOffsetMs(ms)).toISOString().slice(0, 10);
}

/** UTC instant of a Paris wall-clock time: a date plus minutes after local midnight. */
export function parisTime(date: string, minutes: number) {
  const wall = Date.parse(`${date}T00:00:00Z`) + Math.round(minutes * 60_000);
  const guess = wall - parisOffsetMs(wall);
  return wall - parisOffsetMs(guess);
}

export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** All dates from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** FNV-1a: a stable 32-bit seed from a key such as "sleep:2026-11-20". */
function seedOf(key: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic uniform and normal random source for one key. */
export function randomFor(key: string) {
  const rand = mulberry32(seedOf(key));
  return { rand, normal: normalFrom(rand) };
}

export const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));
