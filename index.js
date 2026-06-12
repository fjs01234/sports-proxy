const express = require("express"); // redeploy trigger
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
    // Show players[] structure - where actual athlete data lives
    const players = sum?.boxscore?.players || [];
    const debug = players.map(t => ({
      abbr: t?.team?.abbreviation,
      statGroups: (t?.statistics || []).map(s => ({
        name: s.name,
        keys: s.keys?.slice(0,10),
        firstAthlete: s.athletes?.[0] ? {
          name: s.athletes[0]?.athlete?.displayName,
          stats: s.athletes[0]?.stats?.slice(0,10)
        } : null,
        lastAthlete: s.athletes?.length > 1 ? {
          name: s.athletes[s.athletes.length-1]?.athlete?.displayName,
          stats: s.athletes[s.athletes.length-1]?.stats?.slice(0,10)
        } : null
      }))
    }));
    res.json({ gameId, teamsCount: teams.length, playersCount: players.length, debug });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Game summary by event ID
app.get("/summary/:sport/:league/:gameId", async (req, res) => {
  const { sport, league, gameId } = req.params;
  try {
    const r = await fetch(`${SITE}/sports/${sport}/${league}/summary?event=${gameId}`, { headers: { Accept: "application/json" } });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Team injuries -- ESPN core API with $ref expansion
app.get("/injuries/:sport/:league/:teamId", async (req, res) => {
  const { sport, league, teamId } = req.params;
  try {
    // Core API returns paginated items with $ref links
    const url = `${CORE}/sports/${sport}/leagues/${league}/teams/${teamId}/injuries?limit=25`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return res.json({ found: false, injuries: [], status: r.status });
    const d = await r.json();

    const rawItems = d?.items || [];
    const injuries = [];

    for (const item of rawItems) {
      let injData = item;
      // If just a $ref, fetch the full object
      if (item?.$ref && !item?.athlete) {
        try {
          const ref = await fetch(item.$ref, { headers: { Accept: "application/json" } });
          if (ref.ok) injData = await ref.json();
        } catch {}
      }
      const ath = injData?.athlete || injData;
      // Athlete may also be a $ref
      let athData = ath;
      if (ath?.$ref && !ath?.displayName) {
        try {
          const ref = await fetch(ath.$ref, { headers: { Accept: "application/json" } });
          if (ref.ok) athData = await ref.json();
        } catch {}
      }
      const name = athData?.displayName || athData?.shortName || "";
      const pos  = athData?.position?.abbreviation || "";
      const status = injData?.status || injData?.type?.description || "";
      const detail = injData?.details?.detail || injData?.longComment || injData?.shortComment || "";
      if (name) injuries.push({ name, pos, status, detail });
    }

    // Fallback: try site API if core returned nothing
    if (!injuries.length) {
      const r2 = await fetch(`${SITE}/sports/${sport}/${league}/teams/${teamId}/injuries`, { headers: { Accept: "application/json" } });
      if (r2.ok) {
        const d2 = await r2.json();
        const raw2 = d2?.injuries || d2?.items || [];
        for (const i of raw2) {
          const ath = i?.athlete || i;
          const name = ath?.displayName || ath?.shortName || "";
          const status = i?.status || "";
          const detail = i?.details?.detail || i?.longComment || "";
          if (name) injuries.push({ name, status, detail, pos: ath?.position?.abbreviation || "" });
        }
      }
    }

    res.json({ found: true, injuries, count: d?.count || 0, rawCount: rawItems.length });
  } catch(e) {
    res.status(500).json({ error: e.message, found: false, injuries: [] });
  }
});


// MLB injury page - fetch with browser-like headers
app.get("/mlbinjuries/:teamSlug", async (req, res) => {
  const { teamSlug } = req.params;
  try {
    const url = `https://www.mlb.com/news/${teamSlug}-injuries-and-roster-moves`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Referer": "https://www.google.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site"
      }
    });

    if (!r.ok) return res.json({ found: false, injuries: [], transactions: [], status: r.status });
    const html = await r.text();

    // Normalize HTML to text
    const normalized = html
      .replace(/<strong>/gi, '**').replace(/<\/strong>/gi, '**')
      .replace(/<br[^>]*>/gi, ' ')
      .replace(/<\/p>/gi, ' ').replace(/<\/li>/gi, ' ')
      .replace(/<\/div>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/[ 	]{2,}/g, ' ');

    const injuries = [];
    const transactions = [];

    // Find injury section
    const injStart = normalized.search(/LATEST INJURIES/i);
    const txStart  = normalized.search(/LATEST TRANSACTIONS/i);
    const injText  = injStart >= 0
      ? normalized.slice(injStart, txStart > injStart ? txStart : injStart + 6000)
      : '';

    // Parse injury blocks -- each starts with a position abbreviation + name
    const injLines = injText.split('\n').map(l => l.trim()).filter(Boolean);
    let current = null;
    for (const line of injLines) {
      const posName = line.match(/^(RHP|LHP|SP|RP|C|1B|2B|3B|SS|OF|IF|DH|INF)\s+(.+)/);
      if (posName) {
        if (current?.name && current?.injury) injuries.push(current);
        current = { pos: posName[1], name: posName[2].trim(), injury: '', expectedReturn: 'TBD' };
        continue;
      }
      if (!current) continue;
      const injM = line.match(/\*\*Injury:\*\*\s*(.+)/i) || line.match(/^Injury:\s*(.+)/i);
      const retM = line.match(/\*\*Expected return:\*\*\s*(.+)/i) || line.match(/^Expected return:\s*(.+)/i);
      if (injM) current.injury = injM[1].replace(/\*+/g,'').trim();
      if (retM) current.expectedReturn = retM[1].replace(/\*+/g,'').trim();
    }
    if (current?.name && current?.injury) injuries.push(current);

    // Parse transactions
    const txText = txStart >= 0 ? normalized.slice(txStart, txStart + 3000) : '';
    const txLines = txText.split('\n').map(l => l.trim()).filter(Boolean);
    let currentDate = '';
    for (const line of txLines) {
      const dateM = line.match(/^\*\*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+)\*\*$/)
                 || line.match(/^((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+)$/);
      if (dateM) { currentDate = dateM[1]; continue; }
      if (currentDate && (line.startsWith('•') || line.startsWith('-') || /^[A-Z]{1,3}\s/.test(line))) {
        const clean = line.replace(/^[•\-\s]+/, '').replace(/\*+/g, '').trim();
        if (clean.length > 5) transactions.push({ date: currentDate, move: clean });
      }
    }

    res.json({ found: true, injuries, transactions });
  } catch(e) {
    res.status(500).json({ error: e.message, found: false, injuries: [], transactions: [] });
  }
});


