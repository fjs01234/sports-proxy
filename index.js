const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const ESPN  = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN2 = "https://site.web.api.espn.com/apis/v2/sports";

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "Sports proxy live" }));

// Team info + record + roster leaders
app.get("/team/:sport/:league/:id", async (req, res) => {
  const { sport, league, id } = req.params;
  try {
    const r = await fetch(`${ESPN}/${sport}/${league}/teams/${id}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scoreboard
app.get("/scoreboard/:sport/:league", async (req, res) => {
  const { sport, league } = req.params;
  try {
    const r = await fetch(`${ESPN}/${sport}/${league}/scoreboard`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Standings
app.get("/standings/:sport/:league", async (req, res) => {
  const { sport, league } = req.params;
  try {
    const r = await fetch(`${ESPN2}/${sport}/${league}/standings`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team roster leaders (top scorers etc)
app.get("/leaders/:sport/:league", async (req, res) => {
  const { sport, league } = req.params;
  try {
    const r = await fetch(`${ESPN}/${sport}/${league}/leaders`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team schedule (recent + upcoming)
app.get("/schedule/:sport/:league/:id", async (req, res) => {
  const { sport, league, id } = req.params;
  try {
    const r = await fetch(`${ESPN}/${sport}/${league}/teams/${id}/schedule`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sports proxy running on port ${PORT}`));
