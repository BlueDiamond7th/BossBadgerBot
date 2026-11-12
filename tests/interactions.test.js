import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, ChannelType } from 'discord.js';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { createHandler } from '../src/interactions.js';
import { contextFor, isThreadMember, eligibleOwners } from '../src/access.js';
import { DomainError } from '../src/errors.js';
import { commandJSON } from '../src/commands.js';
import * as views from '../src/views.js';

const context={guildId:'g',threadId:'t',userId:'u1',isManager:false,eligibleOwnerIds:new Set(['u1','u2'])};
let n=0;
function fake(type,properties={}) {
  return {id:`interaction${++n}`,user:{id:'u1'},guildId:'g',channel:{id:'t',isThread:()=>true},deferred:false,replied:false,outputs:[],
    inGuild:()=>true,isAutocomplete:()=>type==='autocomplete',isChatInputCommand:()=>type==='command',isButton:()=>type==='button',isStringSelectMenu:()=>type==='select',isModalSubmit:()=>type==='modal',
    message:{flags:{has:()=>true}},
    async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},
    async deleteReply(){this.deleted=true;},async editReply(payload){this.outputs.push(payload);},async reply(payload){this.replied=true;this.outputs.push(payload);},async followUp(payload){this.outputs.push(payload);},async showModal(payload){this.replied=true;this.outputs.push(payload);},async respond(payload){this.responded=true;this.outputs.push(payload);},...properties};
}
function command(root,sub,values={}) {return fake('command',{commandName:root,options:{getSubcommand:()=>sub,getString:name=>values[name]??null,getBoolean:name=>values[name]??null,getUser:name=>values[name]??null}});}
function setup(t,verifyContext=async()=>({...context})) {
  const repo=new Repository(':memory:');t.after(()=>repo.close());const service=new PartyService(repo);
  const handler=createHandler({service,guildId:'g',verifyContext,resolveOwners:async()=>new Set(['u1','u2'])});return {service,handler};
}
test('full Discord command and persistent button flow creates party, character and boss',async t=>{
  const {service,handler}=setup(t);
  await handler(command('보스방','시작'));
  await handler(command('캐릭터','등록',{'이름':'도토리','월드':'루나','직업':'히어로'}));
  await handler(command('파티','생성',{'이름':'목요일팟'}));
  const s=service.snapshot(context),p=s.parties[0];
  await handler(command('파티','캐릭터추가',{'파티':p.id,'캐릭터':s.characters[0].id}));
  const updated=service.getParty(context,p.id);
  const choose=fake('select',{customId:`mp:selectboss:${p.id}:${updated.version}`,values:['seren']});await handler(choose);
  assert.match(choose.outputs[0].content,/난이도/);
  await handler(fake('select',{customId:`mp:difficulty:${p.id}:${updated.version}:seren`,values:['하드']}));
  assert.equal(service.getParty(context,p.id).bosses[0].difficulty,'하드');
  // New handler instance after restart must still understand old stored buttons.
  const resumed=createHandler({service,guildId:'g',verifyContext:async()=>({...context}),resolveOwners:async()=>new Set(['u1'])});
  const open=fake('button',{customId:`mp:detail:${p.id}`});await resumed(open);
  assert.equal(open.outputs[0].embeds[0].toJSON().fields[1].value,'1. 하드 선택받은 세렌');
});
test('no mutation occurs when authoritative thread membership fails',async t=>{
  const {service,handler}=setup(t,async()=>{throw new DomainError('스레드에 먼저 참여하세요.','NOT_MEMBER');});
  const i=command('보스방','시작');await handler(i);assert.match(i.outputs[0].content,/먼저 참여/);
  assert.throws(()=>service.snapshot(context),{code:'NOT_STARTED'});
});
test('stale and unauthorized buttons fail without changing party',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');const p=service.createParty(context,'A','create');
  service.addBoss(context,p.id,'will','하드','boss');
  const stale=fake('button',{customId:`mp:addboss:${p.id}:0:1`});await handler(stale);assert.match(stale.outputs[0].content,/변경/);
  const other=createHandler({service,guildId:'g',verifyContext:async()=>({...context,userId:'u2'}),resolveOwners:async()=>new Set()});
  const forbidden=fake('button',{customId:`mp:delboss:${p.id}:0:2`});await other(forbidden);assert.match(forbidden.outputs[0].content,/생성자/);
  assert.equal(service.getParty(context,p.id).bosses.length,1);
});
test('public board buttons open private replies rather than rewriting the shared message',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');let replyFlags;
  const i=fake('button',{customId:'mp:parties:active:0',message:{flags:{has:()=>false}},async deferReply(options){this.deferred=true;replyFlags=options.flags;}});
  await handler(i);assert.equal(replyFlags,MessageFlags.Ephemeral);
});
test('restore command cannot turn an already active party into an archive action',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');const p=service.createParty(context,'A','create');
  const i=command('파티','복원',{'파티':p.id});await handler(i);assert.match(i.outputs[0].content,/이미 활성/);assert.equal(service.getParty(context,p.id).archived,false);
});
test('membership check forces API fetch and fails closed on unavailable verification',async()=>{
  let options;const channel={members:{async fetch(o){options=o;}}};
  assert.equal(await isThreadMember(channel,'user'),true);assert.deepEqual(options,{member:'user',force:true,cache:false});
  assert.equal(await isThreadMember({members:{async fetch(){throw {status:404};}}},'user'),false);
  await assert.rejects(()=>isThreadMember({members:{async fetch(){throw new Error('network');}}},'user'),/network/);
});
test('context rejects other servers, non-threads, and managers not joined to thread',async()=>{
  const i={guildId:'g',user:{id:'u'},inGuild:()=>true,memberPermissions:{has:()=>true},channel:{id:'t',isThread:()=>true,archived:false,locked:false,members:{async fetch(){throw {status:404};}}}};
  await assert.rejects(()=>contextFor(i,'other'),{code:'FORBIDDEN'});
  await assert.rejects(()=>contextFor({...i,channel:{isThread:()=>false}},'g'),{code:'NOT_CHANNEL'});
  await assert.rejects(()=>contextFor(i,'g'),{code:'NOT_MEMBER'});
});
test('guild-only command definitions serialize with Discord validators',()=>{
  const data=commandJSON();assert.equal(data.length,3);assert.equal(new Set(data.map(x=>x.name)).size,3);
  for(const c of data) {assert.deepEqual(c.contexts,[0]);assert.ok(c.options.length<=25);}
});
function checkPayload(payload) {
  assert.ok((payload.components??[]).length<=5);
  for(const r of payload.components??[]) {
    const row=r.toJSON();assert.ok(row.components.length<=5);
    for(const c of row.components) {if(c.custom_id)assert.ok(c.custom_id.length<=100);if(c.options) {assert.ok(c.options.length<=25);assert.ok(c.options.length>0);}}
  }
  for(const e of payload.embeds??[]) {const emb=e.toJSON();assert.ok((emb.description??'').length<=4096);for(const f of emb.fields??[])assert.ok(f.value.length<=1024);}
}
test('more than 25 characters and parties are reachable with bounded Discord menus',()=>{
  const characters=Array.from({length:57},(_,i)=>({id:`c${i}`,ownerId:`u${i}`,active:true,name:`도토리${i}`,world:'루나',job:'히어로'}));
  const parties=Array.from({length:32},(_,i)=>({id:`p${i}`,creatorId:'u1',name:`파티${i}`,characterIds:[],bosses:[],version:1,archived:false}));
  const s={characters,parties},visited=new Set();
  for(let page=0;page<3;page++) {const payload=views.memberPicker(s,parties[0],page);checkPayload(payload);for(const o of payload.components[0].toJSON().components[0].options)visited.add(o.value);}
  assert.equal(visited.size,57);
  const p1=views.partyList(s,0),p2=views.partyList(s,1),p3=views.partyList(s,2);[p1,p2,p3].forEach(checkPayload);
  assert.equal(p3.components[0].toJSON().components[0].options.length,2);
});
test('long user-generated text and all public views remain valid Discord payloads',()=>{
  const characters=Array.from({length:40},(_,i)=>({id:`c${i}`,ownerId:`${i}`,active:true,name:'*'.repeat(30),world:'*'.repeat(30),job:'*'.repeat(30)}));
  const p={id:'f'.repeat(36),creatorId:'u1',name:'*'.repeat(60),characterIds:characters.map(c=>c.id),bosses:[],version:1234,archived:false},s={characters,parties:[p]};
  [views.board(s),views.roster(s),views.partyDetail(s,p,context,['*'.repeat(1000)]),views.memberPicker(s,p,0,true),views.bossPicker(p),views.difficultyPicker(p,'seren'),views.archiveConfirmation(p)].forEach(checkPayload);
  views.registrationModal().toJSON();views.creationModal().toJSON();
});

