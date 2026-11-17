import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { createHandler } from '../src/interactions.js';
import { parseBossList, parseCharacterList, pickRepresentatives, createPartyWith, bossOptionGroups, memberMentions } from '../src/party-create.js';
import * as views from '../src/views.js';

const ctx=(userId='u1')=>({guildId:'g',threadId:'t',userId,isManager:false,eligibleOwnerIds:new Set(['u1','u2','u3','u4'])});
function setup(t) {
  const repository=new Repository(':memory:');t.after(()=>repository.close());
  const service=new PartyService(repository);service.start(ctx(),'start');
  const add=(owner,name,world='크로아')=>service.register(ctx(owner),{name,world,job:'히어로'},`r-${name}`);
  const chars={a1:add('u1','도토리'),a2:add('u1','도토리부캐'),b1:add('u2','모찌빵'),c1:add('u3','감자','루나'),d1:add('u4','콩떡')};
  return {repository,service,chars};
}

test('boss text accepts 노멀/익스 aliases, short names and either word order',()=>{
  const r=parseBossList('노멀 찬란한 흉성, 하드 대적자, 칼로스 카오스, 익스 스우, 이지 진힐라, 노말 없는보스');
  assert.deepEqual(r.bosses,[{bossId:'star',difficulty:'노말'},{bossId:'adversary',difficulty:'하드'},{bossId:'kalos',difficulty:'카오스'},{bossId:'lotus',difficulty:'익스트림'}]);
  assert.deepEqual(r.errors.map(e=>e.split(':')[0]),['이지 진힐라','노말 없는보스']);
  assert.match(r.errors[0],/이지 난이도가 없어요/);
});
test('boss dropdowns split the 49 boss/difficulty pairs into 24 + 25 options',()=>{
  const [classic,grandis]=bossOptionGroups();
  assert.equal(classic.length,24);assert.equal(grandis.length,25);
  assert.ok(classic.some(o=>o.value==='seren:익스트림'));assert.ok(grandis.some(o=>o.value==='kalos:카오스'));
  assert.equal(new Set([...classic,...grandis].map(o=>o.value)).size,49);
});
test('character names and @ picks resolve to one strongest character per person in one world',t=>{
  const {service,chars}=setup(t),s=service.snapshot(ctx());
  const named=parseCharacterList(s,'도토리, 모찌빵 ,없는캐릭');
  assert.deepEqual(named.ids,[chars.a1.id,chars.b1.id]);assert.match(named.errors[0],/등록된 캐릭터가 아니에요/);
  const stats=new Map([[chars.a1.id,{power:'100'}],[chars.a2.id,{power:'900'}]]);
  const picks=pickRepresentatives(s,['u1','u2','u3','u9'],stats);
  assert.deepEqual(picks.ids,[chars.a2.id,chars.b1.id],'u1 brings the stronger 도토리부캐');
  assert.deepEqual(picks.errors.map(e=>e.split(':')[0]),['<@u3>','<@u9>']);assert.match(picks.errors[0],/크로아 월드에/);
});
test('creation adds what passes and reports the rest instead of failing the whole form',t=>{
  const {service,chars}=setup(t);
  const many=parseBossList('하드 스우, 익스 스우, 하드 데미안, 카오스 가엔슬, 하드 루시드, 하드 윌, 카오스 더스크, 하드 진힐라, 하드 듄켈, 하드 세렌, 이지 칼로스, 이지 카링, 노말 림보').bosses;
  const r=createPartyWith(service,ctx(),{name:'목요일팟',characterIds:[chars.a1.id,chars.a2.id,chars.b1.id,chars.c1.id],bosses:many},'req');
  assert.deepEqual(r.party.characterIds,[chars.a1.id,chars.b1.id]);
  assert.equal(r.party.bosses.length,11,'12 requested within limit minus the duplicate 스우');
  assert.deepEqual(r.skipped.map(x=>x.split(':')[0]),['도토리부캐','감자','익스트림 스우','노말 림보']);
  assert.match(r.skipped.at(-1),/최대 12개/);
  // A retried Discord request does not create a second party.
  createPartyWith(service,ctx(),{name:'목요일팟',characterIds:[chars.a1.id],bosses:[]},'req');
  assert.equal(service.snapshot(ctx()).parties.length,1);
  const empty=createPartyWith(service,ctx(),{name:'이름만'},'req2');
  assert.deepEqual([empty.party.characterIds.length,empty.party.bosses.length,empty.skipped.length],[0,0,0]);
  assert.deepEqual(memberMentions(r.added,'목요일팟','u1'),{users:['u2'],content:'<@u2> **모찌빵**이(가) **목요일팟** 파티에 편성됐어요.'});
  assert.equal(memberMentions([chars.a1],'x','u1'),null);
});

