const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const SITE = "https://site.api.espn.com/apis/site/v2";
const CORE = "https://sports.core.api.espn.com/v2";

app.get("/", (req, res) => res.json({ status: "ok" }));

// Generic site API proxy
app.get("/espn", async (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: "missing path" });
  try {
    const r = await fetch(`${SITE}/${path}`, { headers: { Accept: "application/json" } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team + coach combined
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Team statistics — the dedicated per-team stats endpoint
app.get("/stats/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const url = `${SITE}/sports/${sport}/${league}/teams/${teamId}/statistics`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Roster — names, positions, jersey numbers
app.get("/roster/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const url = `${SITE}/sports/${sport}/${league}/teams/${teamId}/roster`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
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
