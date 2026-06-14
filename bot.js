/**
 * bot.js — Instagram Account Monitor (v9)
 */

require("dotenv").config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, Events,
} = require("discord.js");

const { monitoringBase, oldClients, permissions, MAX_ACTIVE } = require("./store");
const { checkAccount, checkAccountOnce, STATUS, jitter, formatCount, CONFIRMATION_NEEDED } = require("./instagramChecker");

// ── Env validation ─────────────────────────────────────────────────────────
const REQUIRED_ENV = ["DISCORD_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_GUILD_ID"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key] || process.env[key].includes("your_")) {
    console.error(`❌  Missing env var: ${key}. Edit your .env file.`);
    process.exit(1);
  }
}
if (!process.env.LOG_CHANNEL_ID || process.env.LOG_CHANNEL_ID.includes("your_")) {
  console.warn("⚠️  LOG_CHANNEL_ID not set — admin activity logging is disabled.");
}
if (!process.env.RAPIDAPI_KEY) {
  console.warn("⚠️  RAPIDAPI_KEY not set — bot will not work!");
}

const TOKEN          = process.env.DISCORD_TOKEN;
const CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID;
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;

const BASE_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "120000", 10);

// ── Discord client ─────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Slash command definitions ──────────────────────────────────────────────
const userOpt   = (opt) => opt.setName("username").setDescription("Instagram username (without @)").setRequired(true);
const memberOpt = (opt) => opt.setName("user").setDescription("Discord user to grant/revoke access").setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to use the Instagram Monitor bot")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Instagram account monitor — track bans and recoveries")
    .addSubcommand((s) => s.setName("add")    .setDescription("Add an Instagram account to monitor").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("list")   .setDescription("Show currently active watching list"))
    .addSubcommand((s) => s.setName("status") .setDescription("Check the current status of a monitored account").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("remove") .setDescription("Stop monitoring an account").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("grant")  .setDescription("(Owner) Grant a user access").addUserOption(memberOpt))
    .addSubcommand((s) => s.setName("revoke") .setDescription("(Owner) Revoke a user's access").addUserOption(memberOpt))
    .toJSON(),
];

// ── Register slash commands ────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ── Admin log ─────────────────────────────────────────────────────────────
async function adminLog({ type, title, description, color, user, guild, fields = [] }) {
  if (!LOG_CHANNEL_ID) return;
  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!logChannel) return;

  const typeColors = { COMMAND: 0x5865f2, BOT_RESPONSE: 0x36393f, ALERT: 0xff9900, SYSTEM: 0x888888 };
  const typeLabels = { COMMAND: "📥 USER COMMAND", BOT_RESPONSE: "📤 BOT RESPONSE", ALERT: "🔔 ALERT SENT", SYSTEM: "⚙️ SYSTEM" };

  const embed = new EmbedBuilder()
    .setColor(color ?? typeColors[type] ?? 0x888888)
    .setTitle(`${typeLabels[type] ?? type} — ${title}`)
    .setDescription(description || "_no detail_")
    .setTimestamp();

  if (user) embed.setAuthor({ name: `${user.tag} (ID: ${user.id})`, iconURL: user.displayAvatarURL?.() });
  if (guild) embed.setFooter({ text: guild });
  if (fields.length) embed.addFields(fields);

  await logChannel.send({ embeds: [embed] }).catch((e) => console.error("Admin log failed:", e.message));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms || ms < 0) return "unknown";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tsField(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:F>`;
}

function tsRelative(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:R>`;
}

function validateUsername(username) {
  return /^[a-zA-Z0-9._]{1,30}$/.test(username);
}

function getAlertMentionIds(account) {
  const { ownerId, allowedUsers } = permissions.listAllowed();
  const ids = new Set();
  if (account.addedById) ids.add(account.addedById);
  if (ownerId) ids.add(ownerId);
  if (Array.isArray(allowedUsers)) allowedUsers.forEach((id) => ids.add(id));
  return [...ids];
}

function resolveProfilePic(username, scrapedUrl) {
  return scrapedUrl || `https://unavatar.io/instagram/${username}`;
}

