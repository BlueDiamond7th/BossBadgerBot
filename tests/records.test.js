import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { PersonalConnections } from '../src/connections.js';
import { SpecTracker } from '../src/specs.js';
import { BossRecords, weekStart, clearedValue } from '../src/records.js';
import { PriceBook, DistributionBook } from '../src/revenue.js';
import { DEFAULT_CRYSTAL_PRICES } from '../src/catalog.js';
import { createHandler } from '../src/interactions.js';

const ctx=(userId='u1')=>({guildId:'g',threadId:'t',userId,isManager:false,eligibleOwnerIds:new Set(['u1','u2','u3'])});
const encryptionKey=Buffer.alloc(32,7).toString('base64');
const keyOf=user=>`personal-api-key-of-${user}-for-tests`;
const ACCOUNTS={u1:{name:'도토리',ocid:'o1'},u2:{name:'모찌',ocid:'o2'},u3:{name:'감자',ocid:'o3'}};
// 2026-11-12 (Thursday) 10:00 KST: this week started today, last week ended 2026-11-11.
const START=Date.parse('2026-11-12T01:00:00Z');

function setup(t,{connect=['u1','u2','u3']}={}) {
  const repository=new Repository(':memory:');t.after(()=>repository.close());
  const service=new PartyService(repository);service.start(ctx(),'start');
  let now=START;const calls=[];
  const factory=({apiKey})=>{
    const user=Object.keys(ACCOUNTS).find(u=>keyOf(u)===apiKey),a=ACCOUNTS[user];
    return {close(){},
      async listCharacters() {calls.push({user,path:'list'});return [{ocid:a.ocid,name:a.name,world:'루나',job:'히어로',level:280}];},
      async scheduler(ocid,date=null) {
        calls.push({user,path:'scheduler',ocid,date});
        assert.equal(ocid,a.ocid,'a key only reads its own account');
        return {date:date??'2026-11-12',daily:[],weekly:[],weeklyBossCount:date?12:2,weeklyBossLimit:12,bosses:[
          {name:'스우',difficulty:'extreme',cycle:'bossWeekly',complete:true,registered:true},
          {name:'감시자 칼로스',difficulty:'chaos',cycle:'bossWeekly',complete:Boolean(date),registered:true},
          {name:'검은 마법사',difficulty:'extreme',cycle:'bossMonthly',complete:false,registered:true},
          {name:'자쿰',difficulty:'chaos',cycle:'bossWeekly',complete:true,registered:false},
        ]};
      }};
  };
  const connections=new PersonalConnections({repository,service,encryptionKey,clientFactory:factory,now:()=>now});
  const tracker=new SpecTracker({repository,service,connections,now:()=>now});
  const records=new BossRecords({repository,service,tracker,connections,now:()=>now});
  return {repository,service,connections,tracker,records,calls,advance:ms=>now+=ms,
    async ready() {
      for(const u of connect) {
        await connections.connect(ctx(u),keyOf(u));
        const draft=connections.beginSelection(ctx(u));connections.selection(ctx(u),draft.id,0,draft.items.map(c=>c.value));connections.completeSelection(ctx(u),draft.id);
      }
      const s=service.snapshot(ctx()),chars=Object.fromEntries(Object.keys(ACCOUNTS).map(u=>[u,s.characters.find(c=>c.ownerId===u)]));
      const p=service.createParty(ctx(),'목요일팟','party');
      for(const u of ['u1','u2']) if(chars[u]) service.addCharacter(ctx(),p.id,chars[u].id,`add-${u}`);
      calls.length=0;return {chars,party:service.getParty(ctx(),p.id)};
    }};
}
const schedulerCalls=calls=>calls.filter(c=>c.path==='scheduler');

