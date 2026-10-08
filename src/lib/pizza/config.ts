export const TIMEZONE = "Asia/Dubai";
export const DAILY_LIMIT = 5;
export type PizzaConfig = {
  enabled: boolean;
  token: string;
  signingSecret: string;
  team: string;
  app: string;
  recognitionChannel: string;
  adminChannel: string;
  admins: string[];
  participants: string[];
  workerSecret: string;
};
export function config(
  env: Record<string, string | undefined> = process.env,
): PizzaConfig | null {
  const ids = (key: string) =>
    (env[key] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const c = {
    enabled: env.PIZZA_ENABLED === "true",
    token: env.PIZZA_BOT_TOKEN ?? "",
    signingSecret: env.PIZZA_SIGNING_SECRET ?? "",
    team: env.PIZZA_TEAM_ID ?? "",
    app: env.PIZZA_APP_ID ?? "",
    recognitionChannel: env.PIZZA_RECOGNITION_CHANNEL_ID ?? "",
    adminChannel: env.PIZZA_ADMIN_CHANNEL_ID ?? "",
    admins: ids("PIZZA_ADMIN_USER_IDS"),
    participants: ids("PIZZA_PARTICIPANT_USER_IDS"),
    workerSecret: env.PIZZA_WORKER_SECRET ?? "",
  };
  if (
    !c.token.startsWith("xoxb-") ||
    c.signingSecret.length < 16 ||
    c.workerSecret.length < 32 ||
    c.workerSecret === c.signingSecret ||
    !/^T[A-Z0-9]+$/.test(c.team) ||
    !/^A[A-Z0-9]+$/.test(c.app) ||
    !/^C[A-Z0-9]+$/.test(c.recognitionChannel) ||
    !/^[CG][A-Z0-9]+$/.test(c.adminChannel) ||
    !c.admins.length ||
    ![...c.admins, ...c.participants].every((s) => /^[UW][A-Z0-9]+$/.test(s))
  )
    return null;
  return c;
}
