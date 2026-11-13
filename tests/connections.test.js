import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyVault,PersonalConnections } from '../src/connections.js';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { SpecTracker } from '../src/specs.js';
import { NexonClient } from '../src/nexon.js';
import { createHandler } from '../src/interactions.js';
import * as views from '../src/views.js';

const ctx={guildId:'g',threadId:'t',userId:'u',eligibleOwnerIds:new Set(['u'])};
const key='test-personal-api-key-for-tests-only';
const encryptionKey=Buffer.alloc(32,7).toString('base64');
const remote=(name='캐릭터',ocid='private-ocid')=>({name,ocid,world:'루나',job:'히어로',level:280});
const scheduler=()=>({date:'2026-11-13',daily:[{name:'일퀘',type:'quest',now:1,max:1,questState:'2',registered:true}],weekly:[],bosses:[{name:'윌',difficulty:'하드',cycle:'weekly',complete:true,registered:true}],weeklyBossCount:1,weeklyBossLimit:12});
const collected=()=>({ocid:'private-ocid',profile:{name:'캐릭터',world:'루나',job:'히어로'},data:{level:280,combatPower:'100000000',equipment:{},skills:{},unavailable:[],preset:1}});
function setup(t,clientFactory) {
  const repository=new Repository(':memory:');t.after(()=>repository.close());const service=new PartyService(repository);service.start(ctx,'start');
  let now=Date.parse('2026-11-13T05:00:00Z');
  const clients=[];
  const factory=options=>{const client=clientFactory?clientFactory(options):{listCharacters:async()=>[remote()],scheduler:async()=>scheduler(),combatPower:async()=> '100000000',collect:async()=>collected(),close(){this.closed=true;}};clients.push(client);return client;};
  const connections=new PersonalConnections({repository,service,encryptionKey,clientFactory:factory,now:()=>now});
  const tracker=new SpecTracker({repository,service,connections,now:()=>now});
  return {repository,service,connections,tracker,clients,advance:ms=>now+=ms};
}
function selectAll(connections,owner=ctx) {
  const draft=connections.beginSelection(owner);
  for(let page=0;page<Math.ceil(draft.items.length/25);page++)connections.selection(owner,draft.id,page,draft.items.slice(page*25,(page+1)*25).map(c=>c.value));
  return draft.items.length?connections.completeSelection(owner,draft.id):{added:0,updated:0,conflicts:0};
}
async function connectAndSelect(f,owner,apiKey) {await f.connections.connect(owner,apiKey);return selectAll(f.connections,owner);}
test('vault encrypts with authenticated context and rejects missing/wrong/tampered keys',()=>{
  const vault=new KeyVault(encryptionKey),sealed=vault.seal(key,'g:t:u');
  assert.equal(vault.open(sealed,'g:t:u'),key);assert.ok(!sealed.includes(key));
  assert.notEqual(vault.seal(key,'g:t:u'),sealed);
  assert.throws(()=>vault.open(sealed,'g:t:other'),{code:'KEY_DECRYPT'});
  assert.throws(()=>new KeyVault(Buffer.alloc(32,8).toString('base64')).open(sealed,'g:t:u'),{code:'KEY_DECRYPT'});
  assert.throws(()=>new KeyVault().seal(key,'g:t:u'),{code:'KEY_CONFIG'});
  const tampered=JSON.parse(sealed);tampered.data='AAAA';assert.throws(()=>vault.open(JSON.stringify(tampered),'g:t:u'),{code:'KEY_DECRYPT'});
});
test('connect keeps all candidates private until explicit selection and encrypts key and OCIDs',async t=>{
  const f=setup(t,()=>({listCharacters:async()=>Array.from({length:35},(_,i)=>remote(`캐ラ${i}`,`ocid-${i}`)),close(){}}));
  await f.connections.connect(ctx,key);assert.equal(f.service.snapshot(ctx).characters.length,0);
  const result=selectAll(f.connections);assert.equal(result.added,35);
  assert.equal(f.service.snapshot(ctx).characters.length,35);
  const dbRows=JSON.stringify([...f.repository.db.prepare('SELECT * FROM personal_connections').all(),...f.repository.db.prepare('SELECT * FROM personal_characters').all(),...f.repository.db.prepare('SELECT * FROM personal_candidates').all()]);
  assert.ok(!dbRows.includes(key));assert.ok(!dbRows.includes('ocid-0'));
  assert.equal(f.connections.status({...ctx,userId:'other'}).connected,false);
  assert.equal(f.connections.status({...ctx,threadId:'other'}).count,0);
  assert.ok(!JSON.stringify(f.connections.status(ctx)).includes(key));
});
test('import preserves existing own character and party IDs without stealing another user registration',async t=>{
  const f=setup(t,()=>({listCharacters:async()=>[remote(),remote('친구','other-ocid')],close(){}}));
  const c=f.service.register(ctx,{name:'캐릭터'},'legacy'),other=f.service.register({...ctx,userId:'other'},{name:'친구'},'other');
  const p=f.service.createParty(ctx,'A','party');f.service.addCharacter(ctx,p.id,c.id,'add');
  const result=await connectAndSelect(f,ctx,key);assert.equal(result.conflicts,1);assert.equal(result.updated,1);
  assert.deepEqual(f.service.getParty(ctx,p.id).characterIds,[c.id]);
  assert.equal(f.service.snapshot(ctx).characters.find(x=>x.id===other.id).ownerId,'other');
  f.advance(6*3600_000);await f.connections.refresh(ctx);assert.equal(f.service.snapshot(ctx).characters.length,2);
});
test('bad replacement retains old connection; valid rotation invalidates old leases; stale unlink cannot delete new key',async t=>{
  const f=setup(t,({apiKey})=>({listCharacters:async()=>{if(apiKey==='bad-key-'.repeat(5))throw new Error('bad');return [remote()];},close(){this.closed=true;}}));
  await connectAndSelect(f,ctx,key);const version=f.connections.row(ctx).version,c=f.service.snapshot(ctx).characters[0];
  const session=f.connections.session(ctx,c);
  await assert.rejects(()=>f.connections.connect(ctx,'bad-key-'.repeat(5)));
  assert.equal(f.connections.row(ctx).version,version);session.assertCurrent();
  await connectAndSelect(f,ctx,'new-key-'.repeat(5));assert.equal(session.api.closed,true);
  assert.throws(()=>session.assertCurrent(),{code:'KEY_CHANGED'});
  assert.throws(()=>f.connections.disconnect(ctx,version),{code:'KEY_CHANGED'});
  assert.equal(f.connections.status(ctx).connected,true);
});
test('disconnect during initial validation prevents a late request from restoring the key',async t=>{
  let release;const f=setup(t,()=>({listCharacters:()=>new Promise(resolve=>release=()=>resolve([remote()])),close(){}}));
  const work=f.connections.connect(ctx,key);f.connections.disconnect(ctx);release();
  await assert.rejects(()=>work,{code:'KEY_CHANGED'});assert.equal(f.connections.status(ctx).connected,false);
});
test('only the newest concurrent connect may save private candidates',async t=>{
  const releases=[];const f=setup(t,()=>({listCharacters:()=>new Promise(resolve=>releases.push(()=>resolve([remote()]))),close(){}}));
  const first=f.connections.connect(ctx,key),second=f.connections.connect(ctx,'another-key-'.repeat(4));
  releases[1]();await second;releases[0]();await assert.rejects(()=>first,{code:'KEY_CHANGED'});
  assert.equal(f.service.snapshot(ctx).characters.length,0);assert.equal(f.connections.candidates(ctx).length,1);
});
test('personal spec collection uses encrypted binding and never saves plaintext personal OCID to legacy profile table',async t=>{
  const f=setup(t);await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];
  await f.tracker.sync(ctx,c.id);assert.equal(f.tracker.history(ctx,c.id).length,1);
  assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM spec_profiles').get().n,0);
  f.connections.disconnect(ctx);
  assert.equal(f.connections.status(ctx).connected,false);
  await assert.rejects(()=>f.tracker.sync(ctx,c.id),{code:'KEY_MISSING'});
  assert.equal(f.tracker.history(ctx,c.id).length,1);
});
test('disconnected in-flight spec and scheduler results cannot commit',async t=>{
  for(const kind of ['spec','scheduler']) {
    let release;const f=setup(t,()=>({listCharacters:async()=>[remote()],collect:()=>new Promise(r=>release=()=>r(collected())),scheduler:()=>new Promise(r=>release=()=>r(scheduler())),close(){}}));
    await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];
    const work=kind==='spec'?f.tracker.sync(ctx,c.id):f.tracker.syncScheduler(ctx,c.id);
    f.connections.disconnect(ctx);release();await assert.rejects(()=>work,{code:'KEY_CHANGED'});
    assert.equal(f.tracker.history(ctx,c.id).length,0);assert.equal(f.tracker.schedulerHistory(ctx,c.id).length,0);
  }
});
test('scheduler is owner-only, daily upserted, cached, persisted and retained for 14 days',async t=>{
  let calls=0;const f=setup(t,()=>({listCharacters:async()=>[remote()],scheduler:async()=>{calls++;return scheduler();},close(){}}));
  await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];
  await assert.rejects(()=>f.tracker.syncScheduler({...ctx,userId:'other'},c.id),{code:'FORBIDDEN'});
  await f.tracker.syncScheduler(ctx,c.id);assert.equal(calls,1);
  assert.equal((await f.tracker.syncScheduler(ctx,c.id)).cached,true);
  assert.throws(()=>f.tracker.schedulerHistory({...ctx,userId:'other'},c.id),{code:'FORBIDDEN'});
  f.advance(3600_000);await f.tracker.syncScheduler(ctx,c.id);assert.equal(calls,2);assert.equal(f.tracker.schedulerHistory(ctx,c.id).length,1);
  const resumed=new SpecTracker({repository:f.repository,service:f.service,connections:f.connections,now:f.tracker.now});
  assert.equal(resumed.schedulerHistory(ctx,c.id)[0].bosses[0].complete,true);
  f.advance(14*86400_000);assert.equal(resumed.schedulerHistory(ctx,c.id).length,0);
});
test('API list disappearance disables collection without deleting saved characters or reactivating opted-out ones',async t=>{
  let items=[remote()];const f=setup(t,()=>({listCharacters:async()=>items,close(){}}));
  await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];
  items=[];f.advance(6*3600_000);await f.connections.refresh(ctx);
  assert.equal(f.service.snapshot(ctx).characters[0].active,true);
  assert.throws(()=>f.connections.session(ctx,c),{code:'KEY_CHARACTER'});
  f.service.unregister(ctx,c.id,'remove');items=[remote()];f.advance(6*3600_000);await f.connections.refresh(ctx);
  assert.equal(f.service.snapshot(ctx).characters[0].active,false);
});
test('per-key budget persists and is shared across workspaces while independent keys remain independent',async t=>{
  const f=setup(t);const fingerprint=f.connections.vault.fingerprint(key);
  for(let i=0;i<900;i++)assert.equal(f.connections.reserve(fingerprint),true);
  assert.equal(f.connections.reserve(fingerprint),false);
  const restarted=new PersonalConnections({repository:f.repository,service:f.service,encryptionKey,now:f.tracker.now});
  assert.equal(restarted.reserve(fingerprint),false);assert.equal(restarted.reserve(restarted.vault.fingerprint('different')),true);
});
test('official list and scheduler normalize all accounts, booleans, missing sections and unknown counts',async()=>{
  const paths=[];const client=new NexonClient({apiKey:key,sleep:async()=>{},fetchImpl:async url=>{
    paths.push(url);return {ok:true,json:async()=>url.pathname.endsWith('/list')?{account_list:[{character_list:[{ocid:'private',character_name:'A',world_name:'루나',character_class:'히어로',character_level:280}]},{character_list:[]}]}:
      {date:'2026-11-13',character_name:'A',daily_contents:null,weekly_contents:[],boss_contents:[{content_name:'윌',difficulty:'하드',cycle:'weekly',complete_flag:'true',registration_flag:'false'}],weekly_boss_clear_count:1,weekly_boss_clear_limit_count:12}};
  }});
  assert.equal((await client.listCharacters())[0].name,'A');const result=await client.scheduler('private');
  assert.equal(result.bosses[0].complete,true);assert.equal(result.bosses[0].registered,false);assert.equal(result.daily,null);
  assert.equal(paths[1].searchParams.get('ocid'),'private');assert.ok(!('ocid' in result));
});
test('scheduler accepts the live API date format and can read a past day',async()=>{
  const urls=[];const client=new NexonClient({apiKey:key,sleep:async()=>{},fetchImpl:async url=>{
    urls.push(url);return {ok:true,json:async()=>({date:'2026-11-11T00:00+09:00',character_name:'A',daily_contents:[],weekly_contents:[],boss_contents:[{content_name:'스우',difficulty:'extreme',cycle:'bossWeekly',complete_flag:'true',registration_flag:'true'}],weekly_boss_clear_count:12,weekly_boss_clear_limit_count:12})};
  }});
  const result=await client.scheduler('private','2026-11-11');
  assert.equal(result.date,'2026-11-11');assert.equal(urls[0].searchParams.get('date'),'2026-11-11');
  await client.scheduler('private');assert.equal(urls[1].searchParams.has('date'),false);
});
test('personal API UI contains no key value; scheduler cards paginate without public follow-ups',async t=>{
  const f=setup(t);await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];await f.tracker.syncScheduler(ctx,c.id);
  const handler=createHandler({service:f.service,connections:f.connections,tracker:f.tracker,guildId:'g',verifyContext:async()=>ctx});
  const outputs=[];const i={id:'ui',channel:{},user:{id:'u'},isAutocomplete:()=>false,isChatInputCommand:()=>true,isButton:()=>false,isStringSelectMenu:()=>false,isModalSubmit:()=>false,commandName:'캐릭터',options:{getSubcommand:()=> '스케줄러',getString:name=>name==='캐릭터'?c.id:null},async deferReply(){this.deferred=true;},async editReply(payload){outputs.push(payload);},async followUp(){assert.fail('scheduler must stay private');}};
  await handler(i);assert.match(outputs[0].embeds[0].toJSON().title,/스케줄러/);
  const privatePayload=views.connectionPanel(f.connections.status(ctx));assert.ok(!JSON.stringify(privatePayload).includes(key));
  const large=scheduler();large.bosses=Array.from({length:70},()=>({...large.bosses[0],name:'*'.repeat(100)}));
  for(let page=0;page<10;page++) {
    const payload=views.schedulerDetail(c,[{...large,collectedAt:Date.now()}],0,page);
    assert.ok(payload.embeds[0].toJSON().fields.every(x=>x.value.length<=1024));payload.components.forEach(r=>r.toJSON());
  }
});

