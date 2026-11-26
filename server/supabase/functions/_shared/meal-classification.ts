/** Only explicit source headings classify a post; menu names and image contents are not inferred. */
export function mealHeading(title: string | null, body: string): string {
  return title?.trim() || body.split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

export function classifyMeal(title: string | null, body: string, pinned: boolean, reference: number) {
  const heading = mealHeading(title, body);
  const weekly = /식단\s*표|주간\s*(?:식단|메뉴)/.test(heading);
  const lunch = /중식/.test(heading), dinner = /석식/.test(heading);
  const daily = !weekly && lunch !== dinner && /(?:중식|석식)\s*메[뉴누]/.test(heading);
  const category = weekly ? "WEEKLY_MENU" : daily ? "DAILY_MENU" : "OTHER";
  const mealPeriod = daily ? lunch ? "LUNCH" : "DINNER" : null;
  const match = daily ? heading.match(/(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/) : null;
  let mealDate: string | null = null;
  if (match && Number.isFinite(reference)) {
    const year = new Date(reference + 9 * 3600000).getUTCFullYear();
    const years = match[1] ? [Number(match[1])] : [year - 1, year, year + 1];
    const month = Number(match[2]), day = Number(match[3]);
    const candidates = years.filter((y) => y >= 2000 && y <= 9999).map((y) =>
      new Date(Date.UTC(y, month - 1, day))
    )
      .filter((d) => d.getUTCMonth() === month - 1 && d.getUTCDate() === day)
      .sort((a, b) => Math.abs(a.getTime() - reference) - Math.abs(b.getTime() - reference));
    mealDate = candidates[0]?.toISOString().slice(0, 10) ?? null;
  }
  return {
    category,
    mealPeriod,
    mealDate,
    kind: daily ? "DAILY_MENU" : weekly && pinned ? "PINNED_MENU" : "OTHER",
  };
}