function buildProfileFields(profile, label = "📸 Last Known Profile Stats") {
  if (!profile || (profile.followers === null && profile.following === null)) {
    return [{ name: label, value: "_Stats unavailable._", inline: false }];
  }
  const lines = [];
  if (profile.displayName) lines.push(`**Name:** ${profile.displayName}`);
  lines.push(`**👥 Followers:** ${formatCount(profile.followers) ?? "N/A"}`);
  lines.push(`**➡️ Following:** ${formatCount(profile.following) ?? "N/A"}`);
  if (profile.posts !== null) lines.push(`**🖼️ Posts:** ${formatCount(profile.posts)}`);
  if (profile.isPrivate) lines.push(`**🔒 Account Type:** Private`);
  return [{ name: label, value: lines.join("\n"), inline: false }];
}

// ── Notification: BANNED ──────────────────────────────────────────────────
async function notifyAccountBanned(username, account) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now        = Date.now();
  const timeTaken  = account.addedAt ? formatDuration(now - new Date(account.addedAt).getTime()) : "unknown";
  const bannedAt   = new Date(now).toISOString();
  const mentionIds = getAlertMentionIds(account);
  const pings      = mentionIds.map((id) => `<@${id}>`).join(" ");
  const profile    = account.cachedProfile || null;
  const picUrl     = resolveProfilePic(username, profile?.profilePicUrl);
  const followers  = profile?.followers != null ? formatCount(profile.followers) : "N/A";

  const msgLines = [
    `${pings}`,
    ``,
    `🚫 **Account Banned!** @${username} ❌`,
    `👥 Followers: ${followers} | ⏱️ Time Taken: ${timeTaken}`,
  ];

  const embed = new EmbedBuilder()
    .setColor(0xff2200)
    .setThumbnail(picUrl)
    .setFooter({ text: `Instagram Monitor • ${new Date(bannedAt).toUTCString()}` });

  await channel.send({ content: msgLines.join("\n"), embeds: [embed], allowedMentions: { users: mentionIds } });

  await adminLog({
    type: "ALERT", title: `@${username} — BANNED`, color: 0xff2200,
    description:
      `🚨 **Ban detected** for \`@${username}\`.\n` +
      `Notification sent to: ${pings}\n\n` +
      `**Added by:** ${account.addedBy} (ID: \`${account.addedById ?? "unknown"}\`)\n` +
      `**Banned at:** ${new Date(bannedAt).toUTCString()}\n` +
      `**Time taken:** ${timeTaken}\n` +
      `**Checks done:** ${account.checkCount.toLocaleString()}`,
    fields: buildProfileFields(profile, "📸 Profile Stats at Ban"),
  });
}

// ── Notification: UNBANNED ────────────────────────────────────────────────
async function notifyAccountUnbanned(username, account, freshProfile) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now        = Date.now();
  const timeTaken  = account.addedAt ? formatDuration(now - new Date(account.addedAt).getTime()) : "unknown";
  const unbannedAt = new Date(now).toISOString();
  const mentionIds = getAlertMentionIds(account);
  const pings      = mentionIds.map((id) => `<@${id}>`).join(" ");
  const picUrl     = resolveProfilePic(username, freshProfile?.profilePicUrl);
  const followers  = freshProfile?.followers != null ? formatCount(freshProfile.followers) : "N/A";

  const msgLines = [
    `${pings}`,
    ``,
    `🏆 **Account Recovered!** @${username} ✅`,
    `👥 Followers: ${followers} | ⏱️ Time Taken: ${timeTaken}`,
  ];

  const embed = new EmbedBuilder()
    .setColor(0x00ff88)
    .setThumbnail(picUrl)
    .setFooter({ text: `Instagram Monitor • ${new Date(unbannedAt).toUTCString()}` });

  await channel.send({ content: msgLines.join("\n"), embeds: [embed], allowedMentions: { users: mentionIds } });

  await adminLog({
    type: "ALERT", title: `@${username} — UNBANNED / RECOVERED`, color: 0x00ff88,
    description:
      `✅ **Unban detected** for \`@${username}\`.\n` +
      `Notification sent to: ${pings}\n\n` +
      `**Added by:** ${account.addedBy} (ID: \`${account.addedById ?? "unknown"}\`)\n` +
      `**Unbanned at:** ${new Date(unbannedAt).toUTCString()}\n` +
      `**Time taken:** ${timeTaken}\n` +
      `**Checks done:** ${account.checkCount.toLocaleString()}`,
    fields: buildProfileFields(freshProfile, "📸 Profile Stats at Recovery"),
  });
}

