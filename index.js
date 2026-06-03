const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

app.get("/", (req, res) => res.json({ status: "ok" }));

// Generic ESPN proxy
app.get("/espn", async (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: "missing path" });
  // Request extra fields ESPN hides by default
  const url = `https://site.api.espn.com/apis/site/v2/${path}`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team detail — explicitly request coaches, venue, record
app.get("/team/:sport/:league/:id", async (req, res) => {
  const { sport, league, id } = req.params;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${id}?enable=coaches,roster,stats,record`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ESPN news for a team
app.get("/news/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/news?team=${teamId}&limit=6`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Roster with stats — separate endpoint
app.get("/roster/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/roster`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scoreboard
app.get("/scoreboard/:sport/:league", async (req, res) => {
  const { sport, league } = req.params;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`proxy running on ${PORT}`));
