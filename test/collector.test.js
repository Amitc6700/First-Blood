const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAugmentsToRecord, augmentCatalogFromPayload, firstBloodFromEvents, pentakillsFromEvents, gameResultFromEvents, normalizeName, parseLockfile, shapeParticipants, participantName, validRiotId } = require('../collector');

test('parses a League client lockfile', () => {
  assert.deepEqual(parseLockfile('LeagueClient:1234:45678:secret:https'), {
    processName:'LeagueClient', pid:1234, port:45678, password:'secret', protocol:'https'
  });
});

test('extracts first blood and victim from live events', () => {
  const result = firstBloodFromEvents({ Events:[
    { EventName:'GameStart', EventTime:0 },
    { EventName:'ChampionKill', EventTime:82.25, KillerName:'Player One', VictimName:'Player Two' },
    { EventName:'FirstBlood', EventTime:82.25, Recipient:'Player One' }
  ] });
  assert.deepEqual(result, { killer:'Player One', victim:'Player Two', timestamp:82250 });
});

test('normalizes Riot ID and legacy name forms for comparison', () => {
  assert.equal(normalizeName('Player One#NA1'), normalizeName(' player one '));
});

test('shapes every player and identifies first blood roles', () => {
  const players = [
    { riotId:'Friend#NA1', championName:'Ahri', team:'ORDER' },
    { riotIdGameName:'Opponent', riotIdTagLine:'NA1', championName:'Lux', team:'CHAOS' }
  ];
  const result = shapeParticipants(players, 'Friend#NA1', { killer:'Friend', victim:'Opponent' });
  assert.equal(result.length, 2);
  assert.equal(result[0].isLocalPlayer, true);
  assert.equal(result[0].gotFirstBlood, true);
  assert.equal(result[1].wasFirstDeath, true);
});

test('extracts pentakills and assigns them to participants', () => {
  const events = { Events:[
    { EventID:7, EventName:'Multikill', EventTime:420.5, KillerName:'Friend', KillStreak:5 },
    { EventID:8, EventName:'Multikill', EventTime:500, KillerName:'Other', KillStreak:3 }
  ] };
  const pentakills = pentakillsFromEvents(events);
  assert.deepEqual(pentakills, [{ eventId:7, player:'Friend', timestamp:420500 }]);
  const participants = shapeParticipants([{ riotId:'Friend#NA1', championName:'Jinx' }], 'Friend', null, pentakills);
  assert.equal(participants[0].pentakills, 1);
});

test('stores live kill totals on participants', () => {
  const participants = shapeParticipants([
    { riotId:'Friend#NA1', championName:'Jinx', scores:{ kills:17, deaths:4, assists:20 } }
  ], 'Friend', null);
  assert.equal(participants[0].kills, 17);
});

test('preserves every field supplied for a live participant', () => {
  const source = {
    riotId:'Friend#NA1', championName:'Jinx', level:18,
    scores:{ kills:17, deaths:4, assists:20 },
    items:[{ itemID:3031, displayName:'Infinity Edge' }],
    runes:{ keystone:{ displayName:'Lethal Tempo' } },
    futureField:{ value:'kept' }
  };
  const participant = shapeParticipants([source], 'Friend', null)[0];
  assert.deepEqual(participant.items, source.items);
  assert.deepEqual(participant.runes, source.runes);
  assert.deepEqual(participant.futureField, source.futureField);
});

test('extracts the local win result and assigns the winning team', () => {
  assert.equal(gameResultFromEvents({ Events:[{ EventName:'GameEnd', Result:'Win' }] }), true);
  assert.equal(gameResultFromEvents({ Events:[{ EventName:'GameEnd', Result:'Lose' }] }), false);
  const participants = shapeParticipants([
    { riotId:'Friend#NA1', team:'ORDER' }, { riotId:'Opponent#NA1', team:'CHAOS' }
  ], 'Friend', null, [], 'ORDER');
  assert.equal(participants[0].won, true);
  assert.equal(participants[1].won, false);
});

test('does not treat Riot anonymous marker as a player identity', () => {
  const anonymous = { riotId:'#', riotIdGameName:'', riotIdTagLine:'', summonerName:'Xerath' };
  assert.equal(validRiotId(anonymous.riotId), false);
  assert.equal(participantName(anonymous), 'Xerath');
  assert.equal(shapeParticipants([anonymous], 'Someone#NA1', null)[0].hasRiotId, false);
});

test('adds ordered Mayhem augments from League match history', () => {
  const catalog = augmentCatalogFromPayload(
    [{ modeName:'KIWI', augmentList:['Maps/ModeSpecificData/Augments/ARAM_TestOne', 'Maps/ModeSpecificData/Augments/TestTwo'] }],
    [
      { id:101, augmentNameId:'ARAM_TestOne', nameTRA:'Test One', rarity:'kSilver' },
      { id:202, augmentNameId:'TestTwo', nameTRA:'Test Two', rarity:'kPrismatic' },
      { id:303, augmentNameId:'NotInMayhem', nameTRA:'Excluded', rarity:'kGold' }
    ]
  );
  assert.equal(catalog.size, 2);
  const record = { id:'123456', queueId:2400, participants:[{ name:'Friend#NA1' }, { name:'Enemy#EUW' }] };
  const match = {
    queueId:2400,
    gameVersion:'16.17.1',
    participantIdentities:[
      { participantId:1, player:{ gameName:'Friend', tagLine:'NA1' } },
      { participantId:2, player:{ gameName:'Enemy', tagLine:'EUW' } }
    ],
    participants:[
      { participantId:1, stats:{ playerAugment1:101, playerAugment2:202, playerAugment3:0 } },
      { participantId:2, stats:{ playerAugment1:202, playerAugment2:101 } }
    ]
  };
  assert.equal(applyAugmentsToRecord(record, match, catalog), true);
  assert.deepEqual(record.participants[0].augments, [
    { id:101, name:'Test One', rarity:'kSilver', icon:'101.png', order:1 },
    { id:202, name:'Test Two', rarity:'kPrismatic', icon:'202.png', order:2 }
  ]);
  assert.equal(record.augmentData.playerCount, 2);
  assert.equal(record.schemaVersion, 3);
});