test('one exhausted account does not stop other accounts scheduler or spec collection',async t=>{
  let collectedOther=0;
  const f=setup(t,({apiKey})=>({listCharacters:async()=>apiKey===key?[remote()]:[remote('친구','friend-ocid')],
    scheduler:async()=>{if(apiKey===key)throw Object.assign(new Error('quota'),{code:'NEXON_BUDGET'});return scheduler();},
    collect:async()=>{if(apiKey===key)throw Object.assign(new Error('quota'),{code:'NEXON_BUDGET'});collectedOther++;return {...collected(),ocid:'friend-ocid',profile:{name:'친구',world:'루나',job:'히어로'}};},close(){}}));
  await connectAndSelect(f,ctx,key);const other={...ctx,userId:'other'};await connectAndSelect(f,other,'other-api-key-'.repeat(3));
  await f.tracker.sweep({guildId:'g'});
  const friend=f.service.snapshot(ctx).characters.find(c=>c.ownerId==='other');
  assert.equal(collectedOther,1);assert.equal(f.tracker.schedulerHistory(other,friend.id).length,1);
});
test('empty or failed scheduler responses preserve prior daily status',async t=>{
  let fail=false;const f=setup(t,()=>({listCharacters:async()=>[remote()],scheduler:async()=>{if(fail)throw Object.assign(new Error('no data'),{code:'NEXON_NO_SCHEDULER'});return scheduler();},close(){}}));
  await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];await f.tracker.syncScheduler(ctx,c.id);
  const before=f.tracker.schedulerHistory(ctx,c.id);fail=true;f.advance(3600_000);
  await assert.rejects(()=>f.tracker.syncScheduler(ctx,c.id));assert.deepEqual(f.tracker.schedulerHistory(ctx,c.id),before);
});
test('an invalid account-list response cannot masquerade as an empty account',async()=>{
  const client=new NexonClient({apiKey:key,sleep:async()=>{},fetchImpl:async()=>({ok:true,json:async()=>({account_list:null})})});
  await assert.rejects(()=>client.listCharacters(),{code:'NEXON_DATA'});
});
test('shared key gate serializes requests from separate connection clients',async()=>{
  const gate={tail:Promise.resolve()},events=[];let release;
  const a=new NexonClient({apiKey:key,gate,sleep:async()=>{},fetchImpl:async()=>{events.push('a');await new Promise(r=>release=r);return {ok:true,json:async()=>({})};}});
  const b=new NexonClient({apiKey:key,gate,sleep:async()=>{},fetchImpl:async()=>{events.push('b');return {ok:true,json:async()=>({})};}});
  const first=a.request('id'),second=b.request('id');await Promise.resolve();assert.deepEqual(events,['a']);release();await Promise.all([first,second]);assert.deepEqual(events,['a','b']);
});
test('reopened connection manager decrypts stored key with the same server encryption secret',async t=>{
  const f=setup(t);await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];
  let supplied;
  const restarted=new PersonalConnections({repository:f.repository,service:f.service,encryptionKey,now:f.tracker.now,clientFactory:options=>{supplied=options.apiKey;return {};}});
  assert.equal(restarted.session(ctx,c).ocid,'private-ocid');assert.equal(supplied,key);
});

