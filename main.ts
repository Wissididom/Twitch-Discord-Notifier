import { Hono } from "hono";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { auth, authCallback } from "./auth.ts";
import Config from "./config.json" with { type: "json" };

const app = new Hono();

// Notification request headers
const TWITCH_MESSAGE_ID = "Twitch-Eventsub-Message-Id".toLowerCase();
const TWITCH_MESSAGE_TIMESTAMP = "Twitch-Eventsub-Message-Timestamp"
  .toLowerCase();
const TWITCH_MESSAGE_SIGNATURE = "Twitch-Eventsub-Message-Signature"
  .toLowerCase();
const MESSAGE_TYPE = "Twitch-Eventsub-Message-Type".toLowerCase();

// Notification message types
const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

// Prepend this string to the HMAC that's created from the message
const HMAC_PREFIX = "sha256=";

function findConfigForChannel(channelId: string) {
  return Config.find((c) => c.channel == channelId);
}

function findEventsForConfig(cfg: typeof Config, event: string) {
  if (!cfg || !cfg.events) {
    return null;
  }
  return cfg.events.filter((e) => e.event == event);
}

function buildWebhookUrl(webhookUrl: string, threadId: string | null) {
  if (threadId) {
    return `${webhookUrl}?wait=true&thread_id=${threadId}`;
  } else {
    return `${webhookUrl}?wait=true`;
  }
}

async function executeDiscordWebhook(
  discordPayload: string,
  webhookUrl: string,
  threadId: string | null,
) {
  const discordResponse = await fetch(buildWebhookUrl(webhookUrl, threadId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: discordPayload,
  }).then((res) => res.text());
  console.log(JSON.stringify(discordResponse, null, 4));
}

app.get("/", (c) => {
  return c.text("Twitch Unban Requests EventSub Webhook Endpoint");
});

app.get("/auth", (c) => {
  if (
    !Deno.env.has("TWITCH_CLIENT_ID") || !Deno.env.has("TWITCH_CLIENT_SECRET")
  ) {
    return c.text("TWITCH_CLIENT_ID and/or TWITCH_CLIENT_SECRET not set!");
  }
  auth(
    c,
    Deno.env.get("TWITCH_CLIENT_ID"),
    Deno.env.get("TWITCH_CLIENT_REDIRECT_URI"),
    false,
  );
});

app.get("/auth-callback", authCallback);

