const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

app.get("/", (req, res) => res.json({ status: "ok", message: "Sports proxy live" }));

// Generic ESPN proxy — pass any ESPN URL path as query param
// e.g. /espn?path=sports/baseball/mlb/teams/21
app.get("/espn", async (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: "missing path param" });
  const url = `https://site.api.espn.com/apis/site/v2/${path}`;
  try {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, url });
  }
});

// Scoreboard
app.get("/espn2", async (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: "missing path param" });
  const url = `https://site.web.api.espn.com/apis/v2/${path}`;
  try {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, url });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sports proxy running on port ${PORT}`));
