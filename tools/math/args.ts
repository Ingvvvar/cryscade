/** Целочисленный флаг командной строки `--имя=значение`; подчёркивания в числе допустимы. */
export function option(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) return fallback;
  const value = Number(raw.replaceAll('_', ''));
  if (!Number.isFinite(value)) throw new RangeError(`--${name}: ${raw}`);
  return value;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