test('weekly boss weeks start on Thursday 00:00 KST',()=>{
  assert.equal(weekStart(START),'2026-11-12');
  assert.equal(weekStart(Date.parse('2026-11-11T14:59:00Z')),'2026-11-05');
  assert.equal(weekStart(Date.parse('2026-11-11T15:00:00Z')),'2026-11-12');
  assert.equal(weekStart(Date.parse('2026-11-18T12:00:00Z')),'2026-11-12');
});
test('boss records read the scheduler cache and never relist the account',async t=>{
  const f=setup(t),{chars}=await f.ready();
  // The hourly sweep already stored today's scheduler state.
  await f.tracker.syncScheduler(ctx('u1'),chars.u1.id,{automatic:true});
  assert.equal(schedulerCalls(f.calls).length,1);
  const viewed=await f.records.view(ctx(),chars.u1.id);
  assert.equal(viewed.fetched,false);assert.equal(viewed.record.week,'2026-11-12');assert.equal(viewed.record.clearCount,2);
  await f.records.view(ctx('u2'),chars.u1.id);
  assert.equal(schedulerCalls(f.calls).length,1);
  assert.equal(f.calls.filter(c=>c.path==='list').length,0,'ocid comes from the stored connection');
});
test('an empty cache is filled once, and refresh within five minutes is answered from cache',async t=>{
  const f=setup(t),{chars}=await f.ready();
  const first=await f.records.view(ctx(),chars.u1.id);
  assert.equal(first.fetched,true);assert.equal(schedulerCalls(f.calls).length,1);
  assert.equal((await f.records.view(ctx(),chars.u1.id)).fetched,false);
  assert.deepEqual(await f.records.refresh(ctx(),chars.u1.id,'current'),{cached:true});
  assert.equal(schedulerCalls(f.calls).length,1);
  f.advance(6*60_000);
  assert.deepEqual(await f.records.refresh(ctx(),chars.u1.id,'current'),{cached:false});
  assert.equal(schedulerCalls(f.calls).length,2);
});
test('last week is read once by date and then kept as a final record',async t=>{
  const f=setup(t),{chars}=await f.ready();
  const last=await f.records.view(ctx(),chars.u1.id,'last');
  assert.deepEqual(schedulerCalls(f.calls).map(c=>c.date),['2026-11-11']);
  assert.equal(last.record.week,'2026-11-05');assert.equal(last.record.final,true);assert.equal(last.record.clearCount,12);
  assert.deepEqual(last.record.cleared.map(b=>`${b.difficulty} ${b.name}`),['익스트림 스우','카오스 감시자 칼로스','카오스 자쿰']);
  assert.equal(clearedValue(last.record.cleared,DEFAULT_CRYSTAL_PRICES),545_000_000+1_230_000_000);
  assert.deepEqual(await f.records.refresh(ctx(),chars.u1.id,'last'),{cached:true});
  assert.equal(schedulerCalls(f.calls).length,1);
});
test('a mid-day sweep snapshot of last Wednesday is not final, so refresh reads that day again',async t=>{
  const f=setup(t),{chars}=await f.ready();
  f.repository.db.prepare('INSERT INTO scheduler_snapshots VALUES(?,?,?,?,?,?)').run('g','t',chars.u1.id,'2026-11-11',START-12*3600_000,JSON.stringify({date:'2026-11-11',bosses:[],weeklyBossCount:3,weeklyBossLimit:12}));
  const cached=await f.records.view(ctx(),chars.u1.id,'last');
  assert.equal(cached.fetched,false);assert.equal(cached.record.final,false);assert.equal(cached.record.clearCount,3);
  await f.records.refresh(ctx(),chars.u1.id,'last');
  assert.equal(f.records.cached(ctx(),chars.u1.id,'last').clearCount,12);
});
test('party members read with the owner key; others and unconnected owners are refused',async t=>{
  const f=setup(t,{connect:['u1','u3']}),{chars,party}=await f.ready();
  // u2 never connected a key; a manual registration still lets them join the party.
  const manual=f.service.register(ctx('u2'),{name:'모찌',world:'루나'},'manual');
  f.service.addCharacter(ctx(),party.id,manual.id,'add-manual');
  await f.records.view(ctx('u2'),chars.u1.id);
  assert.equal(schedulerCalls(f.calls)[0].user,'u1');
  await assert.rejects(f.records.view(ctx('u3'),chars.u1.id),{code:'FORBIDDEN'});
  assert.throws(()=>f.records.history(ctx('u3'),chars.u1.id),{code:'FORBIDDEN'});
  await assert.rejects(f.records.view(ctx(),manual.id),/등록자가 아직 API 키를 연결하지 않았어요/);
});
test('saving requires the record that was shown and overwrites the same week',async t=>{
  const f=setup(t),{chars}=await f.ready();
  const {record}=await f.records.view(ctx(),chars.u1.id);
  assert.throws(()=>f.records.save(ctx(),chars.u1.id,record.day,record.collectedAt-1),{code:'STALE'});
  f.records.save(ctx('u2'),chars.u1.id,record.day,record.collectedAt);
  f.advance(6*60_000);await f.records.refresh(ctx(),chars.u1.id,'current');
  const newer=f.records.cached(ctx(),chars.u1.id,'current');
  f.records.save(ctx(),chars.u1.id,newer.day,newer.collectedAt);
  const weeks=f.records.history(ctx(),chars.u1.id).weeks;
  assert.equal(weeks.length,1);assert.equal(weeks[0].savedBy,'u1');assert.equal(weeks[0].collectedAt,newer.collectedAt);
});