// ── Archive helpers ────────────────────────────────────────────────────────
function archiveRecord(record, reason) {
  const timeTaken  = record.addedAt ? Date.now() - new Date(record.addedAt).getTime() : null;
  const resolution =
    reason === "BAN_DETECTED"     ? `Banned after ${formatDuration(timeTaken)} of monitoring.` :
    reason === "UNBAN_DETECTED"   ? `Recovered after ${formatDuration(timeTaken)} of monitoring.` :
    reason === "MANUALLY_REMOVED" ? "Manually removed from monitoring." : "Archived.";
  oldClients.archive(record, reason, resolution);
}

function archiveAndStop(username, reason) {
  stopMonitoring(username);
  const record = monitoringBase.get(username);
  if (record) {
    archiveRecord(record, reason);
    monitoringBase.update(username, { active: false });
  }
}

// ── Monitor loop ───────────────────────────────────────────────────────────
const activeTimers  = {};
const backoffTimers = {};

async function scheduleCheck(username, initialDelayMs = 0) {
  const account = monitoringBase.get(username);
  if (!account || !account.active) return;

  const delay = initialDelayMs > 0
    ? initialDelayMs
    : jitter(backoffTimers[username] || BASE_INTERVAL_MS);

  activeTimers[username] = setTimeout(async () => {
    const prev = monitoringBase.get(username);
    if (!prev || !prev.active) return;

    const result = await checkAccount(username, prev.lastStatus);

    const updates = {
      lastChecked: result.checkedAt.toISOString(),
      checkCount:  (prev.checkCount || 0) + 1,
    };

    if (result.status === STATUS.RATE_LIMITED) {
      const backoff = Math.min((backoffTimers[username] || BASE_INTERVAL_MS) * 2, 10 * 60 * 1000);
      backoffTimers[username] = backoff;
      console.warn(`⚠️  [${username}] Rate limited. Backing off to ${Math.round(backoff / 1000)}s.`);
      monitoringBase.update(username, updates);
      scheduleCheck(username, backoff);
      return;
    }

    if (result.status === STATUS.ERROR) {
      console.warn(`⚠️  [${username}] Check error: ${result.detail}`);
      monitoringBase.update(username, updates);
      scheduleCheck(username);
      return;
    }

    backoffTimers[username] = BASE_INTERVAL_MS;
    updates.lastStatus = result.status;
    if (result.status === STATUS.ACCESSIBLE && result.profile) {
      updates.cachedProfile = result.profile;
    }
    monitoringBase.update(username, updates);

    const methodTag = result.method ? ` [${result.method}]` : "";

    if (!result.confirmed && result.confirmCount) {
      console.log(`[${new Date().toLocaleTimeString()}] @${username} (${prev.mode})${methodTag} → ${result.status} (confirming: ${result.confirmCount}/${CONFIRMATION_NEEDED})`);
    } else {
      console.log(`[${new Date().toLocaleTimeString()}] @${username} (${prev.mode})${methodTag} → ${result.status}`);
    }

    if (!result.confirmed) {
      scheduleCheck(username);
      return;
    }

    const updated = monitoringBase.get(username);

    if (updated.mode === "WATCH_FOR_BAN" && result.status === STATUS.BANNED) {
      console.log(`🚨  @${username} CONFIRMED BANNED after ${CONFIRMATION_NEEDED} checks. Alerting...`);
      monitoringBase.update(username, { active: false, eventDetectedAt: result.checkedAt.toISOString(), lastStatus: STATUS.BANNED });
      const finalRecord = monitoringBase.get(username);
      archiveRecord(finalRecord, "BAN_DETECTED");
      await notifyAccountBanned(username, finalRecord);
      return;
    }

    if (updated.mode === "WATCH_FOR_UNBAN" && result.status === STATUS.ACCESSIBLE) {
      console.log(`✅  @${username} CONFIRMED UNBANNED after ${CONFIRMATION_NEEDED} checks. Alerting...`);
      monitoringBase.update(username, { active: false, eventDetectedAt: result.checkedAt.toISOString(), lastStatus: STATUS.ACCESSIBLE, cachedProfile: result.profile });
      const finalRecord = monitoringBase.get(username);
      archiveRecord(finalRecord, "UNBAN_DETECTED");
      await notifyAccountUnbanned(username, finalRecord, result.profile);
      return;
    }

    scheduleCheck(username);
  }, delay);
}

function startMonitoring(username, initialDelayMs = 0) {
  if (activeTimers[username]) clearTimeout(activeTimers[username]);
  scheduleCheck(username, initialDelayMs);
}

function stopMonitoring(username) {
  if (activeTimers[username]) {
    clearTimeout(activeTimers[username]);
    delete activeTimers[username];
  }
  delete backoffTimers[username];
}

