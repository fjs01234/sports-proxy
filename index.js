const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

// Team info + record
app.get("/team/:sport/:league/:id", async (req, res) => {
  const { sport, league, id } = req.params;
  try {
    const r = await fetch(`${ESPN}/${sport}/${league}/teams/${id}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scoreboard (recent games)
app.get("/scoreboard/:sport/:league", async (req, res) => {
  const { sport, league } = req.params;
  try {
    const r = await fetch(`${ESPN}/${sport}/${league}/scoreboard`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Standings
app.get("/standings/:sport/:league", async (req, res) => {
  const { sport, league } = req.params;
  try {
    const r = await fetch(`https://site.web.api.espn.com/apis/v2/sports/${sport}/${league}/standings`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "Sports proxy running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sports proxy running on port ${PORT}`));
