import { Client, Events, GatewayIntentBits, Partials, type TextBasedChannel } from "discord.js";

import { DiscordAgent } from "../agents/discord/discord-agent.js";
import { DiscordJsService } from "../modules/discord/infrastructure/discord-js-service.js";
import type { DiscordChannel } from "../modules/discord/ports/discord-service.js";

const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const discordService = new DiscordJsService();
const agents = new Map<string, Promise<DiscordAgent>>();

function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

function getAgent(channelId: string, channel: DiscordChannel): Promise<DiscordAgent> {
  const existing = agents.get(channelId);
  if (existing) return existing;

  const created = DiscordAgent.create(discordService, channel);
  agents.set(channelId, created);
  void created.catch(() => {
    if (agents.get(channelId) === created) {
      agents.delete(channelId);
    }
  });

  return created;
}

function isSendableChannel(channel: TextBasedChannel): boolean {
  return "send" in channel && typeof channel.send === "function";
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const botId = client.user?.id;
  if (!botId) return;

  if (message.guildId && !message.mentions.users.has(botId)) return;

  const content = stripBotMention(message.content, botId);
  if (!content) return;
  if (!isSendableChannel(message.channel)) return;
  const channel = message.channel as DiscordChannel;

  try {
    const agent = await getAgent(message.channelId, channel);
    const author = message.member?.displayName ?? message.author.username;
    await agent.prompt(author, content);
  } catch (error) {
    console.error("Failed to handle Discord message:", error);
    await discordService.sendMessage(channel, "ごめん、今はうまく返答できないみたい。");
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);

  await Promise.all(
    [...agents.values()].map(async (agentPromise) => {
      try {
        (await agentPromise).dispose();
      } catch {
        // The agent may fail to finish initialization during shutdown.
      }
    }),
  );

  client.destroy();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await client.login(token);
