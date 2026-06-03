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

// Player stats — handles offseason by trying current + prior year, multiple season types
app.get("/players/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const currentYear = new Date().getFullYear();

  try {
    // Get roster first
    const rosterRes = await fetch(`${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`, { headers: { Accept: "application/json" } });
    const rosterData = await rosterRes.json();

    const groups = rosterData?.athletes || [];
    const allAthletes = [];
    for (const group of groups) {
      for (const item of (group.items || [])) {
        const ath = item.athlete || item;
        if (ath?.id && ath?.displayName) {
          allAthletes.push({
            id: ath.id,
            name: ath.displayName,
            pos: ath.position?.abbreviation || group.position || "",
            jersey: ath.jersey || "",
          });
        }
      }
    }

    // Try season types in order: 2 (regular), 3 (postseason), 1 (preseason)
    // Try current year first, then prior year (for offseason sports like NFL)
    const yearsToTry = [currentYear, currentYear - 1];
    const typesToTry = [2, 3, 1];

    const topAthletes = allAthletes.slice(0, 10);
    const players = [];

    for (const ath of topAthletes) {
      let statLines = [];

      outerLoop:
      for (const year of yearsToTry) {
        for (const type of typesToTry) {
          try {
            const url = `${CORE}/sports/${sport}/leagues/${league}/seasons/${year}/types/${type}/athletes/${ath.id}/statistics/0`;
            const r = await fetch(url, { headers: { Accept: "application/json" } });
            if (!r.ok) continue;
            const statData = await r.json();
            const categories = statData?.splits?.categories || [];

            for (const cat of categories) {
              for (const stat of (cat.stats || [])) {
                if (!stat.displayValue || stat.displayValue === "0" || stat.displayValue === "--" || stat.displayValue === "0.0") continue;
                const label = stat.shortDisplayName || stat.abbreviation || stat.name;
                const value = stat.displayValue;
                if (label && value && statLines.length < 4) {
                  statLines.push({ l: label, v: value });
                }
              }
              if (statLines.length >= 4) break;
            }

            if (statLines.length > 0) break outerLoop; // found stats, stop trying
          } catch {}
        }
      }

      if (statLines.length > 0) {
        players.push({ ...ath, stats: statLines });
      }
      if (players.length >= 5) break;
    }

    res.json({ players, _rosterCount: allAthletes.length });
  } catch (e) {
    res.status(500).json({ error: e.message, players: [] });
  }
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