test('text channels check member access and use channel management permission',async()=>{
  const members={async fetch({user}){return {id:user};}};
  const channel={id:'text',type:ChannelType.GuildText,isThread:()=>false,guild:{members},permissionsFor:m=>({has:()=>m.id==='u1'})};
  const i={guildId:'g',user:{id:'u1'},inGuild:()=>true,channel,memberPermissions:{has:p=>p===PermissionFlagsBits.ManageChannels}};
  const ctx=await contextFor(i,'g');assert.equal(ctx.threadId,'text');assert.equal(ctx.isManager,true);
  assert.deepEqual(await eligibleOwners(channel,['u1','u2']),new Set(['u1']));
  await assert.rejects(()=>contextFor({...i,user:{id:'u2'}},'g'),{code:'NOT_MEMBER'});
  channel.guild.members.fetch=async()=>{throw new Error('network');};
  await assert.rejects(()=>contextFor(i,'g'),/network/);
});
test('shared party query publishes a read card and removes private acknowledgement',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');const p=service.createParty(context,'shared','create');
  const i=command('파티','정보',{'파티':p.id});await handler(i);
  assert.equal(i.deleted,true);assert.equal(i.outputs[0].flags,undefined);
  assert.equal(i.outputs.at(-1).components[0].toJSON().components[0].custom_id,`mp:detail:${p.id}`);
});
test('private modal submission updates the existing personal message',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');let updates=0,replies=0;
  const i=fake('modal',{customId:'mp:modal:register',fields:{getTextInputValue:k=>({name:'A',world:'루나',job:'히어로'})[k]},async deferUpdate(){updates++;this.deferred=true;},async deferReply(){replies++;this.deferred=true;}});
  await handler(i);assert.equal(updates,1);assert.equal(replies,0);assert.equal(service.snapshot(context).characters.length,1);
});
test('private navigation replaces the panel without follow-up messages',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');let updated=0;
  const i=fake('button',{customId:'mp:roster:all:0',async deferUpdate(){updated++;this.deferred=true;},async followUp(){assert.fail('must not create another panel');}});
  await handler(i);assert.equal(updated,1);
  assert.ok(i.outputs[0].components.some(r=>r.toJSON().components.some(c=>c.custom_id==='mp:parties:active:0')));
});

test('restore confirmation refreshes owner eligibility before changing stored state',async t=>{
  const {service}=setup(t);service.start(context,'start');
  const c=service.register({...context,userId:'u2'},{name:'친구',world:'루나',job:'비숍'},'character');
  const p=service.createParty(context,'A','party');service.addCharacter(context,p.id,c.id,'add');
  const archived=service.archive(context,p.id,true,'archive');let eligible=false;
  const handler=createHandler({service,guildId:'g',verifyContext:async()=>({...context}),resolveOwners:async(channel,ids)=>{assert.deepEqual(ids,['u2']);return new Set(eligible?['u2']:[]);}});
  const button=()=>fake('button',{customId:`mp:confirmarchive:${p.id}:${archived.version}:restore`});
  const denied=button();await handler(denied);
  assert.match(denied.outputs[0].content,/참가/);assert.deepEqual(service.getParty(context,p.id,true),archived);
  eligible=true;await handler(button());assert.equal(service.getParty(context,p.id).archived,false);
});
