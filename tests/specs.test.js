import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { SpecTracker,specChanges } from '../src/specs.js';
import { NexonClient,kstDay } from '../src/nexon.js';
import { specDetail,specPicker } from '../src/views.js';
import { createHandler } from '../src/interactions.js';

const ctx={guildId:'g',threadId:'t',userId:'u',eligibleOwnerIds:new Set(['u'])};
const data=()=>({level:280,combatPower:'100000000',equipment:{무기:{item_name:'검',starforce:'22',item_total_option:{attack_power:'500'}}},skills:{'5':{'스킬':30}},unavailable:[],preset:1});
const result=()=>({ocid:'private-ocid',profile:{name:'캐릭터',world:'루나',job:'히어로'},data:data()});
function fixture(t,collect=async()=>result()) {
  const repository=new Repository(':memory:');t.after(()=>repository.close());
  const service=new PartyService(repository);service.start(ctx,'start');
  const c=service.register(ctx,{name:'캐릭터'},'register');
  let now=Date.UTC(2026,10,12,4);
  const api={collect},tracker=new SpecTracker({repository,service,api,now:()=>now});
  return {repository,service,c,tracker,advance:ms=>now+=ms};
}
test('sync fills profile, keeps daily history, uses stable OCID, and throttles refresh',async t=>{
  const calls=[];const f=fixture(t,async(name,ocid)=>{calls.push([name,ocid]);return result();});
  await f.tracker.sync(ctx,f.c.id);
  assert.equal(f.service.snapshot(ctx).characters[0].world,'루나');
  assert.equal((await f.tracker.sync(ctx,f.c.id)).cached,true);
  f.advance(86400_000);await f.tracker.sync(ctx,f.c.id,{automatic:true});
  assert.deepEqual(calls,[['캐릭터',undefined],['캐릭터','private-ocid']]);
  assert.equal(f.tracker.history(ctx,f.c.id).length,2);
  assert.throws(()=>f.service.editCharacter(ctx,f.c.id,{name:'다른캐릭터'},'rename'),{code:'LINKED_CHARACTER'});
});
test('failed collection preserves prior data; concurrent sync coalesces',async t=>{
  let fail=false,release;const f=fixture(t,async()=>{if(fail)throw new Error('network');await new Promise(r=>release=r);return result();});
  const a=f.tracker.sync(ctx,f.c.id),b=f.tracker.sync(ctx,f.c.id);release();await Promise.all([a,b]);
  assert.equal(f.tracker.history(ctx,f.c.id).length,1);
  fail=true;f.advance(86400_000);await assert.rejects(()=>f.tracker.sync(ctx,f.c.id));
  assert.equal(f.tracker.history(ctx,f.c.id).length,1);
});
test('pending collection cannot resurrect an unregistered character or override manual rename',async t=>{
  for(const action of ['unregister','rename']) {
    let release;const f=fixture(t,async()=>{await new Promise(r=>release=r);return result();});
    const work=f.tracker.sync(ctx,f.c.id);
    if(action==='unregister')f.service.unregister(ctx,f.c.id,'remove');
    else f.service.editCharacter(ctx,f.c.id,{name:'새이름'},'rename');
    release();await assert.rejects(()=>work);
    assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM spec_snapshots').get().n,0);
  }
});
test('manual values are owner-only, metric-specific and deduplicated',t=>{
  const f=fixture(t);
  assert.throws(()=>f.tracker.recordManual({...ctx,userId:'other'},f.c.id,65000,'헥사','x'),{code:'FORBIDDEN'});
  assert.throws(()=>f.tracker.recordManual(ctx,f.c.id,NaN,'헥사','x'));
  f.tracker.recordManual(ctx,f.c.id,65000,'헥사','manual');f.tracker.recordManual(ctx,f.c.id,65000,'헥사','manual');
  f.tracker.recordManual(ctx,f.c.id,50000,'주스탯','manual2');
  assert.equal(f.tracker.manualHistory(ctx,f.c.id).length,2);
  assert.throws(()=>f.tracker.history({...ctx,threadId:'elsewhere'},f.c.id),{code:'NOT_STARTED'});
});
test('retention removes expired API snapshots but keeps manual entries',async t=>{
  const f=fixture(t);await f.tracker.sync(ctx,f.c.id);f.tracker.recordManual(ctx,f.c.id,65000,'헥사','m');
  f.advance(30*86400_000);assert.equal(f.tracker.history(ctx,f.c.id).length,0);
  assert.equal(f.tracker.manualHistory(ctx,f.c.id).length,1);
});
test('daily scheduler resumes from database, skips ineligible owners and enforces daily budget',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return result();});
  await f.tracker.sweep({guildId:'g',canCollect:async()=>false});assert.equal(calls,0);
  await f.tracker.sweep({guildId:'g'});assert.equal(calls,1);
  const resumed=new SpecTracker({repository:f.repository,service:f.service,api:f.tracker.api,now:f.tracker.now});
  await resumed.sweep({guildId:'g'});assert.equal(calls,1);
  assert.equal(resumed.reserve(2),true);assert.equal(resumed.reserve(2),true);assert.equal(resumed.reserve(2),false);
  f.advance(86400_000);assert.equal(resumed.reserve(2),true);
});
test('diff detects equipment options and skill levels without treating unavailable sections as removal',()=>{
  const before=data(),after=data();after.level=281;after.combatPower='110000000';after.equipment.무기.starforce='23';after.equipment.무기.item_total_option.attack_power='550';after.skills['5']['스킬']=31;
  const changes=specChanges(before,after).join('\n');
  for(const pattern of [/레벨: 280 → 281/,/전투력:.*10000000/,/스타포스: 22 → 23/,/attack_power: 500 → 550/,/스킬: 30 → 31/]) assert.match(changes,pattern);
  after.skills={};assert.ok(!specChanges(before,after).some(x=>x.includes('스킬:')));
  after.equipment={};assert.match(specChanges(before,after).join('\n'),/검 → 미착용/);
});
test('view paginates changes and records within Discord limits without exposing OCID',()=>{
  const old=data(),next=data();next.equipment={};
  for(let n=0;n<100;n++)next.equipment[`슬롯${n}`]={item_name:'*'.repeat(100)};
  const history=[{...next,collectedAt:2,id:'new'},{...old,collectedAt:1,id:'old'}];
  for(let page=0;page<14;page++) {
    const payload=specDetail({id:'c',name:'A',ownerId:'u'},history,[],ctx,0,page);
    const json=payload.embeds[0].toJSON();assert.ok(json.fields.every(x=>x.value.length<=1024));
    assert.ok(payload.components.length<=5);payload.components.forEach(x=>x.toJSON());
    assert.ok(!JSON.stringify(payload).includes('private-ocid'));
  }
  specPicker({characters:[]}).components.forEach(x=>x.toJSON());
});
test('KST collection day rolls over independently of process timezone',()=>{
  assert.equal(kstDay(Date.parse('2026-11-12T14:59:59Z')),'2026-11-12');
  assert.equal(kstDay(Date.parse('2026-11-12T15:00:00Z')),'2026-11-13');
});
function apiFixture(overrides={}) {
  const paths=[];
  const client=new NexonClient({apiKey:'test-key',sleep:async()=>{},fetchImpl:async(url,options)=>{
    assert.equal(options.headers['x-nxopen-api-key'],'test-key');paths.push(url);
    const path=url.pathname.split('/').at(-1);let body;
    if(path==='id')body={ocid:'internal-id'};
    else if(path==='basic')body={character_name:'캐릭터',world_name:'루나',character_class:'히어로',character_level:280};
    else if(path==='stat')body={final_stat:[{stat_name:'전투력',stat_value:'100000000'}]};
    else if(path==='item-equipment')body={preset_no:1,item_equipment:[{item_equipment_slot:'무기',item_name:'검',starforce:'22',item_icon:'https://example.com/icon'}]};
    else if(path==='skill')body={character_skill:[{skill_name:'스킬',skill_level:30}]};
    else if(path==='vmatrix')body={character_v_core_equipment:[{v_core_name:'V스킬',v_core_level:30}]};
    else if(path==='hexamatrix')body={character_hexa_core_equipment:[{hexa_core_name:'VI스킬',hexa_core_level:10,hexa_core_event_level:0}]};
    if(path in overrides)body=overrides[path];
    return {ok:!body.error,json:async()=>body};
  }});return {client,paths};
}
test('official API paths normalize profile, active equipment, all skill grades and core levels',async()=>{
  const {client,paths}=apiFixture();const r=await client.collect('캐릭터');
  assert.equal(r.profile.world,'루나');assert.equal(r.data.skills['HEXA코어']['VI스킬'],10);
  assert.equal(r.data.equipment.무기.item_icon,undefined);
  assert.equal(paths[0].searchParams.get('character_name'),'캐릭터');
  assert.deepEqual(paths.filter(u=>u.pathname.endsWith('/skill')).map(u=>u.searchParams.get('character_skill_grade')),['0','1','2','3','4','hyperpassive','hyperactive','5','6']);
});
test('missing basic data and unavailable core stats do not create valid snapshots',async()=>{
  await assert.rejects(()=>apiFixture({basic:{character_name:null}}).client.collect('A'),{code:'NEXON_DATA'});
  await assert.rejects(()=>apiFixture({stat:{final_stat:[]}}).client.collect('A'),{code:'NEXON_DATA'});
  const partial=await apiFixture({skill:{error:{name:'OPENAPI00004'}}}).client.collect('A');
  assert.equal(partial.data.unavailable.length,9);assert.equal(partial.data.skills['5'],undefined);
});
test('API errors never expose upstream messages or credentials and budget blocks fetch',async()=>{
  const {client}=apiFixture({basic:{error:{name:'OPENAPI00005',message:'secret-key'}}});
  await assert.rejects(()=>client.collect('A'),error=>error.code==='OPENAPI00005'&&!error.message.includes('secret-key'));
  const denied=new NexonClient({apiKey:'x',reserve:()=>false,fetchImpl:()=>assert.fail('no fetch')});
  await assert.rejects(()=>denied.collect('A'),{code:'NEXON_BUDGET'});
});
test('Discord spec commands and buttons preserve owner permissions and render stored history',async t=>{
  const f=fixture(t),handler=createHandler({service:f.service,tracker:f.tracker,guildId:'g',verifyContext:async()=>ctx});
  function interaction(sub,owner='u') {return {id:`i-${sub}`,user:{id:owner},channel:{},outputs:[],isAutocomplete:()=>false,isChatInputCommand:()=>true,isButton:()=>false,isStringSelectMenu:()=>false,isModalSubmit:()=>false,
    commandName:'캐릭터',options:{getSubcommand:()=>sub,getString:key=>key==='캐릭터'?f.c.id:key==='종류'?'헥사':null,getNumber:()=>65000},
    async deferReply(){this.deferred=true;},async editReply(p){this.outputs.push(p);}};}
  const sync=interaction('스펙갱신');await handler(sync);assert.match(sync.outputs[0].embeds[0].toJSON().title,/스펙 변화/);
  const manual=interaction('환산기록');await handler(manual);assert.equal(f.tracker.manualHistory(ctx,f.c.id)[0].value,65000);
  const denied=createHandler({service:f.service,tracker:f.tracker,guildId:'g',verifyContext:async()=>({...ctx,userId:'other'})});
  const i=interaction('스펙갱신','other');await denied(i);assert.match(i.outputs[0].content,/본인/);
});

