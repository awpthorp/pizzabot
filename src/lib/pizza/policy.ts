import { DAILY_LIMIT, TIMEZONE, type PizzaConfig } from "./config";
export function localDay(ts: string | number = Date.now() / 1000): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(ts) * 1000));
}
export type Identity = {
  id: string;
  team_id?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  name?: string;
  profile?: { display_name?: string; real_name?: string };
};
export function eligible(user: Identity, c: PizzaConfig): boolean {
  return (
    /^[UW][A-Z0-9]+$/.test(user.id) &&
    user.team_id === c.team &&
    !user.is_bot &&
    !user.is_app_user &&
    !user.deleted &&
    !user.is_restricted &&
    !user.is_ultra_restricted &&
    !user.is_stranger &&
    (!c.participants.length || c.participants.includes(user.id))
  );
}
export function rejection(
  giver: string,
  recipients: string[],
  total: number,
  used: number,
  identities: Identity[],
  c: PizzaConfig,
): string | null {
  if (recipients.includes(giver)) return "You cannot give pizzas to yourself.";
  if (
    !identities.every((u) => eligible(u, c)) ||
    identities.length !== new Set([giver, ...recipients]).size
  )
    return "Everyone must be an eligible workspace member.";
  if (total > DAILY_LIMIT - used)
    return `That needs ${total} pizzas. You have ${DAILY_LIMIT - used} left for this message's Dubai day.`;
  return null;
}
