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
  const factory=options=>{const client=clientFactory?clientFactory(options):{listCharacters:async()=>[remote()],scheduler:async()=>scheduler(),collect:async()=>collected(),close(){this.closed=true;}};clients.push(client);return client;};
  const connections=new PersonalConnections({repository,service,encryptionKey,clientFactory:factory,now:()=>now});
  const tracker=new SpecTracker({repository,service,connections,now:()=>now});
  // Connect, then pick account characters one by one (default: all of them).
  const link=async(c=ctx,k=key,pick=()=>true)=>{const r=await connections.connect(c,k);for(const a of connections.accountCharacters(c))if(!a.linked&&pick(a))connections.select(c,a.id);return r;};
  return {repository,service,connections,tracker,clients,link,advance:ms=>now+=ms};
}
test('vault encrypts with authenticated context and rejects missing/wrong/tampered keys',()=>{
  const vault=new KeyVault(encryptionKey),sealed=vault.seal(key,'g:t:u');
  assert.equal(vault.open(sealed,'g:t:u'),key);assert.ok(!sealed.includes(key));
  assert.notEqual(vault.seal(key,'g:t:u'),sealed);
  assert.throws(()=>vault.open(sealed,'g:t:other'),{code:'KEY_DECRYPT'});
  assert.throws(()=>new KeyVault(Buffer.alloc(32,8).toString('base64')).open(sealed,'g:t:u'),{code:'KEY_DECRYPT'});
  assert.throws(()=>new KeyVault().seal(key,'g:t:u'),{code:'KEY_CONFIG'});
  const tampered=JSON.parse(sealed);tampered.data='AAAA';assert.throws(()=>vault.open(JSON.stringify(tampered),'g:t:u'),{code:'KEY_DECRYPT'});
});
test('connect lists account characters privately and registers only the one the user picks',async t=>{
  const f=setup(t,()=>({listCharacters:async()=>Array.from({length:35},(_,i)=>({...remote(`캐ラ${i}`,`ocid-${i}`),level:200+i})),close(){}}));
  const result=await f.connections.connect(ctx,key);assert.equal(result.total,35);
  assert.equal(f.service.snapshot(ctx).characters.length,0,'nothing joins the boss room before a pick');
  const list=f.connections.accountCharacters(ctx);assert.equal(list.length,35);assert.equal(list[0].level,234,'highest level first');
  const picked=f.connections.select(ctx,list[0].id);assert.equal(picked.added,true);assert.equal(picked.character.name,'캐ラ34');
  assert.equal(f.service.snapshot(ctx).characters.length,1);
  assert.throws(()=>f.connections.select(ctx,list[0].id),{code:'DUPLICATE'});
  assert.equal(f.connections.accountCharacters(ctx).filter(c=>c.linked).length,1);
  assert.deepEqual([f.connections.status(ctx).count,f.connections.status(ctx).accountCount],[1,35]);
  const dbRows=JSON.stringify(['personal_connections','personal_characters','personal_account_characters'].flatMap(t=>f.repository.db.prepare(`SELECT * FROM ${t}`).all()));
  assert.ok(!dbRows.includes(key));assert.ok(!dbRows.includes('ocid-0'));
  assert.ok(!JSON.stringify(list).includes('ocid-'),'picker never exposes OCIDs');
  assert.equal(f.connections.status({...ctx,userId:'other'}).connected,false);
  assert.throws(()=>f.connections.accountCharacters({...ctx,userId:'other'}),{code:'KEY_MISSING'});
  assert.equal(f.connections.status({...ctx,threadId:'other'}).count,0);
  assert.ok(!JSON.stringify(f.connections.status(ctx)).includes(key));
  f.connections.disconnect(ctx);assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM personal_account_characters').get().n,0);
});
test('picking keeps an existing own character and party IDs, and refuses another user registration',async t=>{
  const f=setup(t,()=>({listCharacters:async()=>[remote(),remote('친구','other-ocid')],close(){}}));
  const c=f.service.register(ctx,{name:'캐릭터'},'legacy'),other=f.service.register({...ctx,userId:'other'},{name:'친구'},'other');
  const p=f.service.createParty(ctx,'A','party');f.service.addCharacter(ctx,p.id,c.id,'add');
  await f.connections.connect(ctx,key);
  const [mine,friend]=['캐릭터','친구'].map(n=>f.connections.accountCharacters(ctx).find(a=>a.name===n));
  const linked=f.connections.select(ctx,mine.id);assert.equal(linked.added,false);assert.equal(linked.character.id,c.id);
  assert.throws(()=>f.connections.select(ctx,friend.id),{code:'DUPLICATE'});
  assert.deepEqual(f.service.getParty(ctx,p.id).characterIds,[c.id]);
  assert.equal(f.service.snapshot(ctx).characters.find(x=>x.id===other.id).ownerId,'other');
  f.advance(6*3600_000);await f.connections.refresh(ctx);assert.equal(f.service.snapshot(ctx).characters.length,2);
  assert.equal(f.connections.session(ctx,c).ocid,'private-ocid');
});
test('a connection made before the picker shows a sync prompt instead of an empty list',async t=>{
  const f=setup(t);await f.connections.connect(ctx,key);
  f.repository.db.prepare('DELETE FROM personal_account_characters').run();
  const panel=views.accountPicker(f.connections.accountCharacters(ctx));
  assert.match(panel.content,/캐릭터 동기화를 눌러/);assert.equal(panel.components[0].toJSON().components[0].custom_id,'mp:accountsync');
  f.advance(6*3600_000);await f.connections.refresh(ctx);
  assert.equal(views.accountPicker(f.connections.accountCharacters(ctx)).components[0].toJSON().components[0].custom_id,'mp:accountselect');
});
test('sync refreshes linked characters and the candidate list without registering new characters',async t=>{
  let items=[remote()];const f=setup(t,()=>({listCharacters:async()=>items,close(){}}));
  await f.link();const c=f.service.snapshot(ctx).characters[0];
  items=[{...remote('새이름'),job:'팔라딘'},remote('새캐릭','new-ocid')];f.advance(6*3600_000);
  const result=await f.connections.refresh(ctx);assert.deepEqual([result.total,result.updated],[2,1]);
  const state=f.service.snapshot(ctx);assert.equal(state.characters.length,1);
  assert.deepEqual([state.characters[0].id,state.characters[0].name,state.characters[0].job],[c.id,'새이름','팔라딘']);
  assert.deepEqual(f.connections.accountCharacters(ctx).map(a=>[a.name,a.linked]),[['새이름',true],['새캐릭',false]]);
  assert.throws(()=>f.connections.select(ctx,'unknown'),{code:'KEY_CHARACTER'});
});
test('bad replacement retains old connection; valid rotation invalidates old leases; stale unlink cannot delete new key',async t=>{
  const f=setup(t,({apiKey})=>({listCharacters:async()=>{if(apiKey==='bad-key-'.repeat(5))throw new Error('bad');return [remote()];},close(){this.closed=true;}}));
  await f.link();const version=f.connections.row(ctx).version,c=f.service.snapshot(ctx).characters[0];
  const session=f.connections.session(ctx,c);
  await assert.rejects(()=>f.connections.connect(ctx,'bad-key-'.repeat(5)));
  assert.equal(f.connections.row(ctx).version,version);session.assertCurrent();
  await f.connections.connect(ctx,'new-key-'.repeat(5));assert.equal(session.api.closed,true);
  assert.throws(()=>session.assertCurrent(),{code:'KEY_CHANGED'});
  assert.throws(()=>f.connections.disconnect(ctx,version),{code:'KEY_CHANGED'});
  assert.equal(f.connections.status(ctx).connected,true);
});
test('disconnect during initial validation prevents a late request from restoring the key',async t=>{
  let release;const f=setup(t,()=>({listCharacters:()=>new Promise(resolve=>release=()=>resolve([remote()])),close(){}}));
  const work=f.connections.connect(ctx,key);f.connections.disconnect(ctx);release();
  await assert.rejects(()=>work,{code:'KEY_CHANGED'});assert.equal(f.connections.status(ctx).connected,false);
});
test('only the newest concurrent connect may publish the account list',async t=>{
  const releases=[];const f=setup(t,()=>({listCharacters:()=>new Promise(resolve=>releases.push(()=>resolve([remote()]))),close(){}}));
  const first=f.connections.connect(ctx,key),second=f.connections.connect(ctx,'another-key-'.repeat(4));
  releases[1]();await second;releases[0]();await assert.rejects(()=>first,{code:'KEY_CHANGED'});
  assert.equal(f.connections.accountCharacters(ctx).length,1);assert.equal(f.service.snapshot(ctx).characters.length,0);
});
test('personal spec collection uses encrypted binding and never saves plaintext personal OCID to legacy profile table',async t=>{
  const f=setup(t);await f.link();const c=f.service.snapshot(ctx).characters[0];
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
    await f.link();const c=f.service.snapshot(ctx).characters[0];
    const work=kind==='spec'?f.tracker.sync(ctx,c.id):f.tracker.syncScheduler(ctx,c.id);
    f.connections.disconnect(ctx);release();await assert.rejects(()=>work,{code:'KEY_CHANGED'});
    assert.equal(f.tracker.history(ctx,c.id).length,0);assert.equal(f.tracker.schedulerHistory(ctx,c.id).length,0);
  }
});
test('scheduler is owner-only, daily upserted, cached, persisted and retained for 14 days',async t=>{
  let calls=0;const f=setup(t,()=>({listCharacters:async()=>[remote()],scheduler:async()=>{calls++;return scheduler();},close(){}}));
  await f.link();const c=f.service.snapshot(ctx).characters[0];
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
  await f.link();const c=f.service.snapshot(ctx).characters[0];
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
  const f=setup(t);await f.link();const c=f.service.snapshot(ctx).characters[0];await f.tracker.syncScheduler(ctx,c.id);
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
  await f.link();const other={...ctx,userId:'other'};await f.link(other,'other-api-key-'.repeat(3));
  await f.tracker.sweep({guildId:'g'});
  const friend=f.service.snapshot(ctx).characters.find(c=>c.ownerId==='other');
  assert.equal(collectedOther,1);assert.equal(f.tracker.schedulerHistory(other,friend.id).length,1);
});
test('empty or failed scheduler responses preserve prior daily status',async t=>{
  let fail=false;const f=setup(t,()=>({listCharacters:async()=>[remote()],scheduler:async()=>{if(fail)throw Object.assign(new Error('no data'),{code:'NEXON_NO_SCHEDULER'});return scheduler();},close(){}}));
  await f.link();const c=f.service.snapshot(ctx).characters[0];await f.tracker.syncScheduler(ctx,c.id);
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
  const f=setup(t);await f.link();const c=f.service.snapshot(ctx).characters[0];
  let supplied;
  const restarted=new PersonalConnections({repository:f.repository,service:f.service,encryptionKey,now:f.tracker.now,clientFactory:options=>{supplied=options.apiKey;return {};}});
  assert.equal(restarted.session(ctx,c).ocid,'private-ocid');assert.equal(supplied,key);
});

test('account list removal invalidates already running character collection',async t=>{
  let release,items=[remote()];const f=setup(t,()=>({listCharacters:async()=>items,collect:()=>new Promise(r=>release=()=>r(collected())),close(){}}));
  await f.link();const c=f.service.snapshot(ctx).characters[0];const work=f.tracker.sync(ctx,c.id);
  items=[];f.advance(6*3600_000);await f.connections.refresh(ctx);release();
  await assert.rejects(()=>work,{code:'KEY_CHARACTER'});assert.equal(f.tracker.history(ctx,c.id).length,0);
});
