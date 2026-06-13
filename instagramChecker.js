/**
 * instagramChecker.js — v8 (instagram-private-api edition)
 *
 * Uses instagram-private-api with username/password login.
 * Works reliably from Railway datacenter IPs — no cookies, no proxy needed.
 *
 * Required env vars:
 *   IG_USERNAME  — Spare Instagram account username
 *   IG_PASSWORD  — Spare Instagram account password
 */

const { IgApiClient } = require("instagram-private-api");

// ── Constants ──────────────────────────────────────────────────────────────
const IG_USERNAME = process.env.IG_USERNAME || null;
const IG_PASSWORD = process.env.IG_PASSWORD || null;

const CONFIRMATION_NEEDED = 2;

const STATUS = {
  BANNED:       "BANNED",
  ACCESSIBLE:   "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR:        "ERROR",
};

const confirmationTracker = {};

// ── Instagram client (singleton) ───────────────────────────────────────────
let igClient = null;
let isLoggedIn = false;
let loginInProgress = false;

async function getClient() {
  if (isLoggedIn && igClient) return igClient;
  if (loginInProgress) {
    // Wait for ongoing login to finish
    await new Promise(resolve => setTimeout(resolve, 5000));
    return igClient;
  }

  loginInProgress = true;
  try {
    igClient = new IgApiClient();
    igClient.state.generateDevice(IG_USERNAME);

    console.log("[IG] Logging in as", IG_USERNAME, "...");
    await igClient.simulate.preLoginFlow();
    await igClient.account.login(IG_USERNAME, IG_PASSWORD);
    await igClient.simulate.postLoginFlow();

    isLoggedIn = true;
    console.log("[IG] Logged in successfully.");
    return igClient;
  } catch (err) {
    isLoggedIn = false;
    igClient = null;
    console.error("[IG] Login failed:", err.message);
    throw err;
  } finally {
    loginInProgress = false;
  }
}

// ── Utility functions ──────────────────────────────────────────────────────
function jitter(baseMs) {
  const variance = Math.floor(baseMs * 0.2);
  return Math.max(5000, baseMs + Math.floor(Math.random() * variance * 2) - variance);
}

function formatCount(n) {
  if (n === null || n === undefined) return "N/A";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// ── Core check via private API ─────────────────────────────────────────────
async function checkViaPrivateAPI(username) {
  if (!IG_USERNAME || !IG_PASSWORD) return null;

  try {
    const ig = await getClient();
    const user = await ig.user.searchExact(username);

    if (!user) {
      return { status: STATUS.BANNED, detail: "Private API: user not found.", profile: null };
    }

    // Get full info
    const info = await ig.user.info(user.pk);

    const profile = {
      followers:    info.follower_count    || null,
      following:    info.following_count   || null,
      posts:        info.media_count       || null,
      displayName:  info.full_name         || null,
      profilePicUrl: info.profile_pic_url  || null,
      isPrivate:    info.is_private        || false,
    };

    console.log("[PrivateAPI] Found user:", username, "followers:", profile.followers);
    return { status: STATUS.ACCESSIBLE, detail: "Private API: profile accessible.", profile: profile };

  } catch (err) {
    const msg = err.message || "";

    // User not found = banned/deleted
    if (msg.includes("User not found") || msg.includes("user_not_found") || err.name === "IgNotFoundError") {
      return { status: STATUS.BANNED, detail: "Private API: user not found (banned or deleted).", profile: null };
    }

    // Rate limited
    if (msg.includes("Please wait") || msg.includes("feedback_required") || msg.includes("checkpoint")) {
      return { status: STATUS.RATE_LIMITED, detail: "Private API: rate limited — waiting.", profile: null };
    }

    // Session expired — force re-login next call
    if (msg.includes("login_required") || msg.includes("Not authorized")) {
      console.warn("[PrivateAPI] Session expired, will re-login on next check.");
      isLoggedIn = false;
      igClient = null;
      return { status: STATUS.ERROR, detail: "Private API: session expired, re-logging in.", profile: null };
    }

    console.error("[PrivateAPI] Error for", username, ":", msg);
    return { status: STATUS.ERROR, detail: "Private API: " + msg, profile: null };
  }
}

// ── Raw check (single attempt, no confirmation logic) ─────────────────────
async function rawCheck(username) {
  const checkedAt = new Date();

  const result = await checkViaPrivateAPI(username);

  if (result) {
    return Object.assign({}, result, { checkedAt: checkedAt, method: "PrivateAPI" });
  }

  return { status: STATUS.ERROR, detail: "No IG credentials configured (set IG_USERNAME and IG_PASSWORD).", profile: null, checkedAt: checkedAt, method: "None" };
}

// ── Public checkAccount (with confirmation) ───────────────────────────────
async function checkAccount(username, knownStatus) {
  if (knownStatus === undefined) knownStatus = null;
  const raw = await rawCheck(username);

  if (raw.status === STATUS.RATE_LIMITED || raw.status === STATUS.ERROR) {
    delete confirmationTracker[username];
    return Object.assign({}, raw, { confirmed: false });
  }

  const tracker = confirmationTracker[username] || { pendingStatus: null, count: 0, lastProfile: null };

  if (raw.status === knownStatus) {
    confirmationTracker[username] = { pendingStatus: null, count: 0, lastProfile: null };
    return Object.assign({}, raw, { confirmed: false });
  }

  if (tracker.pendingStatus === raw.status) {
    tracker.count++;
    tracker.lastProfile = raw.profile || tracker.lastProfile;
  } else {
    tracker.pendingStatus = raw.status;
    tracker.count = 1;
    tracker.lastProfile = raw.profile || null;
  }

  confirmationTracker[username] = tracker;

  const confirmed = tracker.count >= CONFIRMATION_NEEDED;
  if (confirmed) {
    delete confirmationTracker[username];
  }

  return Object.assign({}, raw, {
    profile: tracker.lastProfile,
    confirmed: confirmed,
    confirmCount: tracker.count,
    confirmNeeded: CONFIRMATION_NEEDED,
  });
}

async function checkAccountOnce(username) {
  return rawCheck(username);
}

// ── Pre-warm login on startup ──────────────────────────────────────────────
if (IG_USERNAME && IG_PASSWORD) {
  getClient().catch(err => {
    console.error("[IG] Startup login failed:", err.message);
  });
} else {
  console.warn("[IG] IG_USERNAME or IG_PASSWORD not set — bot will not work!");
}

module.exports = { checkAccount, checkAccountOnce, STATUS, jitter, formatCount, CONFIRMATION_NEEDED };
