import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { PersonalConnections } from '../src/connections.js';
import { SpecTracker } from '../src/specs.js';
import { BossRecords, weekStart, clearedValue, entryLimit, entryShare } from '../src/records.js';
import { PriceBook, DistributionBook } from '../src/revenue.js';
import { DEFAULT_CRYSTAL_PRICES } from '../src/catalog.js';
import { createHandler } from '../src/interactions.js';

const block=text=>{const m=String(text).match(/```ansi\n([\s\S]*?)\n```/);return m?m[1].replace(/\u001b\[[\d;]*m/g,'').split('\n').map(l=>l.replace(/\s+/g,' ').trim()):[];};
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
  assert.deepEqual(block(field.value),['CHAOS 감시자 칼로스 6억 5,000만 메소 (13억 메소 ÷ 2명)']);assert.match(field.value,/\*\*주간 합계 6억 5,000만 메소\*\*$/);
});

test('saved clears can be split by party size up to each boss limit, owner only, and survive re-saving',async t=>{
  const f=setup(t),{chars}=await f.ready();
  const {record}=await f.records.view(ctx(),chars.u1.id,'last');f.records.save(ctx(),chars.u1.id,record.day,record.collectedAt);
  const prices=DEFAULT_CRYSTAL_PRICES;
  assert.deepEqual(f.records.week(ctx(),chars.u1.id,'2026-11-05').week.cleared.map(b=>[b.name,entryLimit(b)]),[['스우',2],['감시자 칼로스',6],['자쿰',6]]);
  assert.equal(entryLimit({bossId:'adversary',difficulty:'하드'}),3);
  const edited=f.records.setPartySize(ctx(),chars.u1.id,'2026-11-05',0,1,3);
  assert.equal(edited.week.rev,1);assert.equal(entryShare(edited.week.cleared[1],prices),410_000_000);
  assert.equal(clearedValue(edited.week.cleared,prices),545_000_000+410_000_000);
  assert.throws(()=>f.records.setPartySize(ctx(),chars.u1.id,'2026-11-05',0,0,2),{code:'STALE'});
  assert.throws(()=>f.records.setPartySize(ctx(),chars.u1.id,'2026-11-05',1,0,3),/1~2명/);
  assert.throws(()=>f.records.setPartySize(ctx('u2'),chars.u1.id,'2026-11-05',1,0,2),{code:'FORBIDDEN'});
  f.records.setPartySize(ctx(),chars.u1.id,'2026-11-05',1,0,2);
  f.records.save(ctx(),chars.u1.id,record.day,record.collectedAt);
  assert.deepEqual(f.records.week(ctx(),chars.u1.id,'2026-11-05').week.cleared.map(b=>b.partySize??1),[2,3,1]);
});

