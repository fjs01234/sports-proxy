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
                const num = parseFloat(v);
                // Skip: zero, missing, negative, or clearly useless stats
                if (!v || ["0","--","0.0","0.00"].includes(v)) continue;
                if (!isNaN(num) && num < 0) continue;
                allStats.push({ l: stat.shortDisplayName||stat.abbreviation||stat.name, v, name: stat.name, cat: cat.name });
              }
            }
            if (allStats.length === 0) continue;

            const find = (...names) => allStats.find(s => names.includes(s.name) || names.includes(s.l));
            let lines = [];

            if (sport === "basketball") {
              const pts = find("avgPoints","pointsPerGame");
              const reb = find("avgRebounds","reboundsPerGame");
              const ast = find("avgAssists","assistsPerGame");
              const fg  = find("fieldGoalPct");
              if (pts) lines.push({l:"PPG", v:pts.v});
              if (reb) lines.push({l:"RPG", v:reb.v});
              if (ast) lines.push({l:"APG", v:ast.v});
              if (fg)  lines.push({l:"FG%", v:fg.v});

            } else if (sport === "baseball") {
              const isP = ["SP","RP","P","CL","MR"].includes(ath.pos);
              if (isP) {
                const era = find("ERA","earnedRunAverage","era");
                const w   = find("wins","W");
                const so  = find("strikeouts","SO");
                const whip= find("WHIP","walksAndHitsPerInningPitched");
                if (era) lines.push({l:"ERA", v:era.v});
                if (w)   lines.push({l:"W",   v:w.v});
                if (so)  lines.push({l:"K",   v:so.v});
                if (whip)lines.push({l:"WHIP",v:whip.v});
              } else {
                const avg = find("avg","battingAverage","AVG");
                const hr  = find("homeRuns","HR");
                const rbi = find("RBIs","RBI","runsBattedIn");
                const ops = find("OPS","onBasePlusSlugging");
                if (avg) lines.push({l:"AVG", v:avg.v});
                if (hr)  lines.push({l:"HR",  v:hr.v});
                if (rbi) lines.push({l:"RBI", v:rbi.v});
                if (ops) lines.push({l:"OPS", v:ops.v});
              }

            } else if (sport === "football") {
              const pos = ath.pos;
              if (["QB"].includes(pos)) {
                const pyds = find("passingYards","netPassingYards");
                const ptd  = find("passingTouchdowns");
                const cmp  = find("completionPct","completionPercentage");
                const rate = find("QBRating","passerRating");
                if (pyds) lines.push({l:"PYDS", v:pyds.v});
                if (ptd)  lines.push({l:"PTD",  v:ptd.v});
                if (cmp)  lines.push({l:"CMP%", v:cmp.v});
                if (rate) lines.push({l:"RTG",  v:rate.v});
              } else if (["RB","FB"].includes(pos)) {
                const ryds = find("rushingYards");
                const rtd  = find("rushingTouchdowns");
                const ypc  = find("yardsPerRushAttempt","rushingYardsPerCarry");
                const rec  = find("receptions");
                if (ryds) lines.push({l:"RYDS", v:ryds.v});
                if (rtd)  lines.push({l:"RTD",  v:rtd.v});
                if (ypc)  lines.push({l:"YPC",  v:ypc.v});
                if (rec)  lines.push({l:"REC",  v:rec.v});
              } else if (["WR","TE"].includes(pos)) {
                const rec  = find("receptions");
                const reyds= find("receivingYards");
                const retd = find("receivingTouchdowns");
                const ypr  = find("yardsPerReception","receivingYardsPerReception");
                if (rec)   lines.push({l:"REC",   v:rec.v});
                if (reyds) lines.push({l:"REYDS", v:reyds.v});
                if (retd)  lines.push({l:"RETD",  v:retd.v});
                if (ypr)   lines.push({l:"YPR",   v:ypr.v});
              } else if (["DE","DT","LB","OLB","ILB","MLB"].includes(pos)) {
                const sacks = find("sacks");
                const tkl   = find("totalTackles","tackles");
                const tfl   = find("tacklesForLoss");
                const ff    = find("forcedFumbles");
                if (sacks) lines.push({l:"SACKS",v:sacks.v});
                if (tkl)   lines.push({l:"TKL",  v:tkl.v});
                if (tfl)   lines.push({l:"TFL",  v:tfl.v});
                if (ff)    lines.push({l:"FF",    v:ff.v});
              } else if (["CB","S","FS","SS"].includes(pos)) {
                const int  = find("interceptions","defensiveInterceptions");
                const pd   = find("passesDefended");
                const tkl  = find("totalTackles","tackles");
                if (int) lines.push({l:"INT", v:int.v});
                if (pd)  lines.push({l:"PD",  v:pd.v});
                if (tkl) lines.push({l:"TKL", v:tkl.v});
              }
              // Skip OL, K, P, LS — they don't have meaningful displayable stats

            } else if (sport === "hockey") {
              const isG = ath.pos === "G";
              if (isG) {
                const sv  = find("savePct","savePercentage","SV%");
                const gaa = find("goalsAgainstAverage","GAA");
                const w   = find("wins","W");
                if (sv)  lines.push({l:"SV%", v:sv.v});
                if (gaa) lines.push({l:"GAA", v:gaa.v});
                if (w)   lines.push({l:"W",   v:w.v});
              } else {
                const g   = find("goals","G");
                const a   = find("assists","A");
                const pts = find("points","PTS");
                const pm  = find("plusMinus");
                if (g)   lines.push({l:"G",   v:g.v});
                if (a)   lines.push({l:"A",   v:a.v});
                if (pts) lines.push({l:"PTS", v:pts.v});
                if (pm && parseFloat(pm.v) > 0) lines.push({l:"+/-", v:pm.v});
              }
            }

            // Skip players with no meaningful stats (e.g. OL in NFL)
            if (lines.length === 0) return null;
            return { ...ath, stats: lines.slice(0,4) };
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
    const r = await fetch(`${SITE}/sports/${sport}/${league}/news?team=${teamId}&limit=10`, { headers: { Accept: "application/json" } });
    const data = await r.json();
    // Enrich articles with parsed published date and type info, pass through fully
    const articles = (data.articles || []).map(a => ({
      ...a,
      _published: a.published || a.lastModified || null,
      _type: a.type || a.categories?.[0]?.description || "unknown",
      _isPreview: /preview|matchup|vs\.|projections|odds|betting|how to watch|keys to|play to determine|series winner|series finale|series opener|starting lineup|pitching matchup/i.test(a.headline || "") || /^[\w ]+ vs\.? [\w ]+$/i.test((a.headline || "").trim()),
      _isRecap: /recap|final score|highlights|game wrap|series win|clinch|wins|beats|defeats|shutout|walk.off|homer|home run|rbi|goes \d-for|hit game|no-hitter|comeback|took the series/i.test(a.headline || ""),
    }));
    res.json({ ...data, articles });
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

