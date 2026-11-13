import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, ChannelType } from 'discord.js';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { PersonalConnections } from '../src/connections.js';
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
function privatePanel(latestId='9007199254740993') {
  return {message:{id:'9007199254740992',flags:{has:()=>true}},channel:{id:'t',isThread:()=>true,messages:{async fetch(options){
    assert.deepEqual(options,{limit:1,cache:false});
    return new Map(latestId?[[latestId,{id:latestId}]]:[]);
  }}}};
}
function setup(t,verifyContext=async()=>({...context})) {
  const repo=new Repository(':memory:');t.after(()=>repo.close());const service=new PartyService(repo);
  const connections=new PersonalConnections({repository:repo,service,encryptionKey:Buffer.alloc(32,1).toString('base64'),clientFactory:()=>({listCharacters:async()=>[{ocid:'test-ocid',name:'도토리',world:'루나',job:'히어로',level:280}],combatPower:async()=> '123456789',close(){}})});
  const handler=createHandler({service,connections,guildId:'g',verifyContext,resolveOwners:async()=>new Set(['u1','u2'])});return {service,handler,connections};
}
test('full Discord command and persistent button flow creates party, character and boss',async t=>{
  const {service,handler,connections}=setup(t);
  await handler(command('보스방','시작'));
  await handler(fake('modal',{customId:'mp:modal:apikey',fields:{getTextInputValue:()=> 'test-key-'.repeat(8)}}));
  assert.equal(service.snapshot(context).characters.length,0);
  const draft=[...connections.selections.values()][0];
  assert.equal(draft.items[0].combatPower,'123456789');
  const chooseCharacters=fake('select',{customId:`mp:charselect:${draft.id}:0`,values:draft.items.map(c=>c.value)});await handler(chooseCharacters);
  assert.equal(service.snapshot(context).characters.length,0);
  await handler(fake('button',{customId:`mp:charcomplete:${draft.id}`}));
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
  await handler(i);assert.equal(replyFlags,MessageFlags.Ephemeral);assert.equal(i.deleted,undefined);
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
  const data=commandJSON();assert.equal(data.length,7);assert.equal(new Set(data.map(x=>x.name)).size,7);
  for(const c of data) {assert.deepEqual(c.contexts,[0]);assert.ok(c.options.length<=25);}
});
function checkPayload(payload) {
  const ids=new Set();
  assert.ok((payload.components??[]).length<=5);
  for(const r of payload.components??[]) {
    const row=r.toJSON();assert.ok(row.components.length<=5);
    for(const c of row.components) {if(c.custom_id) {assert.ok(c.custom_id.length<=100);assert.ok(!ids.has(c.custom_id),`duplicate custom_id: ${c.custom_id}`);ids.add(c.custom_id);}if(c.options) {assert.ok(c.options.length<=25);assert.ok(c.options.length>0);}}
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
function trackedCommand(userId='u1',channelId='t',root='캐릭터',sub='연결') {
  const i=command(root,sub);i.user={id:userId};i.channel={id:channelId};i.removed=[];
  i.responseId=String(10000+n);
  i.editReply=async payload=>{i.outputs.push(payload);return {id:i.responseId};};
  i.deleteReply=async id=>{i.removed.push(id??i.responseId);};
  return i;
}
test('a new private command removes the previous private panel in the same channel',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const first=trackedCommand(),second=trackedCommand();
  await handler(first);assert.deepEqual(first.removed,[]);
  await handler(second);assert.deepEqual(first.removed,[first.responseId]);assert.deepEqual(second.removed,[]);
});
test('private command cleanup is isolated by user and channel',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const first=trackedCommand(),otherUser=trackedCommand('u2'),otherChannel=trackedCommand('u1','other');
  for(const i of [first,otherUser,otherChannel]) await handler(i);
  assert.deepEqual(first.removed,[]);assert.deepEqual(otherUser.removed,[]);assert.deepEqual(otherChannel.removed,[]);
  await handler(trackedCommand());
  assert.deepEqual(first.removed,[first.responseId]);assert.deepEqual(otherUser.removed,[]);assert.deepEqual(otherChannel.removed,[]);
});
test('public query acknowledgements do not replace the tracked private panel',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const first=trackedCommand(),shared=trackedCommand('u1','t','파티','목록');
  await handler(first);await handler(shared);
  assert.deepEqual(first.removed,[]);assert.deepEqual(shared.removed,[shared.responseId]);
  await handler(trackedCommand());assert.deepEqual(first.removed,[first.responseId]);assert.deepEqual(shared.removed,[shared.responseId]);
});
test('failed command delivery leaves the previous private panel available',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const first=trackedCommand();await handler(first);
  const next=trackedCommand();next.editReply=async()=>{throw new Error('network');};
  await handler(next);assert.deepEqual(first.removed,[]);
});
test('private command errors also replace the previous private response',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const first=trackedCommand('u1','t','캐릭터','스펙'),second=trackedCommand('u1','t','캐릭터','스펙');
  await handler(first);await handler(second);
  assert.match(second.outputs[0].content,/스펙 추적 기능/);assert.deepEqual(first.removed,[first.responseId]);
});
test('expired private response tokens do not prevent opening a new panel',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const first=trackedCommand();first.createdTimestamp=Date.now()-16*60_000;
  await handler(first);
  const next=trackedCommand();await handler(next);
  assert.deepEqual(first.removed,[]);assert.ok(next.outputs[0].components.length);
});
test('updating a panel refreshes the deletion handle used by the next command',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const first=trackedCommand();await handler(first);
  const button=fake('button',{message:{id:first.responseId,flags:{has:()=>true}},customId:'mp:register',
    async editReply(p){this.outputs.push(p);return {id:first.responseId};},async deleteReply(id){this.removed=id;}});
  await handler(button);assert.deepEqual(first.removed,[]);
  await handler(trackedCommand());assert.equal(button.removed,first.responseId);assert.deepEqual(first.removed,[]);
});
test('private modal submission moves a displaced panel to the bottom',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');let updates=0,replies=0;
  const i=fake('modal',{...privatePanel(),customId:'mp:modal:apikey',fields:{getTextInputValue:()=> 'test-key-'.repeat(8)},async deferUpdate(){updates++;this.deferred=true;},async deferReply(){replies++;this.deferred=true;}});
  await handler(i);assert.equal(updates,1);assert.equal(replies,0);assert.equal(i.deleted,true);assert.equal(i.outputs[0].flags,MessageFlags.Ephemeral);assert.equal(service.snapshot(context).characters.length,0);assert.match(i.outputs[0].content,/등록할 캐릭터/);
});
test('private navigation moves a displaced panel before deleting its source',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  for(const type of ['button','select']) {
    const events=[];
    const i=fake(type,{...privatePanel(),customId:'mp:roster:all:0',async deferUpdate(){events.push('defer');this.deferred=true;},
      async followUp(payload){events.push('send');assert.equal(payload.flags,MessageFlags.Ephemeral);assert.deepEqual(payload.allowedMentions,{parse:[]});this.outputs.push(payload);},
      async deleteReply(){events.push('delete');},async editReply(){assert.fail('must send a new message');}});
    await handler(i);assert.deepEqual(events,['defer','send','delete']);
    assert.ok(i.outputs[0].components.some(r=>r.toJSON().components.some(c=>c.custom_id==='mp:parties:active:0')));
  }
});
test('private navigation keeps its message when no newer channel message exists',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  for(const latestId of [null,'9007199254740991','9007199254740992']) {
    const i=fake('button',{...privatePanel(latestId),customId:'mp:roster:all:0',async followUp(){assert.fail('must keep the current message');}});
    await handler(i);assert.equal(i.deleted,undefined);assert.ok(i.outputs[0].embeds.length);
  }
});
test('private navigation keeps its message when channel history cannot be checked',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const panel=privatePanel();panel.channel.messages.fetch=async()=>{throw new Error('network');};
  const i=fake('button',{...panel,customId:'mp:roster:all:0',async followUp(){assert.fail('must keep the current message');}});
  await handler(i);assert.equal(i.deleted,undefined);assert.ok(i.outputs[0].embeds.length);
});
test('failed private delivery does not delete the source message',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const i=fake('button',{...privatePanel(),customId:'mp:roster:all:0',async followUp(){throw new Error('network');}});
  await handler(i);assert.equal(i.deleted,undefined);assert.match(i.outputs[0].content,/처리하지 못했어요/);
});
test('failed source deletion leaves the delivered private panel intact',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const i=fake('button',{...privatePanel(),customId:'mp:roster:all:0',async deleteReply(){throw new Error('network');},async editReply(){assert.fail('must not replace the delivered panel with an error');}});
  await handler(i);assert.equal(i.outputs.length,1);assert.equal(i.outputs[0].flags,MessageFlags.Ephemeral);assert.ok(i.outputs[0].embeds.length);
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
test('autocomplete times out closed and ignores late permission results',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const fail of [false,true]) {
    let resolve,reject,reads=0;
    const permission=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const handler=createHandler({guildId:'g',service:{snapshot(){reads++;throw new Error('must not read');}},verifyContext:()=>permission});
    const i=fake('autocomplete');const pending=handler(i);
    t.mock.timers.tick(2000);await pending;assert.deepEqual(i.outputs,[[]]);
    if(fail) reject(new Error('late network failure'));else resolve(context);
    await Promise.resolve();await Promise.resolve();
    assert.equal(reads,0);assert.deepEqual(i.outputs,[[]]);
  }
});
test('autocomplete returns authorized matching choices and closes on denied access',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');const p=service.createParty(context,'목요일팟','party');
  const properties={commandName:'파티',options:{getSubcommand:()=> '정보',getFocused:()=>({name:'파티',value:'목요일'})}};
  const i=fake('autocomplete',properties);await handler(i);assert.deepEqual(i.outputs,[[{name:p.name,value:p.id}]]);
  const denied=createHandler({service,guildId:'g',verifyContext:async()=>{throw new Error('denied');}});
  const j=fake('autocomplete',properties);await denied(j);assert.deepEqual(j.outputs,[[]]);
});
test('autocomplete accounts for time already spent before handling',async t=>{
  let verified=false;
  const handler=createHandler({guildId:'g',verifyContext:async()=>{verified=true;return context;}});
  const i=fake('autocomplete',{createdTimestamp:Date.now()-2500});await handler(i);
  assert.deepEqual(i.outputs,[[]]);assert.equal(verified,false);
});

