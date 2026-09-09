const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const MAYHEM_QUEUE_ID = 2400;
const LIVE_HOST = '127.0.0.1';
const LIVE_PORT = 2999;

function normalizeName(value) {
  return String(value || '').normalize('NFKC').replace(/\s*#.*$/, '').trim().toLowerCase();
}

function parseLockfile(value) {
  const parts = String(value || '').trim().split(':');
  if (parts.length < 5) return null;
  const [processName, pid, port, password, protocol] = parts;
  if (!processName || !port || !password) return null;
  return { processName, pid: Number(pid), port: Number(port), password, protocol };
}

function firstBloodFromEvents(payload) {
  const events = payload?.Events || [];
  const firstBlood = events.find(event => event.EventName === 'FirstBlood');
  const firstKill = events.find(event => event.EventName === 'ChampionKill');
  if (!firstBlood && !firstKill) return null;
  return {
    killer: firstBlood?.Recipient || firstKill?.KillerName || 'Unknown',
    victim: firstKill?.VictimName || 'Unknown',
    timestamp: Math.round((firstBlood?.EventTime ?? firstKill?.EventTime ?? 0) * 1000)
  };
}

function pentakillsFromEvents(payload) {
  return (payload?.Events || [])
    .filter(event => event.EventName === 'Multikill' && Number(event.KillStreak) >= 5)
    .map(event => ({
      eventId: event.EventID,
      player: event.KillerName || 'Unknown',
      timestamp: Math.round(Number(event.EventTime || 0) * 1000)
    }));
}

function gameResultFromEvents(payload) {
  const gameEnd = [...(payload?.Events || [])].reverse().find(event => event.EventName === 'GameEnd');
  if (!gameEnd) return null;
  const result = String(gameEnd.Result ?? gameEnd.result ?? gameEnd.GameResult ?? '').toLowerCase();
  if (['win', 'victory'].includes(result)) return true;
  if (['lose', 'loss', 'defeat'].includes(result)) return false;
  return null;
}

function participantName(player) {
  if (validRiotId(player?.riotId)) return player.riotId;
  if (player?.riotIdGameName && player?.riotIdTagLine) return `${player.riotIdGameName}#${player.riotIdTagLine}`;
  return player?.riotIdGameName || player?.summonerName || 'Unknown';
}

function validRiotId(value) {
  const text = String(value || '').trim();
  const separator = text.lastIndexOf('#');
  return separator > 0 && separator < text.length - 1;
}

function shapeParticipants(players, activeName, blood, pentakills = [], winningTeam = null) {
  const activeKey = normalizeName(activeName);
  return (players || []).map(player => {
    const name = participantName(player);
    const key = normalizeName(name);
    return {
      ...player,
      name,
      hasRiotId:validRiotId(player.riotId) || Boolean(player.riotIdGameName && player.riotIdTagLine),
      champion: player.championName || player.rawChampionName?.split('_').pop() || 'Unknown',
      team: player.team || null,
      kills:Number.isFinite(Number(player.scores?.kills)) ? Number(player.scores.kills) : null,
      isLocalPlayer: key === activeKey,
      gotFirstBlood: key === normalizeName(blood?.killer),
      wasFirstDeath: key === normalizeName(blood?.victim),
      pentakills:pentakills.filter(penta => normalizeName(penta.player) === key).length,
      won:winningTeam ? player.team === winningTeam : null
    };
  });
}

function requestJson({ port, pathname, auth }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: LIVE_HOST,
      port,
      path: pathname,
      method: 'GET',
      auth,
      rejectUnauthorized: false,
      timeout: 1500
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`Local League API returned ${response.statusCode}`);
          error.status = response.statusCode;
          return reject(error);
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('League returned malformed JSON.')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('League API timed out.')));
    request.on('error', reject);
    request.end();
  });
}

function candidateLockfiles() {
  const candidates = [];
  if (process.env.LEAGUE_INSTALL_PATH) candidates.push(path.join(process.env.LEAGUE_INSTALL_PATH, 'lockfile'));
  candidates.push(
    'C:\\Riot Games\\League of Legends\\lockfile',
    'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
    'D:\\Riot Games\\League of Legends\\lockfile'
  );
  return [...new Set(candidates)];
}

