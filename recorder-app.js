const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createCollector } = require('./collector');

function isSea() {
  try { return require('node:sea').isSea(); }
  catch { return false; }
}

function applicationDirectory() {
  return process.pkg || isSea() ? path.dirname(process.execPath) : __dirname;
}

function applicationDataDirectory() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'FirstBloodUploader');
}

function migrateLegacyInstallation(destination) {
  const legacyConfig = path.join(applicationDirectory(), 'recorder.config.json');
  if (fs.existsSync(destination) || !fs.existsSync(legacyConfig) || legacyConfig === destination) return;
  fs.mkdirSync(path.dirname(destination), { recursive:true });
  const legacy = JSON.parse(fs.readFileSync(legacyConfig, 'utf8'));
  for (const property of ['localDataFile', 'uploadStateFile']) {
    const relative = legacy[property];
    if (!relative || path.isAbsolute(relative)) continue;
    const source = path.resolve(applicationDirectory(), relative);
    const target = path.resolve(path.dirname(destination), relative);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive:true });
      fs.copyFileSync(source, target);
    }
  }
  fs.copyFileSync(legacyConfig, destination);
}

function configPath() {
  const argument = process.argv.find(value => value.startsWith('--config='));
  if (argument) return path.resolve(argument.slice('--config='.length));
  const destination = path.join(applicationDataDirectory(), 'recorder.config.json');
  migrateLegacyInstallation(destination);
  return destination;
}

function createDefaultConfig(file) {
  const example = {
    serverUrl:'https://your-site.example.com',
    deviceToken:'',
    installId:crypto.randomUUID(),
    deviceName:os.hostname(),
    leagueInstallPath:'C:\\Riot Games\\League of Legends',
    localDataFile:'recorder-data.json',
    uploadStateFile:'upload-state.json',
    pollIntervalMs:2000,
    uploadIntervalMs:15000
  };
  fs.writeFileSync(file, `${JSON.stringify(example, null, 2)}\n`);
}

function fingerprint(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function readUploadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.matches || {}; }
  catch (error) { if (error.code !== 'ENOENT') console.error(`Could not read upload history: ${error.message}`); return {}; }
}

function writeUploadState(file, matches) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version:1, matches }, null, 2));
  fs.renameSync(temporary, file);
}

function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    createDefaultConfig(file);
    console.log(`Created ${file}`);
    console.log('Edit the server URL and upload token, then run FirstBloodRecorder.exe again.');
    return null;
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^https:\/\//i.test(config.serverUrl || '')) throw new Error('serverUrl must begin with https://');
  config.installId ||= crypto.randomUUID();
  config.deviceName ||= os.hostname();
  if (!config.deviceToken && (!config.uploadToken || config.uploadToken.startsWith('replace-'))) throw new Error('This PC is not registered. Open Settings and enter an invite code.');
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { ...config, file };
}

async function registerDevice(serverUrl, inviteCode, installId, deviceName) {
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/upload/register`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ inviteCode, installId, deviceName })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok !== true || !/^fbu_[A-Za-z0-9_-]{43}$/.test(result.deviceToken || '')) {
    const error = new Error(result.error || `Registration failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function uploadRecord(config, record) {
  const response = await fetch(`${config.serverUrl.replace(/\/$/, '')}/api/upload/matches`, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${config.deviceToken || config.uploadToken}`, 'Content-Type':'application/json' },
    body:JSON.stringify(record)
  });
  if (!response.ok) {
    let message = `Upload failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (result?.ok !== true || String(result.matchId) !== String(record.id)) {
    const error = new Error('Server did not validate the uploaded match.');
    error.status = 502;
    throw error;
  }
  return result;
}

function shouldDeferUpload(record, status, latestRecordId) {
  const isFinal = typeof record?.win === 'boolean';
  const isCurrentMatch = String(record?.id) === String(latestRecordId || '');
  const mayhemIsActive = Number(status?.queueId) === 2400 && ['recording','captured','connecting'].includes(status?.state);
  return !isFinal && isCurrentMatch && mayhemIsActive;
}

function isPermanentUploadError(status) {
  return [400, 413, 422].includes(Number(status));
}

async function main() {
  const config = loadConfig();
  if (!config) return;
  if (config.leagueInstallPath) process.env.LEAGUE_INSTALL_PATH = config.leagueInstallPath;
  const configDirectory = path.dirname(config.file);
  const dataFile = path.resolve(configDirectory, config.localDataFile || 'recorder-data.json');
  const stateFile = path.resolve(configDirectory, config.uploadStateFile || 'upload-state.json');
  const collector = createCollector({ dataFile, intervalMs:Number(config.pollIntervalMs) || 2000 });
  const uploadState = readUploadState(stateFile);
  let uploading = false;
  let lastStatus = '';

  async function sync() {
    const status = collector.getStatus();
    const statusText = `${status.state}:${status.message}`;
    if (statusText !== lastStatus) {
      console.log(`[${new Date().toLocaleTimeString()}] ${status.message}`);
      lastStatus = statusText;
    }
    if (uploading) return;
    uploading = true;
    try {
      const enriched = await collector.enrichAugments({ limit:8 });
      if (enriched) console.log(`[${new Date().toLocaleTimeString()}] Added augment choices to ${enriched} match${enriched === 1 ? '' : 'es'}.`);
      const records = collector.getRecords();
      const latestRecordId = records[0]?.id;
      for (const record of records) {
        if (shouldDeferUpload(record, status, latestRecordId)) continue;
        const recordFingerprint = fingerprint(record);
        const recordId = String(record.id);
        if (uploadState[recordId]?.fingerprint === recordFingerprint) continue;
        try {
          const result = await uploadRecord(config, record);
          const outcome = result.created ? 'uploaded' : 'duplicate';
          uploadState[recordId] = { fingerprint:recordFingerprint, outcome, syncedAt:Date.now() };
          writeUploadState(stateFile, uploadState);
          console.log(`[${new Date().toLocaleTimeString()}] ${result.created ? 'Uploaded' : 'Duplicate'} match ${record.id}`);
        } catch (error) {
          if (isPermanentUploadError(error.status)) {
            uploadState[recordId] = { fingerprint:recordFingerprint, outcome:'skipped', syncedAt:Date.now(), message:error.message };
            writeUploadState(stateFile, uploadState);
            console.error(`[${new Date().toLocaleTimeString()}] Skipped unusable match ${record.id}: ${error.message}`);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      console.error(`[${new Date().toLocaleTimeString()}] ${error.message}; will retry.`);
    } finally {
      uploading = false;
    }
  }

  console.log('First Blood Recorder');
  console.log(`Uploading to ${config.serverUrl}`);
  console.log(`Local backup: ${dataFile}`);
  console.log(`Upload history: ${stateFile}`);
  if (!config.deviceToken) console.log('Using the old shared credential. Register this PC in Settings soon.');
  collector.start();
  setInterval(sync, Number(config.uploadIntervalMs) || 15000);
  sync();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { applicationDataDirectory, applicationDirectory, configPath, registerDevice, uploadRecord, fingerprint, isPermanentUploadError, readUploadState, writeUploadState, shouldDeferUpload };