test('account list removal invalidates already running character collection',async t=>{
  let release,items=[remote()];const f=setup(t,()=>({listCharacters:async()=>items,collect:()=>new Promise(r=>release=()=>r(collected())),close(){}}));
  await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];const work=f.tracker.sync(ctx,c.id);
  items=[];f.advance(6*3600_000);await f.connections.refresh(ctx);release();
  await assert.rejects(()=>work,{code:'KEY_CHARACTER'});assert.equal(f.tracker.history(ctx,c.id).length,0);
});

test('selection survives page changes and only explicit choices are registered or collected',async t=>{
  let specCalls=0,schedulerCalls=0;
  const f=setup(t,()=>({listCharacters:async()=>Array.from({length:57},(_,i)=>remote(`캐릭터${i}`,`ocid-${i}`)),
    collect:async(name,ocid)=>{specCalls++;return {...collected(),ocid,profile:{name,world:'루나',job:'히어로'}};},
    scheduler:async()=>{schedulerCalls++;return scheduler();},close(){}}));
  await f.connections.connect(ctx,key);
  await f.tracker.sweep({guildId:'g'});assert.equal(specCalls,0);assert.equal(schedulerCalls,0);
  const draft=f.connections.beginSelection(ctx);
  f.connections.selection(ctx,draft.id,0,[draft.items[0].value,draft.items[1].value]);
  f.connections.selection(ctx,draft.id,1,[draft.items[26].value]);
  f.connections.selection(ctx,draft.id,0,[draft.items[1].value]);
  assert.equal(draft.selected.size,2);
  for(let page=0;page<3;page++)views.characterSelection(draft,page).components.forEach(r=>r.toJSON());
  assert.equal(f.connections.completeSelection(ctx,draft.id).added,2);
  assert.deepEqual(new Set(f.service.snapshot(ctx).characters.map(c=>c.name)),new Set([draft.items[1].name,draft.items[26].name]));
  await f.tracker.sweep({guildId:'g'});assert.equal(specCalls,2);assert.equal(schedulerCalls,2);
  f.advance(6*3600_000);await f.connections.refresh(ctx);
  assert.equal(f.service.snapshot(ctx).characters.length,2);
  assert.equal(f.connections.beginSelection(ctx).items.length,55);
});
test('deletion preserves histories, stops collection, stays deleted after refresh and re-adds the same ID',async t=>{
  const f=setup(t);await connectAndSelect(f,ctx,key);const c=f.service.snapshot(ctx).characters[0];
  await f.tracker.sync(ctx,c.id);await f.tracker.syncScheduler(ctx,c.id);
  const party=f.service.createParty(ctx,'보관 파티','party');f.service.addCharacter(ctx,party.id,c.id,'member');f.service.archive(ctx,party.id,true,'archive');
  const draft=f.connections.beginSelection(ctx,'remove');f.connections.selection(ctx,draft.id,0,[c.id]);
  assert.equal(f.connections.completeSelection(ctx,draft.id).removed,1);
  assert.equal(f.service.snapshot(ctx).characters[0].active,false);
  assert.deepEqual(f.service.getParty(ctx,party.id,true).characterIds,[c.id]);
  assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM spec_snapshots').get().n,1);
  const calls=f.clients.length;f.advance(6*3600_000);await f.connections.refresh(ctx);await f.tracker.sweep({guildId:'g'});
  assert.equal(f.service.snapshot(ctx).characters[0].active,false);assert.equal(f.clients.length,calls);
  selectAll(f.connections);assert.equal(f.service.snapshot(ctx).characters[0].id,c.id);assert.equal(f.tracker.history(ctx,c.id).length,1);
});
test('bulk deletion checks active party references atomically and still works after disconnect',async t=>{
  const f=setup(t,()=>({listCharacters:async()=>[remote(),remote('부캐','second')],close(){}}));
  await connectAndSelect(f,ctx,key);const [first,second]=f.service.snapshot(ctx).characters;
  const p=f.service.createParty(ctx,'현재 파티','party');f.service.addCharacter(ctx,p.id,second.id,'member');
  const draft=f.connections.beginSelection(ctx,'remove');f.connections.selection(ctx,draft.id,0,[first.id,second.id]);
  assert.throws(()=>f.connections.completeSelection(ctx,draft.id),{code:'IN_USE'});
  assert.ok(f.service.snapshot(ctx).characters.every(c=>c.active));
  f.service.removeCharacter(ctx,p.id,second.id,'remove');assert.equal(f.connections.completeSelection(ctx,draft.id).removed,2);
  selectAll(f.connections);f.connections.disconnect(ctx);
  const offline=f.connections.beginSelection(ctx,'remove');f.connections.selection(ctx,offline.id,0,[first.id]);f.connections.completeSelection(ctx,offline.id);
  assert.equal(f.service.snapshot(ctx).characters.find(c=>c.id===first.id).active,false);
  assert.equal(f.connections.candidates(ctx).length,0);
});
test('selection rejects other owners, foreign values, old connections, expired drafts and duplicate completion',async t=>{
  const f=setup(t);await f.connections.connect(ctx,key);let draft=f.connections.beginSelection(ctx);
  assert.throws(()=>f.connections.selection({...ctx,userId:'other'},draft.id),{code:'STALE'});
  assert.throws(()=>f.connections.selection(ctx,draft.id,0,['forged']),{code:'INVALID_INPUT'});
  assert.throws(()=>f.connections.selection(ctx,draft.id,NaN),{code:'INVALID_INPUT'});
  f.connections.selection(ctx,draft.id,0,[draft.items[0].value]);
  await f.connections.connect(ctx,'replacement-key-'.repeat(3));assert.throws(()=>f.connections.completeSelection(ctx,draft.id),{code:'KEY_CHANGED'});
  draft=f.connections.beginSelection(ctx);f.advance(31*60_000);assert.throws(()=>f.connections.selection(ctx,draft.id),{code:'STALE'});
  draft=f.connections.beginSelection(ctx);f.connections.selection(ctx,draft.id,0,[draft.items[0].value]);f.connections.completeSelection(ctx,draft.id);
  assert.throws(()=>f.connections.completeSelection(ctx,draft.id),{code:'STALE'});assert.equal(f.service.snapshot(ctx).characters.length,1);
});
test('private account candidates survive restart and a disappeared selection cannot be registered',async t=>{
  let items=[remote()];const f=setup(t,()=>({listCharacters:async()=>items,close(){}}));await f.connections.connect(ctx,key);
  const resumed=new PersonalConnections({repository:f.repository,service:f.service,encryptionKey,now:f.tracker.now});
  assert.equal(resumed.beginSelection(ctx).items[0].name,'캐릭터');
  const draft=f.connections.beginSelection(ctx);f.connections.selection(ctx,draft.id,0,[draft.items[0].value]);
  items=[];f.advance(6*3600_000);await f.connections.refresh(ctx);
  assert.throws(()=>f.connections.completeSelection(ctx,draft.id),{code:'STALE'});assert.equal(f.service.snapshot(ctx).characters.length,0);
});

