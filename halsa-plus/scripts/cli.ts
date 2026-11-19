// Small helpers for the command-line scripts.

/** Reads "--name value" pairs from the command line. */
export function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${key} needs a value.`);
    out[key.slice(2)] = value;
    i++;
  }
  return out;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
