/**
 * instagramChecker.js — v9 (IG Data RapidAPI edition)
 *
 * Uses IG Data API from RapidAPI — free tier, works from Railway.
 *
 * Required env vars:
 *   RAPIDAPI_KEY  — Your RapidAPI key
 */

const axios = require("axios");

// ── Constants ──────────────────────────────────────────────────────────────
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY || null;
const RAPIDAPI_HOST = "instagram-data1.p.rapidapi.com";

const CONFIRMATION_NEEDED = 1;

const STATUS = {
  BANNED:       "BANNED",
  ACCESSIBLE:   "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR:        "ERROR",
};

const confirmationTracker = {};

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

// ── IG Data API check ─────────────────────────────────────────────────────
async function checkViaIGData(username) {
  if (!RAPIDAPI_KEY) return null;

  try {
    const resp = await axios.get(
      "https://instagram-data1.p.rapidapi.com/user/info",
      {
        params: { username: username },
        headers: {
          "x-rapidapi-key":  RAPIDAPI_KEY,
          "x-rapidapi-host": RAPIDAPI_HOST,
        },
        timeout: 15000,
        validateStatus: function() { return true; },
      }
    );

    const httpStatus = resp.status;
    const data = resp.data;

    console.log("[IGData DEBUG]", httpStatus, JSON.stringify(data).slice(0, 300));

    if (httpStatus === 429) {
      return { status: STATUS.RATE_LIMITED, detail: "IGData: rate limited (429).", profile: null };
    }

    if (httpStatus === 402) {
      return { status: STATUS.ERROR, detail: "IGData: quota exceeded — upgrade plan.", profile: null };
    }

    if (httpStatus === 404 || (data && data.detail && data.detail.includes("not found"))) {
      return { status: STATUS.BANNED, detail: "IGData: user not found (banned or deleted).", profile: null };
    }

    if (httpStatus === 200 && data && (data.username || data.pk || data.id)) {
      const profile = {
        followers:    data.follower_count    || null,
        following:    data.following_count   || null,
        posts:        data.media_count       || null,
        displayName:  data.full_name         || null,
        profilePicUrl: data.profile_pic_url_hd || data.profile_pic_url || null,
        isPrivate:    data.is_private        || false,
      };
      return { status: STATUS.ACCESSIBLE, detail: "IGData: profile accessible.", profile: profile };
    }

    // user key is null = banned
    if (httpStatus === 200 && data && data.user === null) {
      return { status: STATUS.BANNED, detail: "IGData: user is null (banned or removed).", profile: null };
    }

    return { status: STATUS.ERROR, detail: "IGData: unexpected response HTTP " + httpStatus + ".", profile: null };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, detail: "IGData: request timed out.", profile: null };
    }
    return { status: STATUS.ERROR, detail: "IGData: " + err.message, profile: null };
  }
}

// ── Raw check ─────────────────────────────────────────────────────────────
async function rawCheck(username) {
  const checkedAt = new Date();

  if (RAPIDAPI_KEY) {
    const result = await checkViaIGData(username);
    if (result && result.status !== STATUS.ERROR) {
      return Object.assign({}, result, { checkedAt: checkedAt, method: "IGData" });
    }
    if (result) {
      console.warn("[rawCheck] IGData failed:", result.detail);
    }
  }

  return {
    status: STATUS.ERROR,
    detail: "No RAPIDAPI_KEY set or all methods failed.",
    profile: null,
    checkedAt: checkedAt,
    method: "None",
  };
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

module.exports = { checkAccount, checkAccountOnce, STATUS, jitter, formatCount, CONFIRMATION_NEEDED };
