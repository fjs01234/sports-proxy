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

// Player stats — handles offseason, playoffs, and position diversity
app.get("/players/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const currentYear = new Date().getFullYear();

  try {
    const rosterRes = await fetch(`${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`, { headers: { Accept: "application/json" } });
    const rosterData = await rosterRes.json();

    const groups = rosterData?.athletes || [];

    // Sample athletes from EACH position group to get diverse roster coverage
    // (avoids all-pitcher problem for MLB, all-OL for NFL, etc.)
    const allAthletes = [];
    for (const group of groups) {
      const items = group.items || [];
      const groupPos = group.position || "";
      // Take up to 3 from each group to ensure diversity
      let taken = 0;
      for (const item of items) {
        const ath = item.athlete || item;
        if (ath?.id && ath?.displayName) {
          allAthletes.push({
            id: ath.id,
            name: ath.displayName,
            pos: ath.position?.abbreviation || groupPos,
            jersey: ath.jersey || "",
            groupOrder: groups.indexOf(group), // preserve group priority
          });
          taken++;
          if (taken >= 3) break;
        }
      }
    }

    // For MLB specifically, prioritize hitters (non-pitchers) first
    let orderedAthletes = allAthletes;
    if (league === "mlb") {
      const hitters = allAthletes.filter(a => !["SP","RP","P","CL"].includes(a.pos));
      const pitchers = allAthletes.filter(a => ["SP","RP","P","CL"].includes(a.pos));
      orderedAthletes = [...hitters, ...pitchers];
    }

    // Try season types: for active NBA/NHL playoffs try type 3 first, otherwise type 2 first
    const isPlayoffSport = ["basketball", "hockey"].includes(sport);
    const typesToTry = isPlayoffSport ? [3, 2, 1] : [2, 3, 1];
    const yearsToTry = [currentYear, currentYear - 1];

    const candidates = orderedAthletes.slice(0, 15); // wider net
    const players = [];

    for (const ath of candidates) {
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
                const v = stat.displayValue;
                if (!v || v === "0" || v === "--" || v === "0.0" || v === "0.00") continue;
                const label = stat.shortDisplayName || stat.abbreviation || stat.name;
                if (label && statLines.length < 4) {
                  statLines.push({ l: label, v });
                }
              }
              if (statLines.length >= 4) break;
            }
            if (statLines.length > 0) break outerLoop;
          } catch {}
        }
      }

      if (statLines.length > 0) {
        players.push({ ...ath, stats: statLines });
      }
      if (players.length >= 6) break;
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
