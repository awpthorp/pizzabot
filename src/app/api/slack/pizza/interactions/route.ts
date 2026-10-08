import { createHash } from "node:crypto";
import { after } from "next/server";
import {
  signedRequest,
  sameWorkspace,
  uuid,
  responseUrl,
} from "@/lib/pizza/security";
import { store, Refusal } from "@/lib/pizza/store";
import { slack } from "@/lib/pizza/slack";
import { eligible } from "@/lib/pizza/policy";
import { confirmationModal, rewardModal } from "@/lib/pizza/blocks";
import { isTier } from "@/lib/pizza/rewards";
import { drain } from "@/lib/pizza/worker";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const started = Date.now();
  const verified = await signedRequest(request);
  if (verified instanceof Response) return verified;
  const { raw, c } = verified;
  let body;
  try {
    body = JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
  } catch {
    return new Response("Malformed payload", { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    !sameWorkspace(body.team?.id, body.api_app_id, c) ||
    typeof body.user?.id !== "string" ||
    !/^[UW][A-Z0-9]+$/.test(body.user.id)
  )
    return new Response("Wrong workspace/app/actor", { status: 403 });
  if (!c.enabled) return new Response("PizzaBot disabled", { status: 503 });
  const user = body.user.id,
    s = store(),
    api = slack(c),
    channel = body.channel?.id ?? c.recognitionChannel;
  const enqueue = async (kind: string, payload: Record<string, unknown>) => {
    await s.enqueue(
      c.team,
      `interaction:${createHash("sha256")
        .update(
          body.type === "view_submission"
            ? `${body.view?.id}:${body.view?.callback_id}`
            : raw,
        )
        .digest("hex")}`,
      kind,
      { ...payload, user, channel },
    );
    after(async () => {
      try {
        await drain(s, api, c, 5);
      } catch {
        console.error("pizza_worker_unavailable");
      }
    });
  };
  try {
    if (body.type === "block_actions") {
      const action = body.actions?.[0];
      if (!action || typeof action.action_id !== "string")
        return new Response("Malformed action", { status: 400 });
      if (
        [
          "pizza_redeem",
          "pizza_add",
          "pizza_add_small",
          "pizza_add_medium",
          "pizza_add_large",
          "pizza_edit",
        ].includes(action.action_id)
      ) {
        if (typeof body.trigger_id !== "string" || !body.trigger_id)
          return new Response("Missing trigger", { status: 400 });
        const identity = await api.identity(user);
        if (!eligible(identity, c))
          throw new Refusal("Only eligible staff can use PizzaBot.");
        if (action.action_id === "pizza_redeem") {
          if (!uuid(action.value))
            return new Response("Invalid reward", { status: 400 });
          const intent = await s.intent(c.team, user, action.value);
          if (Date.now() - started > 1800)
            throw new Refusal(
              "Please click again; confirmation took too long to open.",
            );
          await api.modal(
            body.trigger_id,
            confirmationModal(intent.id, intent.reward, intent.balance),
          );
        } else {
          if (!c.admins.includes(user))
            return new Response("Admins only", { status: 403 });
          const reward =
            action.action_id === "pizza_edit" && uuid(action.value)
              ? await s.reward(c.team, action.value)
              : null;
          if (action.action_id === "pizza_edit" && !reward)
            throw new Refusal("Unknown reward.");
          if (Date.now() - started > 1800)
            throw new Refusal(
              "Please click again; the catalogue took too long to open.",
            );
          const preset = action.action_id.slice("pizza_add_".length);
          await api.modal(
            body.trigger_id,
            rewardModal(
              reward ?? undefined,
              isTier(preset) ? preset : undefined,
            ),
          );
        }
        return new Response(null, { status: 200 });
      }
      if (["pizza_goal", "pizza_goal_clear"].includes(action.action_id)) {
        if (action.action_id === "pizza_goal" && !uuid(action.value))
          return new Response("Invalid reward", { status: 400 });
        const url = responseUrl(body.response_url);
        await enqueue("goal", {
          reward: action.action_id === "pizza_goal_clear" ? null : action.value,
          ...(url
            ? { responseUrl: url, responseExpires: Date.now() + 25 * 60_000 }
            : {}),
        });
        return new Response(null, { status: 200 });
      }
      if (
        [
          "pizza_fulfill",
          "pizza_cancel",
          "pizza_archive",
          "pizza_activate",
        ].includes(action.action_id)
      ) {
        if (!c.admins.includes(user))
          return new Response("Admins only", { status: 403 });
        if (!uuid(action.value))
          return new Response("Invalid ID", { status: 400 });
        if (
          action.action_id === "pizza_archive" ||
          action.action_id === "pizza_activate"
        )
          await enqueue("catalogue", {
            reward: action.value,
            action: "archive",
            active: action.action_id === "pizza_activate",
          });
        else
          await enqueue("admin_action", {
            request: action.value,
            action: action.action_id === "pizza_cancel" ? "cancel" : "fulfill",
          });
        return new Response(null, { status: 200 });
      }
      return new Response("Unknown action", { status: 400 });
    }
    if (body.type === "view_submission") {
      if (typeof body.view?.id !== "string")
        return new Response("Missing view", { status: 400 });
      const view = body.view;
      if (view.callback_id === "pizza_confirm") {
        if (
          !uuid(view.private_metadata) ||
          !(await s.checkIntent(c.team, user, view.private_metadata))
        )
          return new Response("Invalid confirmation", { status: 403 });
        await enqueue("redeem", { intent: view.private_metadata });
        return Response.json({ response_action: "clear" });
      }
      if (view.callback_id === "pizza_catalogue") {
        if (!c.admins.includes(user))
          return new Response("Admins only", { status: 403 });
        if (view.private_metadata !== "new" && !uuid(view.private_metadata))
          return new Response("Invalid reward", { status: 400 });
        const values = view.state?.values,
          get = (id: string) => values?.[id]?.value?.value ?? "",
          name = get("name"),
          costText = get("cost"),
          description = get("description"),
          stockText = get("stock"),
          selectedTier =
            values?.tier?.value?.selected_option?.value ?? "custom",
          tier = selectedTier === "custom" ? null : selectedTier;
        const errors: Record<string, string> = {};
        if (tier !== null && !isTier(tier))
          errors.tier = "Choose Small, Medium, Large or Custom.";
        if (typeof name !== "string" || !name.trim() || name.length > 100)
          errors.name = "Enter a name up to 100 characters.";
        if (!/^[1-9]\d{0,6}$/.test(costText) || Number(costText) > 1000000)
          errors.cost = "Enter a positive integer up to 1000000.";
        if (typeof description !== "string" || description.length > 2000)
          errors.description = "Use up to 2000 characters.";
        if (
          stockText !== "" &&
          (!/^\d{1,7}$/.test(stockText) || Number(stockText) > 1000000)
        )
          errors.stock =
            "Leave blank or enter a nonnegative integer up to 1000000.";
        if (Object.keys(errors).length)
          return Response.json({ response_action: "errors", errors });
        await enqueue("catalogue", {
          reward: view.private_metadata,
          tier,
          name,
          cost: Number(costText),
          description,
          stock: stockText === "" ? null : Number(stockText),
        });
        return Response.json({ response_action: "clear" });
      }
    }
    if (body.type === "view_closed") return new Response(null, { status: 200 });
    return new Response("Unknown interaction", { status: 400 });
  } catch (e) {
    if (e instanceof Refusal) {
      try {
        await s.interactionFeedback(
          c.team,
          `refusal:${createHash("sha256").update(raw).digest("hex")}`,
          user,
          channel,
          responseUrl(body.response_url),
          e.message,
        );
        after(async () => {
          try {
            await drain(s, api, c, 5);
          } catch {
            console.error("pizza_worker_unavailable");
          }
        });
        return new Response(null, { status: 200 });
      } catch {
        return new Response("Feedback persistence unavailable; retry", {
          status: 503,
        });
      }
    }
    return new Response("Operation unavailable; retry", { status: 503 });
  }
}