let n=0;
function fake(type,props={}) {
  return {id:`i${++n}`,user:{id:'u1'},guildId:'g',channel:{id:'t',isThread:()=>true},outputs:[],followUps:[],inGuild:()=>true,
    isAutocomplete:()=>type==='auto',isChatInputCommand:()=>type==='command',isButton:()=>type==='button',isStringSelectMenu:()=>type==='select',isUserSelectMenu:()=>false,isModalSubmit:()=>type==='modal',
    message:{flags:{has:()=>true}},async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async deleteReply(){},
    async editReply(p){this.outputs.push(p);},async reply(p){this.outputs.push(p);},async followUp(p){this.followUps.push(p);},async showModal(p){this.outputs.push(p);},async respond(p){this.outputs.push(p);},...props};
}
const handlerFor=service=>createHandler({service,guildId:'g',verifyContext:async i=>({...ctx(i.user.id),eligibleOwnerIds:undefined}),resolveOwners:async(_,ids)=>new Set(ids.filter(id=>id!=='u4'))});
test('one creation form: name, @ people, two boss menus → party with characters, bosses and @ notices',async t=>{
  const {service,chars}=setup(t),handler=handlerFor(service);
  const open=fake('button',{customId:'mp:create'});await handler(open);
  const form=open.outputs[0].toJSON();
  assert.deepEqual(form.components.map(c=>[c.label,c.component.type]),[['파티 이름',4],['참여할 사람 (@검색, 최대 6명)',5],['보스 · 검밑솔·세렌·검은 마법사',3],['보스 · 그란디스',3]]);
  const fields={getTextInputValue:()=>'목요일팟',getSelectedUsers:()=>new Map([['u1',{}],['u2',{}],['u4',{}]]),getStringSelectValues:id=>id==='bossA'?['seren:하드']:['adversary:하드','baldrix:노말']};
  const submit=fake('modal',{customId:'mp:modal:create',fields,message:undefined});await handler(submit);
  const p=service.snapshot(ctx()).parties[0];
  assert.deepEqual(p.characterIds,[chars.a1.id,chars.b1.id]);
  assert.deepEqual(p.bosses.map(b=>`${b.difficulty} ${b.bossId}`),['하드 seren','하드 adversary','노말 baldrix']);
  assert.match(submit.outputs[0].content,/^\*\*목요일팟\*\* 파티를 만들었어요\. 캐릭터 2명 · 보스 3개\n건너뛴 항목:\n• <@u4>: 현재 채널\/스레드 참가자가 아니에요\./);
  assert.deepEqual(submit.followUps[0],{content:'<@u2> **모찌빵**이(가) **목요일팟** 파티에 편성됐어요.',allowedMentions:{users:['u2'],parse:[]}});
  // Name only: empty party, no notice.
  const bare=fake('modal',{customId:'mp:modal:create',fields:{getTextInputValue:()=>'빈파티',getSelectedUsers:()=>null,getStringSelectValues:()=>[]},message:undefined});await handler(bare);
  assert.match(bare.outputs[0].content,/캐릭터 0명 · 보스 0개$/);assert.equal(bare.followUps.length,0);
});
test('/파티 생성 takes comma lists for characters and bosses, and autocompletes the last name',async t=>{
  const {service,chars}=setup(t),handler=handlerFor(service);
  const values={'이름':'금요일팟','캐릭터':'도토리,모찌빵','보스':'노멀 찬란한 흉성, 노멀 발드릭스, 하드 없는보스'};
  const cmd=fake('command',{commandName:'파티',options:{getSubcommand:()=>'생성',getString:k=>values[k]??null,getBoolean:()=>null,getUser:()=>null}});await handler(cmd);
  const p=service.snapshot(ctx()).parties[0];
  assert.deepEqual(p.characterIds,[chars.a1.id,chars.b1.id]);assert.deepEqual(p.bosses.map(b=>b.bossId),['star','baldrix']);
  assert.match(cmd.outputs[0].content,/하드 없는보스: 난이도와 보스 이름을 확인해 주세요/);
  assert.equal(cmd.followUps[0].allowedMentions.users[0],'u2');
  const auto=fake('auto',{commandName:'파티',createdTimestamp:Date.now(),options:{getSubcommand:()=>'생성',getFocused:()=>({name:'캐릭터',value:'도토리, 모'}),getString:()=>null}});await handler(auto);
  assert.deepEqual(auto.outputs[0].map(o=>o.value),['도토리,모찌빵']);
  assert.match(auto.outputs[0][0].name,/^도토리,모찌빵 \(크로아 · 히어로\)$/);
});
test('adding a character from the party screen notifies its registrant',async t=>{
  const {service,chars}=setup(t),handler=handlerFor(service);
  const p=service.createParty(ctx(),'A','p');
  const add=fake('select',{customId:`mp:selectmember:${p.id}:${p.version}`,values:[chars.b1.id]});await handler(add);
  assert.equal(add.followUps[0].content,'<@u2> **모찌빵**이(가) **A** 파티에 편성됐어요.');
  const own=fake('select',{customId:`mp:selectmember:${p.id}:${service.getParty(ctx(),p.id).version}`,values:[chars.a1.id]});await handler(own);
  assert.equal(own.followUps.length,0,'no notice for your own character');
});