test('add and removal choices sort by descending level with deterministic name ties',async t=>{
  const items=[{...remote('저레벨','low'),level:200},{...remote('나','b'),level:280},{...remote('고레벨','high'),level:290},{...remote('가','a'),level:280}];
  const f=setup(t,()=>({listCharacters:async()=>items,close(){}}));await f.connections.connect(ctx,key);
  assert.deepEqual(f.connections.beginSelection(ctx).items.map(c=>c.name),['고레벨','가','나','저레벨']);
  selectAll(f.connections);assert.deepEqual(f.connections.beginSelection(ctx,'remove').items.map(c=>c.name),['고레벨','가','나','저레벨']);
});
test('combat power loads all candidates before pagination, caches across restarts and leaves selections intact',async t=>{
  const calls=[],items=Array.from({length:40},(_,i)=>({...remote(`캐릭터${i}`,`ocid-${i}`),level:300-i}));
  const factory=()=>({listCharacters:async()=>items,combatPower:async ocid=>{calls.push(ocid);return '123456789';},close(){}});
  const f=setup(t,factory);await f.connections.connect(ctx,key);assert.equal(calls.length,0);
  const draft=f.connections.beginSelection(ctx);f.connections.selection(ctx,draft.id,0,[draft.items[0].value]);
  await f.connections.loadSelectionPage(ctx,draft.id);assert.equal(calls.length,40);assert.ok(calls.includes('ocid-39'));
  const payload=views.characterSelection(draft),options=payload.components[0].toJSON().components[0].options;
  assert.equal(options[0].label,'Lv.300 캐릭터0 · 전투력 123,456,789');
  assert.equal(options[0].default,true);assert.equal(draft.selected.size,1);
  await f.connections.loadSelectionPage(ctx,draft.id);assert.equal(calls.length,40);
  const resumed=new PersonalConnections({repository:f.repository,service:f.service,encryptionKey,clientFactory:factory,now:f.tracker.now});
  await resumed.loadSelectionPage(ctx,resumed.beginSelection(ctx).id);assert.equal(calls.length,40);
  await f.connections.loadSelectionPage(ctx,draft.id,1);assert.equal(calls.length,40);
  assert.equal(f.connections.completeSelection(ctx,draft.id).added,1);
  f.advance(3600_000);const next=f.connections.beginSelection(ctx);await f.connections.loadSelectionPage(ctx,next.id);assert.equal(calls.length,79);
});
test('missing power remains selectable, exhausted budgets stop lookups and disconnect removes the cache',async t=>{
  let calls=0;const f=setup(t,()=>({listCharacters:async()=>[remote('A','a'),remote('B','b'),remote('C','c')],combatPower:async()=>{
    calls++;if(calls===1)return '0';throw Object.assign(new Error('quota'),{code:'NEXON_BUDGET'});
  },close(){}}));
  await f.connections.connect(ctx,key);const draft=f.connections.beginSelection(ctx);await f.connections.loadSelectionPage(ctx,draft.id);
  assert.equal(calls,2);const options=views.characterSelection(draft).components[0].toJSON().components[0].options;
  assert.match(options[0].label,/전투력 0$/);assert.match(options[1].label,/조회 불가/);assert.match(options[2].label,/조회 불가/);
  f.connections.selection(ctx,draft.id,0,[draft.items[2].value]);assert.equal(f.connections.completeSelection(ctx,draft.id).added,1);
  f.connections.disconnect(ctx);assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM personal_selection_power').get().n,0);
});
test('an unavailable character power does not prevent looking up the next character',async t=>{
  const f=setup(t,()=>({listCharacters:async()=>[remote('A','a'),remote('B','b')],combatPower:async ocid=>{
    if(ocid==='a')throw Object.assign(new Error('missing'),{code:'NEXON_DATA'});return '9007199254740993';
  },close(){}}));
  await f.connections.connect(ctx,key);const draft=f.connections.beginSelection(ctx);await f.connections.loadSelectionPage(ctx,draft.id);
  const options=views.characterSelection(draft).components[0].toJSON().components[0].options;
  assert.match(options[0].label,/9,007,199,254,740,993/);assert.match(options[1].label,/조회 불가/);
});
test('disconnect during power lookup prevents stale cache writes',async t=>{
  let release;const f=setup(t,()=>({listCharacters:async()=>[remote()],combatPower:()=>new Promise(resolve=>release=()=>resolve('123')),close(){}}));
  await f.connections.connect(ctx,key);const draft=f.connections.beginSelection(ctx),work=f.connections.loadSelectionPage(ctx,draft.id);
  f.connections.disconnect(ctx);release();await assert.rejects(()=>work,{code:'KEY_CHANGED'});
  assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM personal_selection_power').get().n,0);
});
test('power-only lookup calls stats once and validates power without collecting equipment or skills',async()=>{
  const calls=[];let power='123456789';const api=new NexonClient({apiKey:key,sleep:async()=>{},fetchImpl:async url=>{
    calls.push(url);return {ok:true,json:async()=>({final_stat:[{stat_name:'전투력',stat_value:power}]})};
  }});
  assert.equal(await api.combatPower('private-ocid'),'123456789');assert.equal(calls.length,1);
  assert.ok(calls[0].pathname.endsWith('/character/stat'));assert.equal(calls[0].searchParams.get('ocid'),'private-ocid');
  power='unknown';await assert.rejects(()=>api.combatPower('private-ocid'),{code:'NEXON_DATA'});
});


