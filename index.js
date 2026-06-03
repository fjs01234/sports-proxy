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

// Team stats — v2stats works! Data is at results.stats.splits.categories
// Also try v3 leaders with NO season param (returns current season)
app.get("/teamstats/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;

  // Strategy 1: v3 leaders (no season param = current season)
  try {
    const url = `${SITEV3}/sports/${sport}/${league}/leaders`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const data = await r.json();
      const leaderCats = data?.leaders || [];
      const teamLeaders = [];
      for (const cat of leaderCats) {
        const catName = cat.shortDisplayName || cat.displayName || cat.name || "";
        for (const entry of (cat.leaders || [])) {
          // team id can be on entry.team or entry.athlete.team
          const entryTeam = String(entry.team?.id || entry.athlete?.team?.id || "");
          if (entryTeam !== String(teamId)) continue;
          teamLeaders.push({
            category: catName,
            athlete: entry.athlete?.displayName || "",
            pos: entry.athlete?.position?.abbreviation || "",
            value: entry.displayValue || "",
          });
          break;
        }
      }
      if (teamLeaders.length > 0) {
        return res.json({ leaders: teamLeaders, season: data?.currentSeason?.year || null, format: "leaders" });
      }
    }
  } catch {}

  // Strategy 2: v2 team statistics — data at results.stats.splits.categories OR results.splits.categories
  try {
    const url = `${SITE}/sports/${sport}/${league}/teams/${teamId}/statistics`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const data = await r.json();
      // From diag: keys are status, results, season, requestedSeason, team
      const cats = data?.results?.stats?.splits?.categories
               || data?.results?.splits?.categories
               || data?.splits?.categories
               || [];
      const season = data?.season?.year || data?.requestedSeason?.year || null;
      if (cats.length > 0) {
        return res.json({ categories: cats, season, format: "categories" });
      }
    }
  } catch {}

  res.json({ leaders: [], categories: [], season: null, format: "empty" });
});

// Player stats — roster keys: timestamp, status, season, athletes, coach, team
// athletes is a flat array of athlete objects (not grouped)
app.get("/players/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const currentYear = new Date().getFullYear();
  try {
    const rosterRes = await fetch(`${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`, { headers: { Accept: "application/json" } });
    const rosterData = await rosterRes.json();

    // From diag: roster keys are timestamp, status, season, athletes, coach, team
    // athletes could be flat array OR grouped array — handle both
    const rawAthletes = rosterData?.athletes || [];
    const allAthletes = [];

    for (const item of rawAthletes) {
      // Flat array: item is an athlete directly
      if (item?.id && item?.displayName) {
        allAthletes.push({
          id: item.id,
          name: item.displayName,
          pos: item.position?.abbreviation || item.position || "",
          jersey: item.jersey || "",
        });
      }
      // Grouped array: item has .items[]
      else if (item?.items) {
        const groupPos = item.position || "";
        for (const sub of item.items) {
          const ath = sub.athlete || sub;
          if (ath?.id && ath?.displayName) {
            allAthletes.push({
              id: ath.id,
              name: ath.displayName,
              pos: ath.position?.abbreviation || groupPos,
              jersey: ath.jersey || "",
            });
          }
        }
      }
    }

    // MLB: hitters before pitchers
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
  } catch (e) { res.status(500).json({ error: e.message, players: [], _total: 0 }); }
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

// Diag
app.get("/diag/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const year = new Date().getFullYear();
  const results = {};
  const tests = [
    ["v3leaders_noseason", `${SITEV3}/sports/${sport}/${league}/leaders`],
    ["v2stats", `${SITE}/sports/${sport}/${league}/teams/${teamId}/statistics`],
    ["roster", `${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`],
  ];
  for (const [name, url] of tests) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      const d = await r.json();
      results[name] = { status: r.status, topKeys: Object.keys(d), sample: JSON.stringify(d).slice(0, 600) };
    } catch(e) { results[name] = { error: e.message }; }
  }
  // Test athlete stats
  try {
    const rr = await fetch(`${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`);
    const rd = await rr.json();
    const rawAthletes = rd?.athletes || [];
    let firstAth = null;
    for (const item of rawAthletes) {
      if (item?.id) { firstAth = item; break; }
      if (item?.items?.[0]) { firstAth = item.items[0].athlete || item.items[0]; break; }
    }
    if (firstAth?.id) {
      for (const type of [3,2,1]) {
        const url = `${CORE}/sports/${sport}/leagues/${league}/seasons/${year}/types/${type}/athletes/${firstAth.id}/statistics/0`;
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        const d = await r.json();
        results[`core_type${type}`] = { athleteId: firstAth.id, name: firstAth.displayName, status: r.status, cats: (d?.splits?.categories||[]).length, firstCat: JSON.stringify(d?.splits?.categories?.[0]).slice(0,300) };
        if ((d?.splits?.categories||[]).length > 0) break;
      }
    } else {
      results["roster_structure"] = { athletesSample: JSON.stringify(rawAthletes[0]).slice(0, 200) };
    }
  } catch(e) { results["core_test"] = { error: e.message }; }
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`proxy running on ${PORT}`));