let n=0;
function fake(type,properties={}) {
  return {id:`i${++n}`,user:{id:'u1'},guildId:'g',channel:{id:'t',isThread:()=>true},deferred:false,replied:false,outputs:[],followUps:[],
    inGuild:()=>true,isAutocomplete:()=>false,isChatInputCommand:()=>type==='command',isButton:()=>type==='button',isStringSelectMenu:()=>type==='select',isUserSelectMenu:()=>type==='user',isModalSubmit:()=>type==='modal',
    message:{flags:{has:()=>true}},
    async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async deleteReply(){},
    async editReply(p){this.outputs.push(p);},async reply(p){this.replied=true;this.outputs.push(p);},async followUp(p){if(p.flags===MessageFlags.Ephemeral)this.outputs.push(p);else this.followUps.push(p);},async showModal(p){this.replied=true;this.outputs.push(p);},...properties};
}
const command=(root,sub,values={},user='u1')=>fake('command',{user:{id:user},commandName:root,options:{getSubcommand:()=>sub,getString:k=>values[k]??null,getBoolean:()=>null,getUser:()=>null,getNumber:()=>null}});
const fields=values=>({getTextInputValue:k=>values[k]});
async function handlerFor(t) {
  const f=setup(t),ids=await f.ready(),prices=new PriceBook(f.repository),distributions=new DistributionBook({repository:f.repository,service:f.service});
  const handler=createHandler({service:f.service,guildId:'g',tracker:f.tracker,connections:f.connections,records:f.records,prices,distributions,verifyContext:async i=>({...ctx(i.user.id)}),resolveOwners:async(_,list)=>new Set(list)});
  return {...f,...ids,handler,distributions,prices};
}