// Debug: dump raw boxscore.teams stat keys for a completed game
app.get("/boxdebug/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  try {
    const dates = [
      (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
      (() => { const d=new Date(); d.setDate(d.getDate()-2); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
    ];
    let gameId = null;
    for (const date of dates) {
      const sb = await fetch(`${SITE}/sports/${sport}/${league}/scoreboard?dates=${date}`, { headers: { Accept: "application/json" } }).catch(()=>null);
      if (!sb?.ok) continue;
      const sbData = await sb.json();
      for (const ev of (sbData?.events || [])) {
        const comp = ev.competitions?.[0];
        const involved = comp?.competitors?.some(c => String(c.team?.id) === String(teamId));
        if (involved && ev.status?.type?.completed) { gameId = ev.id; break; }
      }
      if (gameId) break;
    }
    if (!gameId) return res.json({ error: "no completed game found" });
    const sumRes = await fetch(`${SITE}/sports/${sport}/${league}/summary?event=${gameId}`, { headers: { Accept: "application/json" } });
    const sum = await sumRes.json();
    const teams = sum?.boxscore?.teams || [];
    const debug = teams.map(t => ({
      abbr: t?.team?.abbreviation,
      statKeys: (t?.statistics || []).map(s => ({ name: s.name, abbr: s.abbreviation, label: s.label, displayValue: s.displayValue, value: s.value }))
    }));
    res.json({ gameId, teamsCount: teams.length, debug });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// Game summary / highlights for a team's last COMPLETED game
app.get("/lastsummary/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  try {
    // Try current scoreboard first, then yesterday's
    const dates = [null, (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10).replace(/-/g,""); })(), (() => { const d=new Date(); d.setDate(d.getDate()-2); return d.toISOString().slice(0,10).replace(/-/g,""); })()];
    
    let gameId = null;
    let foundEvent = null;

    for (const date of dates) {
      const url = date
        ? `${SITE}/sports/${sport}/${league}/scoreboard?dates=${date}`
        : `${SITE}/sports/${sport}/${league}/scoreboard`;
      const sb = await fetch(url, { headers: { Accept: "application/json" } }).catch(()=>null);
      if (!sb?.ok) continue;
      const sbData = await sb.json();
      
      for (const ev of (sbData?.events || [])) {
        const comp = ev.competitions?.[0];
        const involved = comp?.competitors?.some(c => String(c.team?.id) === String(teamId));
        if (!involved) continue;
        const completed = ev.status?.type?.completed;
        if (completed) { gameId = ev.id; foundEvent = ev; break; }
      }
      if (gameId) break;
    }

    if (!gameId) return res.json({ highlights: [], keyMoments: [], status: "no_completed_game" });

    // Fetch game summary
    const sum = await fetch(`${SITE}/sports/${sport}/${league}/summary?event=${gameId}`, { headers: { Accept: "application/json" } });
    const sumData = await sum.json();

    // Try keyMoments / story first (ESPN's curated highlights)
    const keyMoments = (sumData?.keyMoments || sumData?.story || [])
      .slice(0, 5)
      .map(m => m?.text || m?.description || m?.headline || "")
      .filter(Boolean);

    // Fallback: scoring plays from play-by-play
    const highlights = [];
    for (const play of (sumData?.plays || [])) {
      if (!play?.scoringPlay && !play?.text?.match(/touchdown|home run|goal|score|three|slam|dunk/i)) continue;
      const text = play?.text || play?.alternativeText || "";
      if (text && highlights.length < 5) highlights.push({ text, score: play?.homeScore !== undefined ? `${play.homeScore}–${play.awayScore}` : null });
    }

    res.json({ highlights, keyMoments, status: "final", gameId });
  } catch (e) {
    res.status(500).json({ error: e.message, highlights: [], keyMoments: [] });
  }
});