function findLockfile() {
  for (const file of candidateLockfiles()) {
    try {
      const parsed = parseLockfile(fs.readFileSync(file, 'utf8'));
      if (parsed) return { file, ...parsed };
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return null;
}

function readRecords(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.error('Could not read local match records:', error.message);
    return [];
  }
}

function createCollector({ dataFile, intervalMs = 2000 } = {}) {
  const file = dataFile || path.join(__dirname, 'data', 'matches.json');
  let records = readRecords(file);
  let timer;
  let polling = false;
  let status = { state: 'starting', message: 'Looking for the League client…', queueId: null, lastChecked: null };

  function save(record) {
    const existing = records.findIndex(item => item.id === record.id);
    if (existing >= 0) records[existing] = record;
    else records.unshift(record);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(records, null, 2));
    fs.renameSync(temporary, file);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const lockfile = findLockfile();
      if (!lockfile) {
        status = { state:'client-offline', message:'Open the League client to enable recording.', queueId:null, lastChecked:Date.now() };
        return;
      }

      let session;
      try {
        session = await requestJson({
          port: lockfile.port,
          pathname: '/lol-gameflow/v1/session',
          auth: `riot:${lockfile.password}`
        });
      } catch (error) {
        status = { state:'waiting', message:'League detected. Waiting for a game…', queueId:null, lastChecked:Date.now() };
        return;
      }

      const queueId = Number(session?.gameData?.queue?.id ?? session?.gameData?.queueId ?? session?.queueId ?? 0);
      if (queueId !== MAYHEM_QUEUE_ID) {
        const message = session?.phase === 'InProgress'
          ? `Current game is queue ${queueId || 'unknown'}, not ARAM: Mayhem.`
          : 'League detected. Waiting for an ARAM: Mayhem game…';
        status = { state:'waiting', message, queueId:queueId || null, lastChecked:Date.now() };
        return;
      }

      status = { state:'recording', message:'Recording this ARAM: Mayhem match.', queueId, lastChecked:Date.now() };
      const allGameData = await requestJson({ port:LIVE_PORT, pathname:'/liveclientdata/allgamedata' });
      const events = allGameData.events || { Events:[] };
      const players = allGameData.allPlayers || [];
      const gameStats = allGameData.gameData || {};
      const activeName = allGameData.activePlayer?.riotId
        || allGameData.activePlayer?.riotIdGameName
        || allGameData.activePlayer?.summonerName
        || 'Unknown';
      const blood = firstBloodFromEvents(events);
      if (!blood) return;
      const pentakills = pentakillsFromEvents(events);

      const active = String(activeName || 'Unknown');
      const activeKey = normalizeName(active);
      const localPlayer = (players || []).find(player => [player.riotId, player.riotIdGameName, player.summonerName].some(name => normalizeName(name) === activeKey));
      const localWin = gameResultFromEvents(events);
      const teams = [...new Set((players || []).map(player => player.team).filter(Boolean))];
      const winningTeam = localWin == null
        ? null
        : localWin
          ? localPlayer?.team || null
          : teams.find(team => team !== localPlayer?.team) || null;
      const killer = (players || []).find(player => [player.riotId, player.riotIdGameName, player.summonerName].some(name => normalizeName(name) === normalizeName(blood.killer)));
      const victim = (players || []).find(player => [player.riotId, player.riotIdGameName, player.summonerName].some(name => normalizeName(name) === normalizeName(blood.victim)));
      const gameId = String(session?.gameData?.gameId || session?.gameData?.id || `${Date.now()}-${activeKey}`);
      const participants = shapeParticipants(players, active, blood, pentakills, winningTeam);
      save({
        schemaVersion:2,
        id: gameId,
        queueId,
        mode: 'ARAM: Mayhem',
        createdAt: Date.now() - Math.round(Number(gameStats?.gameTime || 0) * 1000),
        player: localPlayer?.riotId || localPlayer?.riotIdGameName || active,
        champion: localPlayer?.championName || localPlayer?.rawChampionName?.split('_').pop() || 'Unknown',
        wasFirstBlood: normalizeName(blood.killer) === activeKey,
        wasFirstDeath: normalizeName(blood.victim) === activeKey,
        win:localWin,
        winningTeam,
        participants,
        pentakills,
        liveData:{
          capturedAt:Date.now(),
          gameTime:Number(gameStats?.gameTime || 0),
          snapshot:allGameData
        },
        firstBlood: {
          timestamp: blood.timestamp,
          killer: { name:blood.killer, champion:killer?.championName || null },
          victim: { name:blood.victim, champion:victim?.championName || null }
        }
      });
      status = { state:'captured', message:`First blood recorded: ${blood.killer} → ${blood.victim}`, queueId, lastChecked:Date.now() };
    } catch (error) {
      // Port 2999 appears only after the game process starts and disappears at game end.
      status = { state:'connecting', message:'Mayhem detected. Waiting for the in-game data feed…', queueId:MAYHEM_QUEUE_ID, lastChecked:Date.now() };
    } finally {
      polling = false;
    }
  }

  return {
    start() { if (!timer) { poll(); timer = setInterval(poll, intervalMs); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    getStatus() { return { ...status, recordCount:records.length, lockfilePaths:candidateLockfiles() }; },
    getRecords() { return [...records]; },
    poll
  };
}

module.exports = { createCollector, firstBloodFromEvents, pentakillsFromEvents, gameResultFromEvents, normalizeName, parseLockfile, shapeParticipants, participantName, validRiotId, MAYHEM_QUEUE_ID };