function resumeAll() {
  const active = Object.keys(monitoringBase.getActive());
  if (!active.length) {
    console.log("📭 No active accounts to resume.");
    adminLog({ type: "SYSTEM", title: "Bot Started", description: "No active accounts. Ready for new entries." });
    return;
  }

  console.log(`▶️  Resuming monitoring for: ${active.join(", ")}`);
  const STAGGER_MS = Math.floor(BASE_INTERVAL_MS / (active.length + 1));
  active.forEach((username, i) => {
    const delay = (i + 1) * STAGGER_MS;
    console.log(`  ↪ @${username} first check in ${Math.round(delay / 1000)}s`);
    startMonitoring(username, delay);
  });

  adminLog({
    type: "SYSTEM", title: "Bot Restarted — Monitoring Resumed",
    description:
      `Resumed monitoring for **${active.length}** account(s): ` +
      active.map((u) => `\`@${u}\``).join(", ") +
      `\n\nBase interval: **${Math.round(BASE_INTERVAL_MS / 1000)}s** | Confirmations needed: **${CONFIRMATION_NEEDED}**`,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// INTERACTION HANDLER
// ══════════════════════════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "help") {
    const checkMins = Math.round(BASE_INTERVAL_MS / 60000);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📖  Instagram Monitor — Help")
      .setDescription("This bot monitors Instagram accounts and alerts you the moment they get **banned** or **unbanned**.\nSimply add an account and the bot handles everything automatically.")
      .addFields(
        { name: "➕  `/monitor add <username>`", value: "Add an Instagram account to monitor.\n• If the account is **live**, the bot watches for it getting banned/deleted.\n• If the account is **already banned**, the bot watches for it coming back." },
        { name: "📋  `/monitor list`", value: "Shows all accounts currently being monitored." },
        { name: "🔍  `/monitor status <username>`", value: "Runs an immediate live check and shows current status." },
        { name: "🗑️  `/monitor remove <username>`", value: "Stops monitoring an account." },
        { name: "⚙️  Bot Settings", value: `• Check interval: **every ~${checkMins} minute${checkMins === 1 ? "" : "s"}**\n• Max accounts: **${MAX_ACTIVE}**\n• Confirmations before alert: **${CONFIRMATION_NEEDED}×**` },
      )
      .setFooter({ text: `Instagram Monitor v9 • /monitor add <username> to get started` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  if (commandName !== "monitor") return;

  const sub      = interaction.options.getSubcommand();
  const rawUser  = interaction.options.getString("username") || "";
  const username = rawUser.toLowerCase().replace(/^@/, "");
  const logCtx   = `${interaction.guild?.name ?? "DM"} | #${interaction.channel?.name ?? "unknown"}`;

  if (sub === "grant") {
    const perms = permissions.load();
    if (!perms.ownerId) {
      permissions.setOwner(interaction.user.id);
    } else if (!permissions.isOwner(interaction.user.id)) {
      return interaction.reply({ content: "❌ Only the **owner** can grant access.", flags: 64 });
    }
    const target = interaction.options.getUser("user");
    permissions.grantAccess(target.id);
    return interaction.reply({ content: `✅ **${target.tag}** can now use \`/monitor list\` and will be pinged on all alerts.`, flags: 64 });
  }

  if (sub === "revoke") {
    if (!permissions.isOwner(interaction.user.id)) {
      return interaction.reply({ content: "❌ Only the **owner** can revoke access.", flags: 64 });
    }
    const target = interaction.options.getUser("user");
    permissions.revokeAccess(target.id);
    return interaction.reply({ content: `🚫 **${target.tag}** no longer has access.`, flags: 64 });
  }

  if (sub === "add") {
    if (!validateUsername(username)) {
      return interaction.reply({ content: "❌ Invalid Instagram username. Use only letters, numbers, `.` and `_`.", flags: 64 });
    }
    if (monitoringBase.get(username)?.active) {
      return interaction.reply({ content: `⚠️ **@${username}** is already being monitored.`, flags: 64 });
    }
    if (monitoringBase.activeCount() >= MAX_ACTIVE) {
      return interaction.reply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots max). Remove an account first.`, flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const firstCheck = await checkAccountOnce(username);
    const mode       = firstCheck.status === STATUS.ACCESSIBLE ? "WATCH_FOR_BAN" : "WATCH_FOR_UNBAN";

    const added = monitoringBase.add(username, interaction.user.tag, interaction.user.id, mode, firstCheck.status === STATUS.ACCESSIBLE ? "ACCESSIBLE" : "BANNED");
    if (!added.ok) {
      if (added.reason === "already_monitored") return interaction.editReply({ content: `⚠️ **@${username}** is already being monitored.` });
      if (added.reason === "max_reached")       return interaction.editReply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots).` });
    }

    monitoringBase.update(username, {
      lastChecked:   firstCheck.checkedAt.toISOString(),
      lastStatus:    firstCheck.status,
      checkCount:    1,
      cachedProfile: firstCheck.profile || null,
    });

    startMonitoring(username);

    const picUrl   = resolveProfilePic(username, firstCheck.profile?.profilePicUrl);
    const checkMin = Math.round(BASE_INTERVAL_MS / 60000);

    let embed;
    if (mode === "WATCH_FOR_BAN") {
      embed = new EmbedBuilder()
        .setColor(0x00cc55)
        .setTitle("🟢  Account Is Live — Monitoring for Ban")
        .setThumbnail(picUrl)
        .setDescription(`**@${username}** is currently **LIVE** on Instagram.\n\nYou'll be notified the moment this account gets **banned or deactivated**.\n\n⏱️ Checking every ~${checkMin} min · 🔒 ${CONFIRMATION_NEEDED}× confirmation required before alert`)
        .addFields(
          { name: "🎯 Target",         value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🟢 LIVE / ACCESSIBLE",                             inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Ban / Deletion / Deactivation",                    inline: false },
          ...buildProfileFields(firstCheck.profile, "📸 Current Profile Stats"),
        )
        .setFooter({ text: "Instagram Monitor v9 • Monitoring Base" })
        .setTimestamp();
    } else {
      embed = new EmbedBuilder()
        .setColor(0xff4444)
        .setTitle("🔴  Account Is Banned — Monitoring for Recovery")
        .setThumbnail(picUrl)
        .setDescription(`**@${username}** is currently **BANNED** on Instagram.\n\nYou'll be notified the moment this account gets **un-banned or recovered**.\n\n⏱️ Checking every ~${checkMin} min · 🔒 ${CONFIRMATION_NEEDED}× confirmation required before alert`)
        .addFields(
          { name: "🎯 Client Account", value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🔴 BANNED",                                        inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Unban / Account Recovery",                         inline: false },
          { name: "📸 Profile Stats",  value: "_Not available — account is currently banned._",   inline: false },
        )
        .setFooter({ text: "Instagram Monitor v9 • Monitoring Base" })
        .setTimestamp();
    }

    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === "list") {
    if (!permissions.canViewList(interaction.user.id)) {
      return interaction.reply({ content: "🔒 You don't have permission. Ask the owner to run `/monitor grant @you`.", flags: 64 });
    }

    const active = monitoringBase.listActive();
    if (!active.length) {
      return interaction.reply({ content: "📭 No accounts are currently being monitored. Use `/monitor add <username>` to get started.", flags: 64 });
    }

    const watchingBan   = active.filter((a) => a.mode === "WATCH_FOR_BAN");
    const watchingUnban = active.filter((a) => a.mode === "WATCH_FOR_UNBAN");
    const checkMin      = Math.round(BASE_INTERVAL_MS / 60000);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📡  Active Monitoring List")
      .setDescription(`**${active.length}** account(s) being watched — **${active.length}/${MAX_ACTIVE}** slots used.\nCheck interval: ~${checkMin} min · Confirmation: ${CONFIRMATION_NEEDED}× required`)
      .setFooter({ text: "Instagram Monitor v9 • Active Only" })
      .setTimestamp();

    if (watchingBan.length) {
      embed.addFields({
        name: `🟢 LIVE — Watching for Ban (${watchingBan.length})`,
        value: watchingBan.map((a) => {
          const f = a.cachedProfile?.followers != null ? ` · ${formatCount(a.cachedProfile.followers)} followers` : "";
          return `🟢 **@${a.username}**${f}\n┣ Added by: \`${a.addedBy}\`\n┣ Added: ${tsRelative(a.addedAt)}\n┗ Checks: ${a.checkCount.toLocaleString()}`;
        }).join("\n\n"),
      });
    }

    if (watchingUnban.length) {
      embed.addFields({
        name: `🔴 BANNED — Watching for Recovery (${watchingUnban.length})`,
        value: watchingUnban.map((a) =>
          `🔴 **@${a.username}**\n┣ Added by: \`${a.addedBy}\`\n┣ Added: ${tsRelative(a.addedAt)}\n┗ Checks: ${a.checkCount.toLocaleString()}`
        ).join("\n\n"),
      });
    }

    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  if (sub === "status") {
    if (!username) return interaction.reply({ content: "❌ Please provide an Instagram username.", flags: 64 });

    const account = monitoringBase.get(username);
    if (!account) {
      return interaction.reply({ content: `❌ **@${username}** is not in the active Monitoring Base.`, flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const result = await checkAccountOnce(username);
    monitoringBase.update(username, {
      lastChecked: result.checkedAt.toISOString(),
      lastStatus:  result.status,
      checkCount:  (account.checkCount || 0) + 1,
      ...(result.profile ? { cachedProfile: result.profile } : {}),
    });

    const updated   = monitoringBase.get(username);
    const color     = result.status === STATUS.ACCESSIBLE ? 0x00ff88 : result.status === STATUS.RATE_LIMITED ? 0xffcc00 : 0xff4444;
    const modeLabel = updated.mode === "WATCH_FOR_BAN" ? "🟢 Watching for Ban/Deletion" : "🔴 Watching for Unban/Recovery";
    const sEmoji    = { BANNED: "🔴", ACCESSIBLE: "🟢", RATE_LIMITED: "🟡", ERROR: "⚠️" };
    const picUrl    = resolveProfilePic(username, updated.cachedProfile?.profilePicUrl);
    const checkMin  = Math.round(BASE_INTERVAL_MS / 60000);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📊 Status Check — @${username}`)
      .setThumbnail(picUrl)
      .addFields(
        { name: "📊 Current Status", value: `${sEmoji[result.status] || "⏳"} ${result.status}`, inline: true },
        { name: "🎯 Monitor Mode",   value: modeLabel,                                            inline: true },
        { name: "👤 Added By",       value: updated.addedBy,                                      inline: true },
        { name: "🔢 Total Checks",   value: updated.checkCount.toLocaleString(),                  inline: true },
        { name: "📅 Added",          value: tsField(updated.addedAt),                             inline: true },
        { name: "🕐 Last Checked",   value: tsField(updated.lastChecked),                         inline: true },
        { name: "⚙️ Check Interval", value: `~${checkMin} min (${CONFIRMATION_NEEDED}× confirm)`, inline: true },
        { name: "🔍 Detail",         value: result.detail,                                        inline: false },
        ...buildProfileFields(updated.cachedProfile, "📸 Profile Stats"),
      )
      .setFooter({ text: "Instagram Monitor v9 • Live Check" })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === "remove") {
    if (!username) return interaction.reply({ content: "❌ Please provide an Instagram username.", flags: 64 });

    const account = monitoringBase.get(username);
    if (!account) {
      return interaction.reply({ content: `❌ **@${username}** is not in the active Monitoring Base.`, flags: 64 });
    }

    archiveAndStop(username, "MANUALLY_REMOVED");

    const embed = new EmbedBuilder()
      .setColor(0x888888)
      .setTitle("🗑️  Account Removed & Archived")
      .setDescription(`**@${username}** has been removed from active monitoring and saved to the **Old Clients** archive.`)
      .addFields(
        { name: "👤 Was Added By", value: account.addedBy,          inline: true },
        { name: "📅 Was Added On", value: tsField(account.addedAt), inline: true },
        { name: "🔢 Total Checks", value: `${account.checkCount}`,  inline: true },
      )
      .setFooter({ text: "Instagram Monitor v9 • Archived to Old Clients" })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: 64 });
  }
});

// ── Ready ──────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Notification channel : ${CHANNEL_ID}`);
  console.log(`📦 Max monitoring slots : ${MAX_ACTIVE}`);
  console.log(`⏱️  Check interval       : ${Math.round(BASE_INTERVAL_MS / 1000)}s (~${Math.round(BASE_INTERVAL_MS / 60000)} min)`);
  console.log(`✅  Confirmations needed : ${CONFIRMATION_NEEDED}x`);
  console.log(`🔐 Admin log channel    : ${LOG_CHANNEL_ID ?? "NOT SET (disabled)"}`);
  console.log(`🔑 RapidAPI Key        : ${process.env.RAPIDAPI_KEY ? "configured ✅" : "NOT SET ⚠️"}\n`);
  await registerCommands();
  resumeAll();
  console.log("🤖 Bot is running. Use /monitor in Discord.\n");
});

client.login(TOKEN);