test('boss record command shows cache with yes/no/refresh and notifies the viewed member',async t=>{
  const {handler,chars,calls,advance}=await handlerFor(t);
  const view=command('보스기록','조회',{'캐릭터':chars.u1.id,'주차':'last'},'u2');await handler(view);
  assert.equal(view.outputs[0].content,'불러온 보스 기록을 저장할까요?');
  const buttons=view.outputs[0].components[0].toJSON().components;
  assert.deepEqual(buttons.map(b=>b.label),['예','아니오','갱신']);
  assert.match(view.outputs[0].embeds[0].toJSON().description,/방금 API에서 불러왔어요/);
  assert.match(view.followUps[0].content,/^<@u1> <@u2>님이/);assert.deepEqual(view.followUps[0].allowedMentions,{users:['u1']});
  // Second look is served from cache: no API call and no repeated mention.
  const again=command('보스기록','조회',{'캐릭터':chars.u1.id,'주차':'last'},'u2');await handler(again);
  assert.match(again.outputs[0].embeds[0].toJSON().description,/수집한 캐시예요\. \(지난 날짜 확정 기록\)/);
  const refresh=fake('button',{user:{id:'u2'},customId:buttons[2].custom_id});await handler(refresh);
  assert.match(refresh.outputs[0].content,/다시 조회하지 않았어요/);assert.equal(refresh.followUps.length,0);
  assert.equal(schedulerCalls(calls).length,1);
  const save=fake('button',{user:{id:'u2'},customId:buttons[0].custom_id});await handler(save);
  assert.match(save.outputs[0].content,/저장했어요/);
  const own=command('보스기록','히스토리',{'캐릭터':chars.u1.id});await handler(own);
  assert.equal(own.followUps.length,0);
  assert.match(own.outputs[0].embeds[0].toJSON().fields[0].name,/^2026-11-05 주차 · 12\/12/);
  // A current-week refresh after the cache window calls the API and notifies again.
  const current=command('보스기록','조회',{'캐릭터':chars.u1.id},'u2');await handler(current);
  advance(6*60_000);
  const fresh=fake('button',{user:{id:'u2'},customId:current.outputs[0].components[0].toJSON().components[2].custom_id});await handler(fresh);
  assert.equal(fresh.followUps.length,1);assert.equal(schedulerCalls(calls).length,3);
});
test('distribution flow: question, seller must be in party, result card, seller-only edits',async t=>{
  const {handler,party,distributions}=await handlerFor(t);
  const ask=fake('button',{customId:`mp:dist:${party.id}`});await handler(ask);
  assert.match(ask.outputs[0].content,/분배할 아이템이 있나요/);
  const no=fake('button',{customId:`mp:distno:${party.id}`});await handler(no);assert.match(no.outputs[0].content,/진행하지 않았어요/);
  const yes=fake('button',{customId:`mp:distyes:${party.id}`});await handler(yes);
  assert.equal(yes.outputs[0].components[0].toJSON().components[0].type,5);
  const outsider=fake('user',{customId:`mp:distseller:${party.id}`,values:['u3']});await handler(outsider);
  assert.equal(outsider.outputs[0].content,'해당 파티의 인원이 아닙니다.');assert.equal(outsider.outputs[0].flags,MessageFlags.Ephemeral);
  const seller=fake('user',{customId:`mp:distseller:${party.id}`,values:['u2']});await handler(seller);
  const modalId=seller.outputs[0].toJSON().custom_id;assert.equal(modalId,`mp:modal:dist:${party.id}:u2`);
  const submit=fake('modal',{customId:modalId,fields:fields({item:'미트라의 분노',price:'10억'}),message:undefined});await handler(submit);
  const card=submit.followUps[0].embeds[0].toJSON().description;
  assert.match(card,/판매자 닉네임 : <@u2>/);assert.match(card,/거래금 - 10억 메소/);
  assert.match(card,/판매자 실수령액 - 9억 5,000만 메소/);assert.match(card,/최종 수령 금액 \(2명 기준\) - 4억 5,125만 메소/);
  assert.doesNotMatch(card,/MVP/);
  const id=distributions.list(ctx(),party.id)[0].id;
  const notSeller=fake('button',{customId:`mp:distedit:${id}`});await handler(notSeller);assert.match(notSeller.outputs[0].content,/판매자로 지정된 사람만/);
  const edited=[];const publicMessage={flags:{has:()=>false},async edit(p){edited.push(p);}};
  const mvp=fake('button',{user:{id:'u2'},customId:`mp:distmvp:${id}`,message:publicMessage});await handler(mvp);
  assert.match(edited[0].embeds[0].toJSON().description,/MVP 할인가 - 9억 7,000만 메소[\s\S]*MVP 할인가 - 4억 7,045만 메소/);
  const editOpen=fake('button',{user:{id:'u2'},customId:`mp:distedit:${id}`});await handler(editOpen);
  const editModal=editOpen.outputs[0].toJSON();
  assert.equal(editModal.components[1].components[0].value,'1000000000');assert.equal(editModal.components[2].components[0].value,'2');
  const editSubmit=fake('modal',{user:{id:'u2'},customId:`mp:modal:distedit:${id}`,fields:fields({item:'미트라의 분노',price:'12억',members:'3'})});await handler(editSubmit);
  const after=distributions.get(ctx(),id);assert.equal(after.price,1_200_000_000);assert.equal(after.memberCount,3);assert.equal(distributions.edits(id).length,2);
  const editedCard=editSubmit.outputs[0].embeds[0].toJSON();
  // 12억 × 0.97 = 11억 6,400만; ÷ 3 × 0.97 = 3억 7,636만
  assert.match(editedCard.description,/최종 수령 금액 \(3명 기준\) - 3억 6,100만 메소\nMVP 할인가 - 3억 7,636만 메소/);
  assert.equal(editedCard.fields[0].name,'계산식');assert.match(editedCard.fields[0].value,/MVP 최종 수령 금액 = MVP 실수령액 ÷ 3 × 0\.97$/);
});
test('crystal price command updates the table shown in party revenue',async t=>{
  const {handler,service,party}=await handlerFor(t);
  service.addBoss(ctx(),party.id,'kalos','카오스','boss');
  const set=command('결정석','가격수정',{'보스':'kalos','난이도':'카오스','가격':'13억'});await handler(set);
  assert.match(set.outputs[0].content,/12억 3,000만 메소 → 13억 메소/);
  const detail=fake('button',{customId:`mp:detail:${party.id}`});await handler(detail);
  const field=detail.outputs[0].embeds[0].toJSON().fields.find(f=>f.name.startsWith('결정석 수익'));
  assert.match(field.value,/카오스 감시자 칼로스: 6억 5,000만 메소 \(13억 메소 ÷ 2명\)/);
});