// Full game boxscore + leaders for last completed game
app.get("/gamedetail/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  try {
    // Find last completed game for this team
    const dates = [
      null,
      (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
      (() => { const d=new Date(); d.setDate(d.getDate()-2); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
      (() => { const d=new Date(); d.setDate(d.getDate()-3); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
    ];

    let gameId = null;
    let gameEvent = null;

    for (const date of dates) {
      const url = date
        ? `${SITE}/sports/${sport}/${league}/scoreboard?dates=${date}`
        : `${SITE}/sports/${sport}/${league}/scoreboard`;
      const sb = await fetch(url, { headers: { Accept: "application/json" } }).catch(()=>null);
      if (!sb?.ok) continue;
      const sbData = await sb.json();
      for (const ev of (sbData?.events || [])) {
        const comp = ev.competitions?.[0];
        const involved = comp?.competitors?.some(c => String(c.team?.id) === String(teamId));
        if (!involved) continue;
        if (ev.status?.type?.completed) { gameId = ev.id; gameEvent = ev; break; }
      }
      if (gameId) break;
    }

    if (!gameId) return res.json({ found: false });

    // Fetch full summary
    const sumRes = await fetch(`${SITE}/sports/${sport}/${league}/summary?event=${gameId}`, { headers: { Accept: "application/json" } });
    const sum = await sumRes.json();

    // Extract boxscore
    const boxscore = sum?.boxscore || {};

    // R/H/E: read from the home/away competitor scores + hits/errors from boxscore.teams statistics
    // ESPN stores R as the competitor score; H and E are in boxscore.teams[].statistics
    const teamRHE = {};

    // Get R directly from the scoreboard competitor scores we already have
    const homeAbbr = comp?.competitors?.find(c => c.homeAway === "home")?.team?.abbreviation;
    const awayAbbr = comp?.competitors?.find(c => c.homeAway === "away")?.team?.abbreviation;
    const homeScore = comp?.competitors?.find(c => c.homeAway === "home")?.score;
    const awayScore = comp?.competitors?.find(c => c.homeAway === "away")?.score;
    if (homeAbbr) teamRHE[homeAbbr] = { R: homeScore ?? "?", H: "?", E: "0" };
    if (awayAbbr) teamRHE[awayAbbr] = { R: awayScore ?? "?", H: "?", E: "0" };

    // Get H and E from boxscore.teams[].statistics totals
    for (const tb of (boxscore?.teams || [])) {
      const abbr = tb?.team?.abbreviation || "";
      if (!teamRHE[abbr]) teamRHE[abbr] = { R: "?", H: "?", E: "0" };
      for (const grp of (tb?.statistics || [])) {
        const keys = grp?.keys || [];
        // totals is a parallel array to keys with team aggregate values
        const totals = grp?.totals || [];
        if (!totals.length) continue;
        const statMap = {};
        keys.forEach((k, i) => { if (totals[i] != null) statMap[k] = totals[i]; });
        if (grp.name === "batting") {
          if (statMap["H"]) teamRHE[abbr].H = statMap["H"];
          if (statMap["R"]) teamRHE[abbr].R = statMap["R"]; // override with actual runs
        }
        if (grp.name === "fielding") {
          if (statMap["E"] != null) teamRHE[abbr].E = statMap["E"];
        }
      }
    }

    // Athletes: boxscore.players[] keyed by team
    const players = boxscore?.players || [];
    const teamStats = [];

    for (const teamBlock of players) {
      const tName = teamBlock?.team?.displayName || "";
      const tAbbr = teamBlock?.team?.abbreviation || "";
      const isNYM = tAbbr === "NYM" || String(teamBlock?.team?.id) === String(teamId);
      const rhe = teamRHE[tAbbr] || { R:"?", H:"?", E:"0" };
      const hitters = [];
      const pitchers = [];

      for (const statGroup of (teamBlock?.statistics || [])) {
        const type = (statGroup?.name || "").toLowerCase();
        const keys = statGroup?.keys || [];
        for (const ath of (statGroup?.athletes || [])) {
          const name = ath?.athlete?.displayName || "";
          const vals = ath?.stats || [];
          if (!name || !vals.length) continue;
          const statMap = {};
          keys.forEach((k, i) => { if (vals[i] != null && vals[i] !== "--") statMap[k] = vals[i]; });

          if (type === "batting") {
            const ab  = statMap["AB"];
            const h   = statMap["H"];
            const hr  = statMap["HR"];
            const rbi = statMap["RBI"];
            const bb  = statMap["BB"];
            if (ab != null || h != null) {
              let line = `${name}`;
              if (h != null && ab != null) line += ` ${h}-${ab}`;
              if (hr && hr !== "0") line += `, ${hr} HR`;
              if (rbi && rbi !== "0") line += `, ${rbi} RBI`;
              if (bb && bb !== "0") line += `, BB`;
              hitters.push({ name, line });
            }
          } else if (type === "pitching") {
            const ip  = statMap["IP"];
            const er  = statMap["ER"];
            const so  = statMap["K"] || statMap["SO"];
            const bb  = statMap["BB"];
            const dec = ath?.athlete?.note || "";
            if (ip) {
              let line = `${name}: ${ip} IP`;
              if (er != null && er !== "--") line += `, ${er} ER`;
              if (so && so !== "0") line += `, ${so} K`;
              if (bb && bb !== "0") line += `, ${bb} BB`;
              if (dec) line += ` (${dec})`;
              pitchers.push({ name, line });
            }
          }
        }
      }
      teamStats.push({ tName, tAbbr, isNYM, hitters, pitchers, R: rhe.R, H: rhe.H, E: rhe.E });
    }

    // Key moments and scoring plays
    const keyMoments = (sum?.keyMoments || sum?.story || [])
      .slice(0, 5).map(m => m?.text || m?.description || "").filter(Boolean);

    // Scoring plays from play by play
    const scoringPlays = (sum?.plays || [])
      .filter(p => p?.scoringPlay)
      .slice(0, 8)
      .map(p => ({ text: p?.text || "", score: p?.homeScore !== undefined ? `${p.awayScore}-${p.homeScore}` : "" }));

    // Game info
    const comp = gameEvent?.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === "home");
    const away = comp?.competitors?.find(c => c.homeAway === "away");
    const venue = comp?.venue?.fullName || "";
    const attendance = comp?.attendance || "";
    const gameDate = gameEvent?.date || "";

    res.json({
      found: true, gameId,
      home: { name: home?.team?.displayName, abbr: home?.team?.abbreviation, score: home?.score },
      away: { name: away?.team?.displayName, abbr: away?.team?.abbreviation, score: away?.score },
      venue, attendance, gameDate,
      teamStats, keyMoments, scoringPlays,
      status: gameEvent?.status?.type?.description || "Final"
    });

  } catch(e) {
    res.status(500).json({ error: e.message, found: false });
  }
});