test('power ranking promotes characters from later pages and sorts large integers exactly',async t=>{
  const items=Array.from({length:30},(_,i)=>({...remote(`캐릭터${i}`,`ocid-${i}`),level:300-i}));
  const powers={'ocid-29':'9007199254740993','ocid-28':'9007199254740992','ocid-27':'9007199254740993'};
  const f=setup(t,()=>({listCharacters:async()=>items,combatPower:async ocid=>powers[ocid]??'100',close(){}}));
  await f.connections.connect(ctx,key);const draft=f.connections.beginSelection(ctx);
  await Promise.all([f.connections.loadSelectionPage(ctx,draft.id),f.connections.loadSelectionPage(ctx,draft.id)]);
  assert.deepEqual(draft.items.slice(0,3).map(c=>c.name),['캐릭터27','캐릭터29','캐릭터28']);
  const top=draft.items[0].value;f.connections.selection(ctx,draft.id,0,[top]);
  const before=draft.items.map(c=>c.value);powers['ocid-0']='999999999999999999';
  await f.connections.loadSelectionPage(ctx,draft.id,1);assert.deepEqual(draft.items.map(c=>c.value),before);assert.ok(draft.selected.has(top));
  assert.equal(f.connections.completeSelection(ctx,draft.id).added,1);
  const removing=f.connections.beginSelection(ctx,'remove');await f.connections.loadSelectionPage(ctx,removing.id);
  assert.equal(removing.items[0].name,'캐릭터27');assert.equal(removing.items[0].combatPower,'9007199254740993');
});
