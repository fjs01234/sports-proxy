const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const SITE  = "https://site.api.espn.com/apis/site/v2";
const SITEV3 = "https://site.api.espn.com/apis/site/v3";
const CORE  = "https://sports.core.api.espn.com/v2";

app.get("/", (req, res) => res.json({ status: "ok" }));

app.get("/espn", async (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: "missing path" });
  try {
    const r = await fetch(`${SITE}/${path}`, { headers: { Accept: "application/json" } });
    res.json(await r.json());
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

// Team stats — use v3 leaders filtered to a team
app.get("/teamstats/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const year = new Date().getFullYear();
  
  // Try v3 leaders (most reliable for season stats)
  const typesToTry = ["basketball","hockey"].includes(sport) ? [3,2] : [2,3];
  const yearsToTry = [year, year - 1];
  
  for (const y of yearsToTry) {
    for (const type of typesToTry) {
      try {
        const url = `${SITEV3}/sports/${sport}/${league}/leaders?season=${y}&seasontype=${type}`;
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        if (!r.ok) continue;
        const data = await r.json();
        
        // v3 leaders: { leaders: [ { displayName, leaders: [ { athlete, statistics, displayValue } ] } ] }
        const leaderCats = data?.leaders || [];
        if (!leaderCats.length) continue;
        
        // Filter leaders to only this team's players
        const teamLeaders = [];
        for (const cat of leaderCats) {
          const catName = cat.shortDisplayName || cat.displayName || cat.name || "";
          for (const entry of (cat.leaders || []).slice(0, 3)) {
            const athleteTeamId = String(entry.team?.id || entry.athlete?.team?.id || "");
            if (athleteTeamId !== String(teamId)) continue;
            teamLeaders.push({
              category: catName,
              athlete: entry.athlete?.displayName || "",
              pos: entry.athlete?.position?.abbreviation || "",
              value: entry.displayValue || entry.value || "",
            });
            break; // only top player per category from this team
          }
        }
        
        if (teamLeaders.length > 0) {
          return res.json({ leaders: teamLeaders, season: y, type, format: "leaders" });
        }
      } catch {}
    }
  }
  
  res.json({ leaders: [], season: null, format: "empty" });
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
    res.json({ players, _total: allAthletes.length });
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
