export function completeOscSample(
  aliases: string[],
  values: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    aliases.map((alias) => [alias, Number.isFinite(values[alias]) ? values[alias] : 0]),
  );
}
