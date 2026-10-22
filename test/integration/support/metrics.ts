/** Texto de `/metrics` da aplicação em `baseUrl`. */
export async function scrapeMetrics(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/metrics`);
  if (res.status !== 200) throw new Error(`/metrics answered ${res.status}`);
  return res.text();
}

/** Valor da série (nome e rótulos exatamente como expostos); 0 se ela ainda não existe. */
export function seriesValue(text: string, series: string): number {
  const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped} (\\S+)$`, 'm'));
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** Quanto a série cresceu entre a leitura de antes e a de agora. */
export async function seriesDelta(
  baseUrl: string,
  series: string,
  action: () => Promise<unknown>,
): Promise<number> {
  const before = seriesValue(await scrapeMetrics(baseUrl), series);
  await action();
  return seriesValue(await scrapeMetrics(baseUrl), series) - before;
}
