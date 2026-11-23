export function clockState(now = new Date()) {
  const date = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return { h: now.getHours(), m: now.getMinutes(), date };
}