test('API client closes queued requests and cancels in-flight HTTP work',async()=>{
  let started;
  const ready=new Promise(resolve=>started=resolve);
  const client=new NexonClient({apiKey:'x',sleep:async()=>{},fetchImpl:async(url,{signal})=>{
    started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }});
  const work=client.request('id',{character_name:'A'});await ready;client.close();
  await assert.rejects(()=>work,{code:'NEXON_NETWORK'});
  await assert.rejects(()=>client.request('id'),{code:'NEXON_STOPPED'});
});
test('newly unlocked skill grades appear while previous unavailable grades do not fabricate changes',()=>{
  const before=data(),after=data();after.skills['6']={'새스킬':1};
  assert.match(specChanges(before,after).join('\n'),/새스킬: 미등록 → 1/);
  before.unavailable=['6'];assert.ok(!specChanges(before,after).some(x=>x.includes('새스킬')));
});
test('API-confirmed world conflict is visible without erasing party slots',async t=>{
  const f=fixture(t);const other=f.service.register({...ctx,userId:'other'},{name:'다른캐릭터',world:'스카니아',job:'비숍'},'other');
  const p=f.service.createParty(ctx,'A','party'),eligible={...ctx,eligibleOwnerIds:new Set(['u','other'])};
  f.service.addCharacter(eligible,p.id,f.c.id,'add');f.service.addCharacter(eligible,p.id,other.id,'add2');
  await f.tracker.sync(ctx,f.c.id);
  const party=f.service.getParty(ctx,p.id);assert.equal(party.characterIds.length,2);
  assert.match(f.service.warnings(f.service.snapshot(ctx),party).join('\n'),/서로 다른 월드/);
});