app.post("/", async (c) => {
  const secret = Deno.env.get("EVENTSUB_SECRET");
  const message = c.req.header(TWITCH_MESSAGE_ID) +
    c.req.header(TWITCH_MESSAGE_TIMESTAMP) + await c.req.raw.clone().text();
  const hmac = HMAC_PREFIX +
    crypto.createHmac("sha256", secret).update(message).digest("hex");
  if (verifyMessage(hmac, c.req.header(TWITCH_MESSAGE_SIGNATURE))) {
    // Get JSON object from body, so you can process the message.
    const notification = await c.req.json();
    switch (c.req.header(MESSAGE_TYPE)) {
      case MESSAGE_TYPE_NOTIFICATION:
        if (!notification.subscription?.type) {
          console.warn("subscription type not available: ", notification);
          return c.text(
            "This seems like an invalid payload. There is no subscription type for check for.",
          );
        }
        if (
          notification.subscription.type == "channel.unban_request.create"
        ) {
          const cfg = findConfigForChannel(
            notification.event.broadcaster_user_id,
          );
          const events = cfg
            ? findEventsForConfig(cfg, notification.subscription.type)
            : null;
          if (!events) {
            return c.text(
              "Event not configured to be sent to discord. Skipping event.",
            );
          }
          for (const event of events) {
            const fields: { name: string; value: string; inline: boolean }[] =
              [];
            if (!event.hideBroadcaster) {
              fields.push({
                name: "Broadcaster",
                value:
                  `[\`${notification.event.broadcaster_user_name}\` (\`${notification.event.broadcaster_user_login}\` - \`${notification.event.broadcaster_user_id}\`)](<https://www.twitch.tv/${notification.event.broadcaster_user_login}>)`,
                inline: false,
              });
            }
            fields.push({
              name: "User",
              value:
                `[\`${notification.event.user_name}\` (\`${notification.event.user_login}\` - \`${notification.event.user_id}\`)](<https://www.twitch.tv/${notification.event.user_login}>)`,
              inline: false,
            });
            fields.push({
              name: "Created at",
              value: `<t:${
                Math.floor(Date.parse(notification.event.created_at) / 1000)
              }:F>`,
              inline: false,
            });
            const discordPayload = {
              embeds: [
                {
                  color: 0xcc3333, // red
                  title: notification.event.id
                    ? `New Unban Request (${notification.event.id}) created`
                    : "New Unban Request created",
                  fields,
                  description: `\`\`\`${notification.event.text}\`\`\``,
                },
              ],
            };
            await executeDiscordWebhook(
              JSON.stringify(discordPayload),
              event.webhook,
              event.threadId,
            );
          }
        } else if (
          notification.subscription.type == "channel.unban_request.resolve"
        ) {
          const cfg = findConfigForChannel(
            notification.event.broadcaster_user_id,
          );
          const events = cfg
            ? findEventsForConfig(cfg, notification.subscription.type)
            : null;
          if (!events) {
            return c.text(
              "Event not configured to be sent to discord. Skipping event.",
            );
          }
          if (!notification.event.status) {
            return c.text(null, 204);
          }
          let color = null;
          switch (notification.event.status) {
            case "approved":
              color = 0xaaff00; // green
              break;
            case "denied":
              color = 0xcc3333; // red
              break;
            case "canceled":
            default:
              color = 0x808080; // gray
              break;
          }
          for (const event of events) {
            const fields: { name: string; value: string; inline: boolean }[] =
              [];
            if (!event.hideBroadcaster) {
              fields.push({
                name: "Broadcaster",
                value:
                  `[\`${notification.event.broadcaster_user_name}\` (\`${notification.event.broadcaster_user_login}\` - \`${notification.event.broadcaster_user_id}\`)](<https://www.twitch.tv/${notification.event.broadcaster_user_login}>)`,
                inline: false,
              });
            }
            fields.push({
              name: "Moderator",
              value:
                `[\`${notification.event.moderator_user_name}\` (\`${notification.event.moderator_user_login}\` - \`${notification.event.moderator_user_id}\`)](<https://www.twitch.tv/${notification.event.moderator_user_login}>)`,
              inline: false,
            });
            fields.push({
              name: "User",
              value:
                `[\`${notification.event.user_name}\` (\`${notification.event.user_login}\` - \`${notification.event.user_id}\`)](<https://www.twitch.tv/${notification.event.user_login}>)`,
              inline: false,
            });
            const discordPayload = {
              embeds: [
                {
                  color,
                  title: notification.event.id
                    ? `Unban Request ${notification.event.id} ${notification.event.status}`
                    : `Unban Request ${notification.event.status}`,
                  fields,
                  description:
                    `**Status: \`${notification.event.status}\`**\n**Resolution Text:**\n\`\`\`${notification.event.resolution_text}\`\`\``,
                },
              ],
            };
            await executeDiscordWebhook(
              JSON.stringify(discordPayload),
              event.webhook,
              event.threadId,
            );
          }
        } else {
          console.log(
            `Event type: ${notification.subscription.type}; Matched events: ${
              JSON.stringify(events)
            }`,
          );
          console.log(JSON.stringify(notification.event, null, 4));
        }
        return c.text(null, 204);
      case MESSAGE_TYPE_VERIFICATION:
        return c.body(notification.challenge, 200, {
          "Content-Type": "text/plain",
        });
      case MESSAGE_TYPE_REVOCATION:
        console.log(`${notification.subscription.type} notifications revoked!`);
        console.log(`reason: ${notification.subscription.status}`);
        console.log(
          `condition: ${
            JSON.stringify(notification.subscription.condition, null, 4)
          }`,
        );
        return c.text(null, 204);
      default:
        console.log(`Unknown message type: ${req.headers[MESSAGE_TYPE]}`);
        return c.text(null, 204);
    }
  } else {
    console.log("403 - Signatures didn't match.");
    return c.text("Forbidden", 403);
  }
});

function verifyMessage(hmac, verifySignature) {
  return crypto.timingSafeEqual(
    Buffer.from(hmac),
    Buffer.from(verifySignature),
  );
}

const port = parseInt(Deno.env.get("PORT") || "3000");

Deno.serve({ port }, app.fetch);
