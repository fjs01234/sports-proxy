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

// Team stats — correct ESPN endpoint
app.get("/teamstats/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const year = new Date().getFullYear();
  
  // Try multiple endpoints in order
  const endpoints = [
    // Athletes stats (per-player stats rolled up) — correct endpoint
    `https://site.web.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/athletes/statistics?season=${year}`,
    `https://site.web.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/athletes/statistics?season=${year - 1}`,
    // Team-level stats
    `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/statistics`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const data = await r.json();
      
      // Try every possible path ESPN might use
      const cats = data?.athletes  // athletes/statistics endpoint
               || data?.results?.splits?.categories
               || data?.splits?.categories
               || data?.categories
               || [];

      // If we got athletes array, restructure into categories format
      if (Array.isArray(cats) && cats.length > 0 && cats[0]?.athlete) {
        // athletes endpoint: [{athlete, statistics:[{name,displayValue}]}]
        // Convert to categories format for display
        const playerStats = cats.slice(0, 10).map(entry => ({
          name: entry.athlete?.displayName || "",
          pos: entry.athlete?.position?.abbreviation || "",
          stats: (entry.statistics || []).filter(s => s.displayValue && !["0","--","0.0","0.00"].includes(s.displayValue)).slice(0, 4).map(s => ({
            displayName: s.name || s.abbreviation,
            displayValue: s.displayValue,
            shortDisplayName: s.shortDisplayName || s.abbreviation || s.name,
          }))
        })).filter(p => p.stats.length > 0);

        if (playerStats.length > 0) {
          return res.json({ categories: [], athletes: playerStats, season: year, _endpoint: url });
        }
      }

      if (Array.isArray(cats) && cats.length > 0) {
        const season = data?.season?.year || data?.results?.season?.year || data?.requestedSeason?.year || year;
        return res.json({ categories: cats, season, _endpoint: url });
      }
    } catch (e) { continue; }
  }

  res.json({ categories: [], athletes: [], season: null });
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
