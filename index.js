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

// Team stats — v2stats confirmed working, returns results.stats.categories
app.get("/teamstats/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;

  // v2 team statistics — confirmed working from diagnostic
  // path: results.stats.categories (NBA/NFL) or results.splits.categories (MLB)
  try {
    const url = `${SITE}/sports/${sport}/${league}/teams/${teamId}/statistics`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const data = await r.json();
      const cats = data?.results?.stats?.categories
               || data?.results?.splits?.categories
               || data?.splits?.categories
               || [];
      const season = data?.season?.year || data?.requestedSeason?.year || null;
      if (cats.length > 0) {
        return res.json({ categories: cats, season, leaders: [], format: "categories" });
      }
    }
  } catch {}

  // Fallback: v3 leaders — leaders is an OBJECT keyed by category
  try {
    const url = `${SITEV3}/sports/${sport}/${league}/leaders`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const data = await r.json();
      const leadersObj = data?.leaders || {};
      const leaderCats = Array.isArray(leadersObj) ? leadersObj : Object.values(leadersObj);
      const teamLeaders = [];
      for (const cat of leaderCats) {
        const catName = cat.shortDisplayName || cat.displayName || cat.name || "";
        const entries = Array.isArray(cat.leaders) ? cat.leaders : Object.values(cat.leaders || {});
        for (const entry of entries) {
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
        return res.json({ leaders: teamLeaders, categories: [], season: data?.currentSeason?.year || null, format: "leaders" });
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
            const allStats = [];
            for (const cat of (data?.splits?.categories || [])) {
              for (const stat of (cat.stats || [])) {
                const v = stat.displayValue;
                if (!v || ["0","--","0.0","0.00"].includes(v)) continue;
                allStats.push({ l: stat.shortDisplayName||stat.abbreviation||stat.name, v, name: stat.name, cat: cat.name });
              }
            }
            if (allStats.length === 0) continue;

            // Pick the most meaningful stats per sport
            let lines = [];
            const find = (...names) => allStats.find(s => names.includes(s.name) || names.includes(s.l));

            if (sport === "basketball") {
              const pts = find("avgPoints","PPG","points");
              const reb = find("avgRebounds","RPG","rebounds","totalRebounds");
              const ast = find("avgAssists","APG","assists");
              const fg  = find("fieldGoalPct","FG%","fieldGoals");
              if (pts) lines.push({l:"PPG", v: pts.v});
              if (reb) lines.push({l:"RPG", v: reb.v});
              if (ast) lines.push({l:"APG", v: ast.v});
              if (fg)  lines.push({l:"FG%", v: fg.v});
            } else if (sport === "baseball") {
              const avg = find("avg","AVG","battingAverage");
              const hr  = find("homeRuns","HR");
              const rbi = find("RBIs","RBI","runsBattedIn");
              const ops = find("OPS","ops","onBasePlusSlugging");
              const era = find("ERA","era","earnedRunAvg");
              const so  = find("strikeouts","SO","K");
              const w   = find("wins","W");
              if (avg) lines.push({l:"AVG", v: avg.v});
              if (hr)  lines.push({l:"HR",  v: hr.v});
              if (rbi) lines.push({l:"RBI", v: rbi.v});
              if (ops) lines.push({l:"OPS", v: ops.v});
              if (era) lines.push({l:"ERA", v: era.v});
              if (so&&!avg)  lines.push({l:"K",  v: so.v});
              if (w&&!avg)   lines.push({l:"W",  v: w.v});
            } else if (sport === "football") {
              const pyds = find("passingYards","PYDS","passYards");
              const ptd  = find("passingTouchdowns","PTD","passTD");
              const ryds = find("rushingYards","RYDS","rushYards");
              const rtd  = find("rushingTouchdowns","RTD");
              const rec  = find("receptions","REC");
              const reyds= find("receivingYards","REYDS","recYards");
              if (pyds) lines.push({l:"PYDS",v:pyds.v});
              if (ptd)  lines.push({l:"PTD", v:ptd.v});
              if (ryds) lines.push({l:"RYDS",v:ryds.v});
              if (rtd)  lines.push({l:"RTD", v:rtd.v});
              if (rec)  lines.push({l:"REC", v:rec.v});
              if (reyds)lines.push({l:"REYDS",v:reyds.v});
            } else if (sport === "hockey") {
              const g   = find("goals","G");
              const a   = find("assists","A");
              const pts = find("points","PTS","totalPoints");
              const sv  = find("savePct","SV%","savePercentage");
              const gaa = find("goalsAgainstAverage","GAA");
              if (g)   lines.push({l:"G",  v:g.v});
              if (a)   lines.push({l:"A",  v:a.v});
              if (pts) lines.push({l:"PTS",v:pts.v});
              if (sv)  lines.push({l:"SV%",v:sv.v});
              if (gaa) lines.push({l:"GAA",v:gaa.v});
            }

            // Fallback: just take first 4 non-zero stats if sport-specific picks got nothing
            if (lines.length === 0) lines = allStats.slice(0, 4);
            if (lines.length > 0) return { ...ath, stats: lines.slice(0,4) };
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

// TEMP: expose raw v3 leaders and v2stats for one team so we can see full structure
app.get("/rawcheck/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  const results = {};
  
  // v3 leaders - show first 2 leader entries fully
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v3/sports/${sport}/${league}/leaders`, { headers: {Accept:"application/json"} });
    const d = await r.json();
    const leaders = d?.leaders || [];
    results.v3_total_cats = leaders.length;
    results.v3_first_cat = leaders[0] ? {
      name: leaders[0].displayName || leaders[0].name,
      entryCount: (leaders[0].leaders||[]).length,
      firstEntry: JSON.stringify(leaders[0].leaders?.[0]).slice(0,400),
      secondEntry: JSON.stringify(leaders[0].leaders?.[1]).slice(0,400),
    } : null;
    // Search all entries for our team
    let found = 0;
    for (const cat of leaders) {
      for (const e of (cat.leaders||[])) {
        const tid = String(e.team?.id || e.athlete?.team?.id || "");
        if (tid === String(teamId)) found++;
      }
    }
    results.v3_entries_matching_team = found;
  } catch(e) { results.v3_error = e.message; }

  // v2stats - show full results structure  
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/statistics`, { headers: {Accept:"application/json"} });
    const d = await r.json();
    results.v2_topKeys = Object.keys(d);
    results.v2_results_keys = d.results ? Object.keys(d.results) : null;
    results.v2_results_stats_keys = d.results?.stats ? Object.keys(d.results.stats) : null;
    results.v2_splits_path = JSON.stringify(d.results?.stats?.splits || d.results?.splits || d.splits || "none").slice(0,500);
  } catch(e) { results.v2_error = e.message; }
  
  res.json(results);
});