const weekMenu=out=>out.components[0].toJSON().components[0];
test('history dropdown lists saved weeks plus unsaved this/last week as "n월 n주차"',async t=>{
  const {handler,chars,calls}=await handlerFor(t);
  const open=command('보스기록','히스토리',{'캐릭터':chars.u1.id},'u2');await handler(open);
  assert.match(open.followUps[0].content,/^<@u1> <@u2>님이 \*\*도토리\*\*의 보스 히스토리/);
  const menu=weekMenu(open.outputs[0]);
  assert.equal(menu.custom_id,`mp:bhpick:${chars.u1.id}`);
  assert.deepEqual(menu.options.map(o=>[o.label,o.description]),[
    ['11월 2주차 (11/12~11/18)','이번 주 · 저장 전 (선택하면 불러와요)'],
    ['11월 1주차 (11/5~11/11)','지난주 · 저장 전 (선택하면 불러와요)']]);
  assert.equal(open.outputs[0].embeds[0].toJSON().fields,undefined,'nothing is printed until a week is picked');
  assert.equal(schedulerCalls(calls).length,0,'opening the history never calls the API');
});
test('picking an unsaved week loads a preview once; saving makes it a saved week that is never requested again',async t=>{
  const {handler,chars,calls}=await handlerFor(t);
  const pick=fake('select',{customId:`mp:bhpick:${chars.u1.id}`,values:['2026-11-05']});await handler(pick);
  assert.equal(pick.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 1주차 (11/5~11/11) 보스 기록 (저장 전)');
  const buttons=pick.outputs[0].components[0].toJSON().components;
  assert.deepEqual(buttons.map(b=>b.label),['저장','저장 안 함','갱신','히스토리로']);
  assert.equal(schedulerCalls(calls).length,1);
  // Owner saves → party-size editor; set 칼로스 to 2 people.
  const save=fake('button',{customId:buttons[0].custom_id});await handler(save);
  assert.equal(save.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 1주차 (11/5~11/11) 편집');
  const boss=fake('select',{customId:save.outputs[0].components[0].toJSON().components[0].custom_id,values:['1']});await handler(boss);
  await handler(fake('select',{customId:boss.outputs[0].components[0].toJSON().components[0].custom_id,values:['2']}));
  // The reported bug: picking the saved week again must show the saved result, not ask to load or save.
  for(let n=0;n<3;n++) {
    const again=fake('select',{customId:`mp:bhpick:${chars.u1.id}`,values:['2026-11-05']});await handler(again);
    const emb=again.outputs[0].embeds[0].toJSON();
    assert.equal(again.outputs[0].content,null);assert.equal(emb.title,'도토리 · 11월 1주차 (11/5~11/11)');
    assert.ok(block(emb.description).includes('2. CHAOS 감시자 칼로스 · 12억 3,000만 메소 ÷ 2명 = 6억 1,500만 메소'));
    assert.ok(!JSON.stringify(again.outputs[0].components.map(r=>r.toJSON())).includes('bhsave'));
  }
  // Old "지난주 불러오기" buttons from earlier messages also show the saved week.
  const legacy=fake('button',{customId:`mp:bhload:${chars.u1.id}:last`});await handler(legacy);
  assert.equal(legacy.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 1주차 (11/5~11/11)');
  assert.equal(schedulerCalls(calls).length,1,'no further API requests after saving');
  // Opening the history now defaults to the saved week, marked as saved in the dropdown.
  const open=command('보스기록','히스토리',{'캐릭터':chars.u1.id});await handler(open);
  const menu=weekMenu(open.outputs[0]);
  assert.match(menu.options[1].description,/^지난주 · 저장됨 · 클리어 3개 · 1인 몫/);assert.equal(menu.options[1].default,true);
  assert.equal(open.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 1주차 (11/5~11/11)');
  assert.deepEqual(open.outputs[0].components.slice(1,3).map(r=>r.toJSON().components.map(b=>b.label)),[['이번 주 저장'],['인원 편집','다른 캐릭터']]);
});
test('a saved current week offers an explicit reload; party members see results without edit controls',async t=>{
  const {handler,chars,calls,advance}=await handlerFor(t);
  const pick=fake('select',{user:{id:'u2'},customId:`mp:bhpick:${chars.u1.id}`,values:['2026-11-12']});await handler(pick);
  assert.match(pick.followUps[0].content,/^<@u1> <@u2>님이/);assert.deepEqual(pick.followUps[0].allowedMentions,{users:['u1']});
  const save=fake('button',{user:{id:'u2'},customId:pick.outputs[0].components[0].toJSON().components[0].custom_id});await handler(save);
  assert.match(save.outputs[0].content,/저장했어요/);assert.equal(save.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 2주차 (11/12~11/18)');
  assert.deepEqual(save.outputs[0].components.slice(1,3).map(r=>r.toJSON().components.map(b=>b.label)),[['지난주 저장'],['이번 주 다시 불러오기','다른 캐릭터']],'a party member cannot edit sizes');
  const sneak=fake('button',{user:{id:'u2'},customId:`mp:bhedit:${chars.u1.id}:2026-11-12`});await handler(sneak);assert.match(sneak.outputs[0].content,/본인만 보스 기록을 편집/);
  const calm=fake('select',{user:{id:'u2'},customId:`mp:bhpick:${chars.u1.id}`,values:['2026-11-12']});await handler(calm);
  assert.equal(calm.followUps.length,0);assert.equal(schedulerCalls(calls).length,1);
  advance(6*60_000);
  const reload=fake('button',{user:{id:'u2'},customId:save.outputs[0].components[2].toJSON().components[0].custom_id});await handler(reload);
  assert.match(reload.outputs[0].embeds[0].toJSON().title,/\(저장 전\)$/);assert.equal(reload.followUps.length,1);assert.equal(schedulerCalls(calls).length,2);
  const skip=fake('button',{user:{id:'u2'},customId:reload.outputs[0].components[0].toJSON().components[1].custom_id});await handler(skip);
  assert.equal(skip.outputs[0].content,'저장하지 않았어요.');
});
test('editor back button returns to the same week',async t=>{
  const {handler,records,chars}=await handlerFor(t);
  const {record}=await records.view(ctx(),chars.u1.id,'last');records.save(ctx(),chars.u1.id,record.day,record.collectedAt);
  const edit=fake('button',{customId:`mp:bhedit:${chars.u1.id}:2026-11-05`});await handler(edit);
  const back=fake('button',{customId:edit.outputs[0].components[1].toJSON().components[0].custom_id});await handler(back);
  assert.equal(back.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 1주차 (11/5~11/11)');
});

test('boss history is reached like 스펙 변화: roster button → character picker → history, with a way back',async t=>{
  const {handler,service,chars}=await handlerFor(t);
  const roster=fake('button',{customId:'mp:roster:all:0'});await handler(roster);
  const tools=roster.outputs[0].components[1].toJSON().components;
  assert.deepEqual(tools.map(b=>b.label),['캐릭터 추가 / 삭제','스펙 변화','보스 히스토리','내 스케줄러']);
  // u1 sees their own character first, then the party member's; u3 (no shared party) is not listed.
  const picker=fake('button',{customId:tools[2].custom_id});await handler(picker);
  const menu=picker.outputs[0].components[0].toJSON().components[0];
  assert.equal(menu.custom_id,'mp:selectbh');assert.deepEqual(menu.options.map(o=>o.label),['도토리','모찌']);
  assert.deepEqual(picker.outputs[0].components.at(-1).toJSON().components.map(b=>b.label),['보스방','캐릭터','파티']);
  const lonely=fake('button',{user:{id:'u3'},customId:'mp:bhpicker:0'});await handler(lonely);
  assert.deepEqual(lonely.outputs[0].components[0].toJSON().components[0].options.map(o=>o.label),['감자']);
  // Opening a party member's history from the picker notifies them, like the slash command.
  const open=fake('select',{customId:'mp:selectbh',values:[chars.u2.id]});await handler(open);
  assert.equal(open.outputs[0].embeds[0].toJSON().title,'모찌 · 보스 히스토리');
  assert.match(open.followUps[0].content,/^<@u2> <@u1>님이 \*\*모찌\*\*의 보스 히스토리/);
  const rows=open.outputs[0].components.map(r=>r.toJSON().components.map(c=>c.label??c.custom_id));
  assert.deepEqual(rows.slice(1),[['이번 주 저장','지난주 저장'],['다른 캐릭터'],['보스방','캐릭터','파티']]);
  const back=fake('button',{customId:open.outputs[0].components[2].toJSON().components[0].custom_id});await handler(back);
  assert.equal(back.outputs[0].components[0].toJSON().components[0].custom_id,'mp:selectbh');
  // Picking a character outside the viewer's parties is refused.
  const outsider=fake('select',{customId:'mp:selectbh',values:[chars.u3.id]});await handler(outsider);
  assert.match(outsider.outputs[0].content,/같은 파티의 파티원/);
});
test('preview and editor screens also carry the home navigation row',async t=>{
  const {handler,records,chars}=await handlerFor(t);
  const pick=fake('select',{customId:`mp:bhpick:${chars.u1.id}`,values:['2026-11-05']});await handler(pick);
  assert.deepEqual(pick.outputs[0].components.at(-1).toJSON().components.map(b=>b.label),['보스방','캐릭터','파티']);
  const save=fake('button',{customId:pick.outputs[0].components[0].toJSON().components[0].custom_id});await handler(save);
  assert.deepEqual(save.outputs[0].components.at(-1).toJSON().components.map(b=>b.label),['보스방','캐릭터','파티']);
  const boss=fake('select',{customId:save.outputs[0].components[0].toJSON().components[0].custom_id,values:['0']});await handler(boss);
  assert.deepEqual(boss.outputs[0].components[1].toJSON().components.map(b=>b.label),['주차 편집으로 돌아가기','히스토리로 돌아가기']);
  assert.deepEqual(boss.outputs[0].components.at(-1).toJSON().components.map(b=>b.label),['보스방','캐릭터','파티']);
});

test('history save buttons save this week or last week directly and disappear once saved',async t=>{
  const {handler,chars,calls,repository,advance}=await handlerFor(t);
  const open=command('보스기록','히스토리',{'캐릭터':chars.u1.id});await handler(open);
  const saves=open.outputs[0].components[1].toJSON().components;
  assert.deepEqual(saves.map(b=>[b.label,b.custom_id]),[['이번 주 저장',`mp:bhquick:${chars.u1.id}:current`],['지난주 저장',`mp:bhquick:${chars.u1.id}:last`]]);
  // A mid-day Wednesday snapshot is not final, so saving last week reads the final day once.
  repository.db.prepare('INSERT INTO scheduler_snapshots VALUES(?,?,?,?,?,?)').run('g','t',chars.u1.id,'2026-11-11',Date.parse('2026-11-11T03:00:00Z'),JSON.stringify({date:'2026-11-11',bosses:[],weeklyBossCount:3,weeklyBossLimit:12}));
  const last=fake('button',{customId:saves[1].custom_id});await handler(last);
  assert.deepEqual(schedulerCalls(calls).map(c=>c.date),['2026-11-11']);
  assert.match(last.outputs[0].content,/^11월 1주차 \(11\/5~11\/11\) 보스 기록을 저장했어요\.\n함께 클리어한 인원을/);
  assert.equal(last.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 1주차 (11/5~11/11) 편집');
  // This week: saved straight away; a second save within five minutes reuses the cache.
  const current=fake('button',{customId:saves[0].custom_id});await handler(current);
  assert.equal(schedulerCalls(calls).length,2);
  const after=command('보스기록','히스토리',{'캐릭터':chars.u1.id});await handler(after);
  const labels=after.outputs[0].components.map(r=>r.toJSON().components.map(c=>c.label??c.custom_id));
  assert.ok(!labels.flat().some(l=>/저장$/.test(l)),'no save buttons once both weeks are saved');
  assert.deepEqual(labels[1],['인원 편집','이번 주 다시 불러오기','다른 캐릭터']);
  assert.ok(after.outputs[0].components[0].toJSON().components[0].options.every(o=>/저장됨/.test(o.description)));
  advance(60_000);
  assert.equal(schedulerCalls(calls).length,2,'opening the saved history never requests again');
});
test('a party member saving with the save button returns to the saved week and notifies the owner',async t=>{
  const {handler,chars}=await handlerFor(t);
  const save=fake('button',{user:{id:'u2'},customId:`mp:bhquick:${chars.u1.id}:last`});await handler(save);
  assert.equal(save.outputs[0].embeds[0].toJSON().title,'도토리 · 11월 1주차 (11/5~11/11)');
  assert.match(save.outputs[0].content,/저장했어요/);
  assert.match(save.followUps[0].content,/^<@u1> <@u2>님이/);
  const outsider=fake('button',{user:{id:'u3'},customId:`mp:bhquick:${chars.u1.id}:current`});await handler(outsider);
  assert.match(outsider.outputs[0].content,/같은 파티의 파티원/);
});

test('monthly bosses are listed last without a number, and editing still targets the right entry',async t=>{
  const {handler,chars,repository,records}=await handlerFor(t);
  const cleared=[
    {name:'스우',bossId:'lotus',difficulty:'익스트림',monthly:false},
    {name:'검은 마법사',bossId:'blackmage',difficulty:'익스트림',monthly:true},
    {name:'감시자 칼로스',bossId:'kalos',difficulty:'카오스',monthly:false},
  ];
  repository.db.prepare('INSERT INTO boss_history VALUES(?,?,?,?,?,?,?)').run('g','t',chars.u1.id,'2026-11-05',JSON.stringify({week:'2026-11-05',day:'2026-11-11',clearCount:2,clearLimit:12,cleared}),'u1',1);
  const open=command('보스기록','히스토리',{'캐릭터':chars.u1.id});await handler(open);
  assert.deepEqual(block(open.outputs[0].embeds[0].toJSON().description).map(l=>l.split(' · ')[0]),
    ['1. EXTREME 스우','2. CHAOS 감시자 칼로스','• EXTREME 검은 마법사 (월간)']);
  const edit=fake('button',{customId:`mp:bhedit:${chars.u1.id}:2026-11-05`});await handler(edit);
  const options=edit.outputs[0].components[0].toJSON().components[0].options;
  assert.deepEqual(options.map(o=>[o.label,o.value]),[['1. 익스트림 스우','0'],['2. 카오스 감시자 칼로스','2'],['익스트림 검은 마법사 (월간)','1']]);
  assert.deepEqual(block(edit.outputs[0].embeds[0].toJSON().description).map(l=>l.split(' · ')[0]),['1. EXTREME 스우','2. CHAOS 감시자 칼로스','• EXTREME 검은 마법사 (월간)']);
  // Picking "2. 카오스 감시자 칼로스" edits the 칼로스 entry, not the monthly one stored between them.
  const pick=fake('select',{customId:options.length&&edit.outputs[0].components[0].toJSON().components[0].custom_id,values:['2']});await handler(pick);
  await handler(fake('select',{customId:pick.outputs[0].components[0].toJSON().components[0].custom_id,values:['3']}));
  assert.deepEqual(records.week(ctx(),chars.u1.id,'2026-11-05').week.cleared.map(b=>b.partySize??1),[1,1,3]);
});
