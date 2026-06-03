const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const SITE = "https://site.api.espn.com/apis/site/v2";
const CORE = "https://sports.core.api.espn.com/v2";

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
      if (item.firstName || item.fullName) {
        headCoach = item.fullName || `${item.firstName} ${item.lastName}`.trim();
        break;
      }
      if (item.$ref) {
        try {
          const cr = await fetch(item.$ref, { headers: { Accept: "application/json" } });
          const cd = await cr.json();
          if (cd.firstName || cd.fullName) {
            headCoach = cd.fullName || `${cd.firstName} ${cd.lastName}`.trim();
            break;
          }
        } catch {}
      }
    }

    const team = teamData.team || teamData || {};
    team._headCoach = headCoach;
    res.json({ team });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Player stats — parallel fetching, all roster members, diverse positions
app.get("/players/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const currentYear = new Date().getFullYear();

  try {
    const rosterRes = await fetch(`${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`, { headers: { Accept: "application/json" } });
    const rosterData = await rosterRes.json();
    const groups = rosterData?.athletes || [];

    // Collect ALL athletes from ALL position groups
    const allAthletes = [];
    for (const group of groups) {
      const groupPos = group.position || "";
      for (const item of (group.items || [])) {
        const ath = item.athlete || item;
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

    // For MLB put hitters before pitchers
    let ordered = allAthletes;
    if (league === "mlb") {
      const hitters  = allAthletes.filter(a => !["SP","RP","P","CL","MR"].includes(a.pos));
      const pitchers = allAthletes.filter(a =>  ["SP","RP","P","CL","MR"].includes(a.pos));
      ordered = [...hitters, ...pitchers];
    }

    // Best season type order per sport
    const typeOrder = ["basketball","hockey"].includes(sport) ? [3,2,1] : [2,3,1];

    // Helper: fetch stats for one athlete trying year/type combos
    async function fetchStats(ath) {
      for (const year of [currentYear, currentYear - 1]) {
        for (const type of typeOrder) {
          try {
            const url = `${CORE}/sports/${sport}/leagues/${league}/seasons/${year}/types/${type}/athletes/${ath.id}/statistics/0`;
            const r = await fetch(url, { headers: { Accept: "application/json" }, timeout: 5000 });
            if (!r.ok) continue;
            const data = await r.json();
            const cats = data?.splits?.categories || [];
            const lines = [];
            for (const cat of cats) {
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

    // Fetch ALL athletes in parallel (up to 25)
    const candidates = ordered.slice(0, 25);
    const results = await Promise.all(candidates.map(fetchStats));
    const players = results.filter(Boolean);

    res.json({ players, _total: allAthletes.length });
  } catch (e) {
    res.status(500).json({ error: e.message, players: [] });
  }
});

// Team season stats (offense/defense/pitching totals)
app.get("/teamstats/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const year = new Date().getFullYear();
  const results = {};
  // Try current year type 2, then prior year
  for (const y of [year, year - 1]) {
    for (const type of [2, 3]) {
      try {
        const url = `${CORE}/sports/${sport}/leagues/${league}/seasons/${y}/types/${type}/teams/${teamId}/statistics`;
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        if (!r.ok) continue;
        const data = await r.json();
        const cats = data?.splits?.categories || [];
        if (cats.length === 0) continue;
        results.categories = cats;
        results.year = y;
        results.type = type;
        return res.json(results);
      } catch {}
    }
  }
  res.json({ categories: [], year: null });
});
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