// Debug: show raw MLB injury page
app.get("/mlbdebug", async (req, res) => {
  try {
    const r = await fetch("https://www.mlb.com/news/mets-injuries-and-roster-moves", { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" } });
    const html = await r.text();
    // Return first 3000 chars to inspect format
    const norm = html
      .replace(/<strong>/gi, '**').replace(/<\/strong>/gi, '**')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&nbsp;/g,' ')
      .replace(/[ \t]{2,}/g, ' ');
    const injIdx = norm.search(/LATEST INJURIES/i);
    const snippet = injIdx >= 0 ? norm.slice(injIdx, injIdx + 1500) : norm.slice(0, 1500);
    res.json({ status: r.status, hasInjuries: injIdx >= 0, snippet });
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
    const dates = [
      null,
      (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
      (() => { const d=new Date(); d.setDate(d.getDate()-2); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
      (() => { const d=new Date(); d.setDate(d.getDate()-3); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
    ];

    let gameId = null, gameEvent = null;
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
        if (involved && ev.status?.type?.completed) { gameId = ev.id; gameEvent = ev; break; }
      }
      if (gameId) break;
    }
    if (!gameId) return res.json({ found: false });

    const sumRes = await fetch(`${SITE}/sports/${sport}/${league}/summary?event=${gameId}`, { headers: { Accept: "application/json" } });
    const sum = await sumRes.json();
    const boxscore = sum?.boxscore || {};
    const players  = boxscore?.players || [];

    // R/H/E from linescore
    const teamRHE = {};
    const lsTeams = sum?.linescore?.teams || [];
    for (const lt of lsTeams) {
      const abbr = lt?.team?.abbreviation || "";
      if (abbr) teamRHE[abbr] = { R: lt?.runs ?? "?", H: lt?.hits ?? "?", E: lt?.errors ?? "0" };
    }
    // Fallback R from competitor scores
    const compObj = gameEvent?.competitions?.[0];
    for (const competitor of (compObj?.competitors || [])) {
      const abbr = competitor?.team?.abbreviation || "";
      if (!abbr) continue;
      if (!teamRHE[abbr]) teamRHE[abbr] = { R: competitor.score ?? "?", H: "?", E: "0" };
      else if (teamRHE[abbr].R === "?") teamRHE[abbr].R = competitor.score ?? "?";
    }

    // Parse batting and pitching from boxscore.players[]
    const teamStats = [];
    for (const teamBlock of players) {
      const tName = teamBlock?.team?.displayName || "";
      const tAbbr = teamBlock?.team?.abbreviation || "";
      const isNYM = tAbbr === "NYM" || String(teamBlock?.team?.id) === String(teamId);
      const hitters = [], pitchers = [];

      for (const statGroup of (teamBlock?.statistics || [])) {
        // ESPN uses "type" not "name" for stat group identification
        const type = (statGroup?.type || statGroup?.name || "").toLowerCase();
        const keys = statGroup?.keys || [];
        const totals = statGroup?.totals || [];

        // R/H/E from totals array (parallel to keys)
        if (type === "batting" && totals.length) {
          const hIdx = keys.indexOf("hits");
          const rIdx = keys.indexOf("runs");
          if (hIdx >= 0 && totals[hIdx]) teamRHE[tAbbr].H = totals[hIdx];
          if (rIdx >= 0 && totals[rIdx] && teamRHE[tAbbr].R === "?") teamRHE[tAbbr].R = totals[rIdx];
        }

        for (const ath of (statGroup?.athletes || [])) {
          const name = ath?.athlete?.displayName || "";
          const vals = ath?.stats || [];
          if (!name || !vals.length) continue;
          const sm = {};
          keys.forEach((k, i) => { if (vals[i] != null && vals[i] !== "--") sm[k] = vals[i]; });

          if (type === "batting") {
            const hab = sm["hits-atBats"] || "";
            const hr  = sm["homeRuns"]; const rbi = sm["RBIs"]; const bb = sm["walks"];
            if (hab) {
              const habReadable = hab.replace(/^(\d+)-(\d+)$/, "$1 for $2");
              let line = `${name}: ${habReadable}`;
              if (hr && hr !== "0") line += `, ${hr === "1" ? "HR" : hr + " HR"}`;
              if (rbi && rbi !== "0") line += `, ${rbi} RBI`;
              if (bb && bb !== "0") line += `, BB`;
              hitters.push({ name, line });
            }
          } else if (type === "pitching") {
            const ip = sm["fullInnings.partInnings"];
            const er = sm["earnedRuns"]; const so = sm["strikeouts"];
            const bb = sm["walks"]; const era = sm["ERA"];
            const dec = ath?.athlete?.note || "";
            if (ip) {
              let line = `${name}: ${ip} IP`;
              if (er != null) line += `, ${er} ER`;
              if (so && so !== "0") line += `, ${so} K`;
              if (bb && bb !== "0") line += `, ${bb} BB`;
              if (era) line += ` (ERA: ${era})`;
              if (dec) line += ` [${dec}]`;
              pitchers.push({ name, line });
            }
          }
        }
      }

      const rhe = teamRHE[tAbbr] || { R:"?", H:"?", E:"0" };
      teamStats.push({ tName, tAbbr, isNYM, hitters, pitchers, R: rhe.R, H: rhe.H, E: rhe.E });
    }

    // If NYM pitchers still empty, try boxscore leaders
    const nym = teamStats.find(t => t.isNYM);
    if (nym && !nym.pitchers.length) {
      for (const leader of (boxscore?.leaders || [])) {
        for (const entry of (leader?.leaders || [])) {
          const athTeam = entry?.athlete?.team?.abbreviation;
          if (athTeam !== "NYM") continue;
          const name = entry?.athlete?.displayName || "";
          const val  = entry?.displayValue || "";
          if (name && val) nym.pitchers.push({ name, line: `${name}: ${val}` });
        }
      }
    }

    // Scoring plays
    const scoringPlays = (sum?.plays || [])
      .filter(p => p?.scoringPlay)
      .slice(0, 8)
      .map(p => ({ text: p?.text || "", score: p?.homeScore !== undefined ? `${p.awayScore}-${p.homeScore}` : "" }));

    const home = compObj?.competitors?.find(c => c.homeAway === "home");
    const away = compObj?.competitors?.find(c => c.homeAway === "away");

    res.json({
      found: true, gameId,
      home: { name: home?.team?.displayName, abbr: home?.team?.abbreviation, score: home?.score },
      away: { name: away?.team?.displayName, abbr: away?.team?.abbreviation, score: away?.score },
      venue: compObj?.venue?.fullName || "",
      attendance: compObj?.attendance || "",
      gameDate: gameEvent?.date || "",
      teamStats, scoringPlays,
      status: gameEvent?.status?.type?.description || "Final",
      _linescoreTeams: lsTeams.map(t => ({ abbr: t?.team?.abbreviation, R: t?.runs, H: t?.hits, E: t?.errors }))
    });

  } catch(e) {
    res.status(500).json({ error: e.message, found: false });
  }
});


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
    // Show players[] structure - where actual athlete data lives
    const players = sum?.boxscore?.players || [];
    const debug = players.map(t => ({
      abbr: t?.team?.abbreviation,
      statGroups: (t?.statistics || []).map(s => ({
        name: s.name,
        keys: s.keys?.slice(0,10),
        firstAthlete: s.athletes?.[0] ? {
          name: s.athletes[0]?.athlete?.displayName,
          stats: s.athletes[0]?.stats?.slice(0,10)
        } : null,
        lastAthlete: s.athletes?.length > 1 ? {
          name: s.athletes[s.athletes.length-1]?.athlete?.displayName,
          stats: s.athletes[s.athletes.length-1]?.stats?.slice(0,10)
        } : null
      }))
    }));
    res.json({ gameId, teamsCount: teams.length, playersCount: players.length, debug });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
