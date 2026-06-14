/**
 * instagramChecker.js — v10 (Self-hosted API edition)
 *
 * Calls your own Instagram check API hosted on Render.com.
 *
 * Required env vars (in Railway):
 *   IG_API_URL     — Your Render API URL e.g. https://your-app.onrender.com
 *   IG_API_SECRET  — Same secret you set in Render (API_SECRET)
 */

const axios = require("axios");

const IG_API_URL    = process.env.IG_API_URL    || null;
const IG_API_SECRET = process.env.IG_API_SECRET || null;

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

// ── Call your self-hosted API ──────────────────────────────────────────────
async function checkViaOwnAPI(username) {
  if (!IG_API_URL) return null;

  try {
    const headers = {};
    if (IG_API_SECRET) headers["x-api-secret"] = IG_API_SECRET;

    const resp = await axios.get(
      `${IG_API_URL}/check`,
      {
        params: { username },
        headers,
        timeout: 20000,
        validateStatus: () => true,
      }
    );

    const httpStatus = resp.status;
    const data       = resp.data;

    console.log("[OwnAPI DEBUG]", httpStatus, JSON.stringify(data).slice(0, 200));

    if (httpStatus === 401) {
      return { status: STATUS.ERROR, detail: "OwnAPI: unauthorized — check IG_API_SECRET.", profile: null };
    }

    if (httpStatus === 200 && data.status === "ACCESSIBLE") {
      return { status: STATUS.ACCESSIBLE, detail: "OwnAPI: profile accessible.", profile: data.profile || null };
    }

    if (httpStatus === 200 && data.status === "BANNED") {
      return { status: STATUS.BANNED, detail: "OwnAPI: account banned or not found.", profile: null };
    }

    if (httpStatus === 200 && data.status === "RATE_LIMITED") {
      return { status: STATUS.RATE_LIMITED, detail: "OwnAPI: all accounts rate limited.", profile: null };
    }

    return { status: STATUS.ERROR, detail: "OwnAPI: unexpected response HTTP " + httpStatus + ".", profile: null };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, detail: "OwnAPI: request timed out.", profile: null };
    }
    return { status: STATUS.ERROR, detail: "OwnAPI: " + err.message, profile: null };
  }
}

// ── Raw check ─────────────────────────────────────────────────────────────
async function rawCheck(username) {
  const checkedAt = new Date();

  if (!IG_API_URL) {
    return { status: STATUS.ERROR, detail: "IG_API_URL not set in Railway env vars.", profile: null, checkedAt, method: "None" };
  }

  const result = await checkViaOwnAPI(username);
  return Object.assign(
    {},
    result || { status: STATUS.ERROR, detail: "API call failed.", profile: null },
    { checkedAt, method: "OwnAPI" }
  );
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
  if (confirmed) delete confirmationTracker[username];

  return Object.assign({}, raw, {
    profile: tracker.lastProfile,
    confirmed,
    confirmCount: tracker.count,
    confirmNeeded: CONFIRMATION_NEEDED,
  });
}

async function checkAccountOnce(username) {
  return rawCheck(username);
}

module.exports = { checkAccount, checkAccountOnce, STATUS, jitter, formatCount, CONFIRMATION_NEEDED };