test('API connection replaces manual registration without command options or secret echoes',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  const defs=commandJSON().find(c=>c.name==='캐릭터').options;
  assert.equal(defs.some(c=>c.name==='등록'),false);
  assert.equal(defs.find(c=>c.name==='연결').options?.length??0,0);
  assert.equal(views.registrationModal().toJSON().components.length,1);
  const secret='test-key-'.repeat(8);
  const i=fake('modal',{customId:'mp:modal:apikey',fields:{getTextInputValue:key=>{assert.equal(key,'apikey');return secret;}}});
  await handler(i);assert.equal(service.snapshot(context).characters.length,0);assert.match(i.outputs[0].content,/등록할 캐릭터/);
  assert.ok(!JSON.stringify(i.outputs).includes(secret));
  const legacy=fake('modal',{customId:'mp:modal:register',fields:{getTextInputValue:()=>assert.fail('must not read old name as key')}});
  await handler(legacy);assert.equal(service.snapshot(context).characters.length,0);
});


test('roster next/previous buttons render every page without duplicate component IDs',async t=>{
  const {service,handler}=setup(t);service.start(context,'start');
  for(let i=0;i<25;i++)service.register(context,{name:`도토리${i}`,world:'루나',job:'히어로'},`character-${i}`);
  const click=async customId=>{
    const i=fake('button',{customId,async editReply(payload){checkPayload(payload);this.outputs.push(payload);}});
    await handler(i);const payload=i.outputs.at(-1);assert.ok(payload.embeds?.length,'navigation must render the roster instead of a generic error');return payload;
  };
  const find=(payload,label)=>payload.components.flatMap(r=>r.toJSON().components).find(c=>c.label===label);
  let payload=await click('mp:roster:all:0');
  assert.match(payload.embeds[0].toJSON().footer.text,/1\/3/);assert.equal(find(payload,'이전').disabled,true);
  payload=await click(find(payload,'다음').custom_id);assert.match(payload.embeds[0].toJSON().footer.text,/2\/3/);
  payload=await click(find(payload,'다음').custom_id);assert.match(payload.embeds[0].toJSON().footer.text,/3\/3/);assert.equal(find(payload,'다음').disabled,true);
  payload=await click(find(payload,'이전').custom_id);assert.match(payload.embeds[0].toJSON().footer.text,/2\/3/);
  payload=await click(find(payload,'이전').custom_id);assert.match(payload.embeds[0].toJSON().footer.text,/1\/3/);
  // Buttons posted before this change retain their routing.
  payload=await click('mp:roster:all:1');assert.match(payload.embeds[0].toJSON().footer.text,/2\/3/);
});
test('all roster filters and party list pages use unique component IDs',()=>{
  const characters=Array.from({length:57},(_,i)=>({id:`c${i}`,ownerId:'u1',active:true,name:`캐릭터${i}`,world:'루나',job:'히어로'}));
  const parties=Array.from({length:57},(_,i)=>({id:`p${i}`,creatorId:'u1',name:`파티${i}`,characterIds:[],bosses:[],archived:false}));
  const state={characters,parties};
  for(let page=0;page<6;page++)for(const owner of ['all','u1'])checkPayload(views.roster(state,page,owner));
  for(let page=0;page<4;page++) {checkPayload(views.partyList(state,page));checkPayload(views.partyList({...state,parties:parties.map(p=>({...p,archived:true}))},page,true));}
});
