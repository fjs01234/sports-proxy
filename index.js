const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const SITE  = "https://site.api.espn.com/apis/site/v2";
const CORE  = "https://sports.core.api.espn.com/v2";

app.get("/", (req, res) => res.json({ status: "ok" }));

// Generic proxy — fetch any ESPN URL
app.get("/espn", async (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: "missing path" });
  try {
    const r = await fetch(`${SITE}/${path}`, { headers: { Accept: "application/json" } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug — show raw ESPN response for any URL
app.get("/debug", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "missing url" });
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    // Return top-level keys + first item sample
    const topKeys = Object.keys(data);
    const sample = {};
    for (const k of topKeys.slice(0, 5)) {
      const v = data[k];
      if (typeof v === "object" && v !== null) {
        sample[k] = Array.isArray(v) ? `[array len=${v.length}, first=${JSON.stringify(v[0]).slice(0,100)}]` : `{keys: ${Object.keys(v).join(",")}}`;
      } else {
        sample[k] = v;
      }
    }
    res.json({ status: r.status, topKeys, sample, raw: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team + coach
app.get("/team/:sport/:league/:id", async (req, res) => {
  const { sport, league, id } = req.params;
  const year = new Date().getFullYear();
  try {
    const [teamRes, coachRes] = await Promise.all([
      fetch(`${SITE}/sports/${sport}/${league}/teams/${id}`, { headers: { Accept: "application/json" } }),
      fetch(`${CORE}/sports/${sport}/leagues/${league}/seasons/${year}/teams/${id}/coaches`, { headers: { Accept: "application/json" } }),
    ]);
    const teamData = await teamRes.json();
    const coachData = await coachRes.json().catch(() => null);
    let headCoach = null;
    for (const item of (coachData?.items || [])) {
      if (item.firstName || item.fullName) { headCoach = item.fullName || `${item.firstName} ${item.lastName}`.trim(); break; }
      if (item.$ref) {
        try {
          const cr = await fetch(item.$ref, { headers: { Accept: "application/json" } });
          const cd = await cr.json();
          if (cd.firstName || cd.fullName) { headCoach = cd.fullName || `${cd.firstName} ${cd.lastName}`.trim(); break; }
        } catch {}
      }
    }
    const team = teamData.team || teamData || {};
    team._headCoach = headCoach;
    res.json({ team });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team stats
app.get("/teamstats/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  try {
    const url = `${SITE}/sports/${sport}/${league}/teams/${teamId}/statistics`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    // Log all possible paths
    const cats = data?.results?.splits?.categories
               || data?.splits?.categories
               || data?.statistics?.splits?.categories
               || data?.categories
               || [];
    const season = data?.season?.year || data?.results?.season?.year || data?.requestedSeason?.year || null;
    // Return raw too so frontend can debug
    res.json({ categories: cats, season, _topKeys: Object.keys(data), _raw: data });
  } catch (e) { res.status(500).json({ error: e.message, categories: [] }); }
});

// Player stats
app.get("/players/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const currentYear = new Date().getFullYear();
  try {
    const rosterRes = await fetch(`${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`, { headers: { Accept: "application/json" } });
    const rosterData = await rosterRes.json();
    const groups = rosterData?.athletes || [];

    const allAthletes = [];
    for (const group of groups) {
      const groupPos = group.position || "";
      for (const item of (group.items || [])) {
        const ath = item.athlete || item;
        if (ath?.id && ath?.displayName) {
          allAthletes.push({ id: ath.id, name: ath.displayName, pos: ath.position?.abbreviation || groupPos, jersey: ath.jersey || "" });
        }
      }
    }

    let ordered = allAthletes;
    if (league === "mlb") {
      const hitters  = allAthletes.filter(a => !["SP","RP","P","CL","MR"].includes(a.pos));
      const pitchers = allAthletes.filter(a =>  ["SP","RP","P","CL","MR"].includes(a.pos));
      ordered = [...hitters, ...pitchers];
    }

    const typeOrder = ["basketball","hockey"].includes(sport) ? [3,2,1] : [2,3,1];
    const yearsToTry = [currentYear, currentYear - 1];

    async function fetchStats(ath) {
      for (const year of yearsToTry) {
        for (const type of typeOrder) {
          try {
            const url = `${CORE}/sports/${sport}/leagues/${league}/seasons/${year}/types/${type}/athletes/${ath.id}/statistics/0`;
            const r = await fetch(url, { headers: { Accept: "application/json" } });
            if (!r.ok) continue;
            const data = await r.json();
            const lines = [];
            for (const cat of (data?.splits?.categories || [])) {
              for (const stat of (cat.stats || [])) {
                const v = stat.displayValue;
                if (!v || ["0","--","0.0","0.00"].includes(v)) continue;
                const l = stat.shortDisplayName || stat.abbreviation || stat.name;
                if (l && lines.length < 4) lines.push({ l, v });
              }
              if (lines.length >= 4) break;
            }
            if (lines.length > 0) return { ...ath, stats: lines };
          } catch {}
        }
      }
      return null;
    }

    const candidates = ordered.slice(0, 30);
    const results = await Promise.all(candidates.map(fetchStats));
    const players = results.filter(Boolean);

    // Debug: show first athlete's raw stat response
    let _debugFirstAthlete = null;
    if (candidates[0]) {
      try {
        const year = currentYear;
        const type = typeOrder[0];
        const url = `${CORE}/sports/${sport}/leagues/${league}/seasons/${year}/types/${type}/athletes/${candidates[0].id}/statistics/0`;
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        const d = await r.json();
        _debugFirstAthlete = { url, status: r.status, topKeys: Object.keys(d), splitsKeys: Object.keys(d?.splits||{}), catCount: (d?.splits?.categories||[]).length };
      } catch(e) { _debugFirstAthlete = { error: e.message }; }
    }

    res.json({ players, _total: allAthletes.length, _debug: _debugFirstAthlete });
  } catch (e) { res.status(500).json({ error: e.message, players: [] }); }
});

// News
app.get("/news/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  try {
    const r = await fetch(`${SITE}/sports/${sport}/${league}/news?team=${teamId}&limit=6`, { headers: { Accept: "application/json" } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scoreboard
app.get("/scoreboard/:sport/:league", async (req, res) => {
  const { sport, league } = req.params;
  try {
    const r = await fetch(`${SITE}/sports/${sport}/${league}/scoreboard`, { headers: { Accept: "application/json" } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`proxy running on ${PORT}`));
