import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { ScheduleService, parseScheduleTime } from '../src/schedule.js';
import { ScheduleWorker } from '../src/schedule-worker.js';
import { createHandler } from '../src/interactions.js';
import * as ui from '../src/schedule-views.js';
import { MessageFlags } from 'discord.js';
const DAY=86400_000,WEEK=7*DAY,START=Date.parse('2026-11-14T03:00:00Z');
const ctx=(userId='u1',threadId='t')=>({guildId:'g',threadId,userId,isManager:false,eligibleOwnerIds:new Set(['u1','u2','u3'])});
function fixture(t) {
  const repository=new Repository(':memory:');t.after(()=>repository.close());const service=new PartyService(repository);service.start(ctx(),'start');let n=0,now=START;const rid=()=>`r${++n}`;
  const p=service.createParty(ctx(),'주말팟',rid());
  for(const [u,name] of [['u1','도토리'],['u2','모찌'],['u3','감자']]){const c=service.register(ctx(u),{name,world:'루나'},rid());service.addCharacter(ctx(),p.id,c.id,rid());}
  service.addBoss(ctx(),p.id,'seren','하드',rid());
  const book=new ScheduleService({repository,service,now:()=>now});
  const make=(options={})=>{const d=book.makeDraft(ctx(),p.id,{startAt:now+4*3600_000,duration:60,mode:'fixed',...options},rid());return book.create(ctx(),d.id,rid());};
  return {repository,service,book,party:p,rid,make,now:()=>now,advance:ms=>now+=ms};
}
test('schedule time input resolves Korean days in KST and rejects invalid/past dates',()=>{
  assert.equal(parseScheduleTime('오늘 22:00',START),Date.parse('2026-11-14T13:00:00Z'));
  assert.equal(parseScheduleTime('내일 00:30',START),Date.parse('2026-11-14T15:30:00Z'));
  assert.equal(parseScheduleTime('토요일 22:00',START),parseScheduleTime('토 22:00',START));
  assert.equal(parseScheduleTime('토 10:00',START),Date.parse('2026-11-21T01:00:00Z'));
  for(const value of ['오늘 01:00','내일 24:30','내일 12:60','2026-02-30 22:00','곧','2027-12-01 22:00'])assert.throws(()=>parseScheduleTime(value,START));
});
test('schedule creation is durable, scoped, manager-only and request deduplicated',t=>{
  const f=fixture(t),d=f.book.makeDraft(ctx(),f.party.id,{startAt:START+3600_000},f.rid()),rid=f.rid();
  const a=f.book.create(ctx(),d.id,rid),b=f.book.create(ctx(),d.id,rid);assert.equal(a.id,b.id);
  assert.throws(()=>f.book.get(ctx('u1','other'),a.id),{code:'NOT_FOUND'});
  assert.throws(()=>f.book.makeDraft(ctx('u2'),f.party.id,{startAt:START+3600_000},f.rid()),{code:'FORBIDDEN'});
  assert.throws(()=>f.book.create(ctx('u2'),d.id,rid),{code:'FORBIDDEN'});
  const reopened=new ScheduleService({repository:f.repository,service:f.service,now:f.now});assert.equal(reopened.get(ctx(),a.id).members.length,3);
});
test('attending is an explicit idempotent state, and reply counts do not invalidate other clicks',t=>{
  const f=fixture(t),s=f.make();f.book.respond(ctx(),s.id,'yes',s.version,f.rid());f.book.respond(ctx('u2'),s.id,'no',s.version,f.rid());
  assert.equal(f.book.get(ctx(),s.id).version,s.version);
  const rid=f.rid();f.book.respond(ctx(),s.id,'yes',s.version,rid);f.book.respond(ctx(),s.id,'yes',s.version,rid);
  assert.equal(f.book.get(ctx(),s.id).responses.u1.state,'yes');assert.throws(()=>f.book.respond(ctx('outsider'),s.id,'yes',s.version,f.rid()),{code:'FORBIDDEN'});
});
test('poll distinguishes no response from unavailable, restores votes and carries attendance on confirmation',t=>{
  const f=fixture(t),options=f.book.parseInput('poll','오늘 21:00\n내일 20:00');const s=f.make(options),c=s.candidates[1];
  f.book.vote(ctx(),s.id,[c.id],s.version,f.rid());f.book.vote(ctx('u2'),s.id,[],s.version,f.rid());
  assert.deepEqual(f.book.tally(f.book.get(ctx(),s.id)).map(c=>[c.yes,c.no,c.missing]),[[0,2,1],[1,1,1]]);
  assert.throws(()=>f.book.confirm(ctx(),s.id,c.id,s.version,'',f.rid()));
  const confirmed=f.book.confirm(ctx(),s.id,c.id,s.version,'모찌는 이번 회차 불참으로 진행',f.rid());
  assert.equal(confirmed.startAt,c.at);assert.equal(confirmed.responses.u1.state,'yes');assert.equal(confirmed.responses.u2.state,'no');assert.equal(confirmed.responses.u3,undefined);
  assert.throws(()=>f.book.vote(ctx(),s.id,[c.id],s.version,f.rid()));
});
test('poll can be finalized to a later future candidate even after the first candidate passed',t=>{
  const f=fixture(t),s=f.make(f.book.parseInput('poll','오늘 21:00\n내일 20:00'));
  f.advance(DAY);const c=s.candidates[1];const result=f.book.confirm(ctx(),s.id,c.id,s.version,'오늘 후보는 지나서 내일로 합의',f.rid());assert.equal(result.status,'confirmed');
});
test('regular attendance requires consent, preserves an exception and does not resurrect after opting out',t=>{
  const f=fixture(t),s=f.make({repeat:true});const all=()=>f.repository.db.prepare('SELECT id FROM schedules WHERE series_id=? ORDER BY start_at').all(s.seriesId).map(r=>f.book.get(ctx(),r.id));
  assert.ok(all().length>=4);assert.ok(all().every(s=>!s.responses.u1));
  f.book.regular(ctx(),s.id,true,s.version,f.rid());assert.ok(all().every(s=>s.responses.u1.state==='regular'));
  f.book.respond(ctx(),s.id,'no',s.version,f.rid());assert.equal(all()[0].responses.u1.state,'no');assert.equal(all()[1].responses.u1.state,'regular');
  f.book.regular(ctx(),s.id,false,s.version,f.rid());assert.equal(all()[0].responses.u1.state,'no');assert.equal(all()[1].responses.u1,undefined);
});
test('a one-off time change invalidates old replies without moving later regular occurrences',t=>{
  const f=fixture(t),s=f.make({repeat:true});f.book.regular(ctx(),s.id,true,s.version,f.rid());
  const edited=f.book.edit(ctx(),s.id,s.version,{startAt:s.startAt+3600_000},f.rid());assert.equal(edited.responses.u1.state,'recheck');
  assert.throws(()=>f.book.respond(ctx(),s.id,'yes',s.version,f.rid()),{code:'STALE'});
  assert.throws(()=>f.book.regular(ctx(),s.id,true,edited.version,f.rid()));
  const next=f.repository.db.prepare('SELECT id FROM schedules WHERE series_id=? AND original_at=?').get(s.seriesId,s.startAt+WEEK);assert.equal(f.book.get(ctx(),next.id).responses.u1.state,'regular');
});
test('future time edits clear regular consent and one-off cancellation leaves the series active',t=>{
  const f=fixture(t),s=f.make({repeat:true});f.book.regular(ctx(),s.id,true,s.version,f.rid());
  const edited=f.book.edit(ctx(),s.id,s.version,{startAt:s.startAt+3600_000,future:true},f.rid());
  assert.deepEqual(f.book.series(ctx(),s.seriesId).consents,{});
  f.book.cancel(ctx(),s.id,edited.version,false,f.rid());assert.equal(f.book.series(ctx(),s.seriesId).active,true);
  const active=f.repository.db.prepare("SELECT id FROM schedules WHERE series_id=? AND status='confirmed'").all(s.seriesId);assert.ok(active.length);assert.ok(active.every(r=>f.book.get(ctx(),r.id).responses.u1?.state!=='regular'));
});
test('candidate additions preserve known votes and leave the new candidate unanswered',t=>{
  const f=fixture(t),s=f.make(f.book.parseInput('poll','오늘 21:00\n내일 20:00'));f.book.vote(ctx(),s.id,[s.candidates[0].id],s.version,f.rid());
  const options=f.book.parseInput('poll','오늘 21:00\n내일 20:00\n월 22:00'),updated=f.book.edit(ctx(),s.id,s.version,options,f.rid());
  assert.equal(updated.candidates[0].id,s.candidates[0].id);assert.deepEqual(f.book.tally(updated).map(c=>[c.yes,c.no,c.missing]),[[1,0,2],[0,1,2],[0,0,3]]);
});
test('conflicts follow the Discord owner across characters and need explicit acknowledgement',t=>{
  const f=fixture(t),s=f.make();const p=f.service.copyParty(ctx(),f.party.id,'다른팟',f.rid());const d=f.book.makeDraft(ctx(),p.id,{startAt:s.startAt+30*60_000},f.rid());
  assert.throws(()=>f.book.create(ctx(),d.id,f.rid()),/겹치는/);
  f.book.changeDraft(ctx(),d.id,{reason:'먼저 끝내고 합류'},f.rid());const other=f.book.create(ctx(),d.id,f.rid());assert.equal(other.conflictsAccepted,true);
});
test('maintenance recovers weekly occurrences once, cancels archived parties and preserves past state',t=>{
  const f=fixture(t),s=f.make({repeat:true});f.book.maintenance(ctx());const count=f.repository.db.prepare('SELECT COUNT(*) n FROM schedules').get().n;f.book.maintenance(ctx());assert.equal(f.repository.db.prepare('SELECT COUNT(*) n FROM schedules').get().n,count);
  f.advance(6*3600_000);f.book.maintenance(ctx());assert.equal(f.book.get(ctx(),s.id).status,'elapsed');
  f.service.archive(ctx(),f.party.id,true,f.rid());f.book.maintenance(ctx());assert.equal(f.book.series(ctx(),s.seriesId).active,false);assert.equal(f.book.get(ctx(),s.id).status,'elapsed');
  assert.equal(f.repository.db.prepare("SELECT COUNT(*) n FROM schedules WHERE status='confirmed'").get().n,0);
});
function workerFor(f,options={}) {
  const posts=[],messages=new Map();let n=0;
  const channel={id:'t',isTextBased:()=>true,messages:{async fetch(id){if(!messages.has(id))throw {code:10008};return messages.get(id);}},async send(p){if(options.fail)throw new Error('network');const message={id:`msg${++n}`,payload:p,async edit(p){this.payload=p;}};posts.push(message);messages.set(message.id,message);return message;}};
  const worker=new ScheduleWorker({schedules:f.book,getChannel:async()=>channel,canParticipate:async(_,id)=>id!=='departed',...options});
  return {worker,posts,channel,messages};
}
test('worker publishes one current recurring card, keeps public edits in place and sends one reminder',async t=>{
  const f=fixture(t),s=f.make({repeat:true}),w=workerFor(f);await w.worker.tick();assert.equal(w.posts.length,1);assert.deepEqual(w.posts[0].payload.allowedMentions.users,['u1','u2','u3']);
  const messageId=f.book.get(ctx(),s.id).messageId;f.book.respond(ctx('u2'),s.id,'no',s.version,f.rid());await w.worker.tick();assert.equal(w.posts.length,1);assert.equal(f.book.get(ctx(),s.id).messageId,messageId);
  f.advance(s.startAt-f.now()-10*60_000);await w.worker.tick();assert.equal(w.posts.length,2);assert.deepEqual(w.posts[1].payload.allowedMentions.users,['u1','u3']);await w.worker.tick();assert.equal(w.posts.length,2);
});
test('changed and cancelled schedules invalidate old reminders',async t=>{
  const f=fixture(t),s=f.make(),w=workerFor(f);await w.worker.tick();const updated=f.book.edit(ctx(),s.id,s.version,{startAt:s.startAt+3600_000},f.rid());await w.worker.tick();
  f.advance(s.startAt-f.now()-10*60_000);await w.worker.tick();assert.ok(w.posts.every(m=>!m.payload.content?.includes('출발 알림')));
  f.book.cancel(ctx(),s.id,updated.version,false,f.rid());f.advance(3600_000);await w.worker.tick();assert.ok(w.posts.every(m=>!m.payload.content?.includes('출발 알림')));
});
test('uncertain sends are not retried after restart; manual repost recovers a card',async t=>{
  const f=fixture(t),s=f.make(),broken=workerFor(f,{fail:true});await broken.worker.tick();assert.equal(f.repository.db.prepare("SELECT COUNT(*) n FROM schedule_jobs WHERE kind='publish' AND state='unknown'").get().n,1);
  const good=workerFor(f);await good.worker.tick();assert.equal(good.posts.length,0);f.book.repost(ctx(),s.id,f.rid());await good.worker.tick();assert.equal(good.posts.length,1);
  f.book.repost(ctx(),s.id,f.rid());await good.worker.tick();assert.equal(good.posts.length,2);
});
test('worker resumes interrupted outbox jobs as unknown instead of duplicating a send',t=>{
  const f=fixture(t);f.make();f.repository.db.prepare("UPDATE schedule_jobs SET state='running' WHERE kind='publish'").run();workerFor(f);assert.equal(f.repository.db.prepare("SELECT state FROM schedule_jobs WHERE kind='publish'").get().state,'unknown');
});
test('schedule UI fits component and text limits with long names and missing attendance',t=>{
  const f=fixture(t),s=f.make();s.partyName='*'.repeat(60);for(const m of s.members)m.name='가'.repeat(30);
  const p=f.service.getParty(ctx(),f.party.id),d=f.book.makeDraft(ctx(),p.id,{startAt:START+8*3600_000},f.rid());
  for(const payload of [ui.scheduleCard(s,f.book),ui.scheduleList([s]),ui.scheduleStart(p),ui.schedulePreview(d,p),ui.scheduleManage(s,p,ctx()),ui.schedulePersonal(s,ctx())]) {
    const ids=new Set();assert.ok(payload.components.length<=5);for(const row of payload.components){const r=row.toJSON();assert.ok(r.components.length<=5);for(const c of r.components){assert.ok(c.custom_id.length<=100);assert.ok(!ids.has(c.custom_id));ids.add(c.custom_id);}}
    for(const embed of payload.embeds??[]){const e=embed.toJSON();assert.ok((e.description??'').length<=4096);}
  }
});
let interactionNumber=0;
function interaction(type,properties={}) {
  return {id:`interaction-${++interactionNumber}`,user:{id:'u1'},guildId:'g',channel:{id:'t',isThread:()=>true},message:{flags:{has:()=>false}},deferred:false,replied:false,outputs:[],
    inGuild:()=>true,isAutocomplete:()=>false,isChatInputCommand:()=>type==='command',isButton:()=>type==='button',isStringSelectMenu:()=>type==='select',isModalSubmit:()=>type==='modal',isUserSelectMenu:()=>false,
    async deferReply(p){assert.equal(p.flags,MessageFlags.Ephemeral);this.deferred=true;},async deferUpdate(){this.deferred=true;},async editReply(p){this.outputs.push(p);},async reply(p){this.replied=true;this.outputs.push(p);},async showModal(p){assert.equal(this.deferred,false);this.replied=true;this.outputs.push(p.toJSON());},async followUp(p){assert.equal(p.flags,MessageFlags.Ephemeral);this.outputs.push(p);},async deleteReply(){this.deleted=true;},...properties};
}
function handlerFor(f,worker=null) {return createHandler({service:f.service,schedules:f.book,scheduleWorker:worker,guildId:'g',verifyContext:async i=>ctx(i.user.id),resolveOwners:async(_,users)=>new Set(users)});}
test('Discord flow opens a modal before acknowledgement, previews, posts and accepts a one-click public response',async t=>{
  const f=fixture(t),w=workerFor(f),handle=handlerFor(f,w.worker);
  const start=interaction('button',{customId:`sc:start:${f.party.id}`});await handle(start);assert.match(start.outputs[0].content,/어떻게/);
  const modal=interaction('button',{customId:`sc:new:${f.party.id}:fixed`});await handle(modal);assert.equal(modal.outputs[0].custom_id,`sc:modal:create:${f.party.id}:fixed`);
  const submit=interaction('modal',{customId:modal.outputs[0].custom_id,fields:{getTextInputValue:k=>k==='time'?'오늘 22:00':''}});await handle(submit);assert.match(submit.outputs[0].content,/확인/);
  const postId=submit.outputs[0].components[0].toJSON().components[0].custom_id;
  const post=interaction('button',{customId:postId});await handle(post);assert.equal(w.posts.length,1);
  const s=f.book.list(ctx())[0],attend=interaction('button',{user:{id:'u2'},customId:`sc:attend:${s.id}:${s.version}:yes`});await handle(attend);
  assert.equal(f.book.get(ctx(),s.id).responses.u2.state,'yes');assert.equal(w.posts.length,1);assert.match(attend.outputs[0].content,/참석으로 저장/);assert.equal(attend.deleted,undefined);
});
test('Discord poll saves choices and confirms a unanimous candidate without an extra reason modal',async t=>{
  const f=fixture(t),s=f.make(f.book.parseInput('poll','오늘 21:00\n내일 20:00')),handle=handlerFor(f);
  for(const userId of ['u1','u2','u3'])await handle(interaction('button',{user:{id:userId},customId:`sc:allvote:${s.id}:${s.version}:yes`}));
  const confirm=interaction('select',{customId:`sc:pickconfirm:${s.id}:${s.version}`,values:[s.candidates[0].id]});await handle(confirm);
  assert.equal(confirm.deferred,true);assert.equal(f.book.get(ctx(),s.id).status,'confirmed');assert.ok(confirm.outputs[0].embeds);
});
test('Discord modal shortcuts honor manager permission and refuse other users',async t=>{
  const f=fixture(t),handle=handlerFor(f);
  const denied=interaction('button',{user:{id:'u2'},customId:`sc:new:${f.party.id}:fixed`});await handle(denied);assert.match(denied.outputs[0].content,/생성자/);assert.equal(denied.outputs[0].flags,MessageFlags.Ephemeral);
  const admin=interaction('button',{user:{id:'u2'},memberPermissions:{has:()=>true},customId:`sc:new:${f.party.id}:fixed`});await handle(admin);assert.equal(admin.outputs[0].custom_id,`sc:modal:create:${f.party.id}:fixed`);
});
test('poll deadline job references the published schedule and closes its public vote controls',async t=>{
  const f=fixture(t),s=f.make(f.book.parseInput('poll','오늘 21:00\n내일 20:00')),w=workerFor(f);await w.worker.tick();
  f.advance(s.deadline-f.now());await w.worker.tick();assert.ok(w.posts.some(m=>m.payload.content?.includes('투표가 마감')));
  const card=w.messages.get(f.book.get(ctx(),s.id).messageId);assert.equal(card.payload.components[0].toJSON().components[0].disabled,true);
});
test('stopping a rescheduled occurrence cancels following original weeks even if they start earlier',t=>{
  const f=fixture(t),s=f.make({repeat:true}),updated=f.book.edit(ctx(),s.id,s.version,{startAt:s.startAt+10*DAY},f.rid());
  f.book.cancel(ctx(),s.id,updated.version,true,f.rid());assert.equal(f.repository.db.prepare("SELECT COUNT(*) n FROM schedules WHERE series_id=? AND status='confirmed'").get(s.seriesId).n,0);
});
test('extending a series duration without moving its time preserves regular consent',t=>{
  const f=fixture(t),s=f.make({repeat:true});f.book.regular(ctx(),s.id,true,s.version,f.rid());
  f.book.edit(ctx(),s.id,s.version,{duration:90,future:true},f.rid());
  assert.equal(f.book.series(ctx(),s.seriesId).consents.u1.version,1);
  const future=f.repository.db.prepare("SELECT id FROM schedules WHERE series_id=? AND status='confirmed'").all(s.seriesId).map(r=>f.book.get(ctx(),r.id));
  assert.ok(future.every(s=>s.duration===90&&s.responses.u1.state==='regular'));
});
test('party composition changes preserve other replies and require a swapped character to reconfirm',t=>{
  const f=fixture(t),s=f.make({repeat:true});f.book.regular(ctx(),s.id,true,s.version,f.rid());f.book.respond(ctx('u2'),s.id,'yes',s.version,f.rid());
  const alternate=f.service.register(ctx(),{name:'도토리부캐',world:'루나'},f.rid());f.service.removeCharacter(ctx(),f.party.id,s.members[0].characterId,f.rid());f.service.addCharacter(ctx(),f.party.id,alternate.id,f.rid());
  assert.throws(()=>f.book.respond(ctx(),s.id,'yes',s.version,f.rid()),{code:'STALE'});
  f.book.maintenance(ctx());assert.equal(f.book.get(ctx(),s.id).compositionChanged,true);
  const applied=f.book.applyParty(ctx(),s.id,s.version,f.rid());assert.equal(applied.responses.u1.state,'recheck');assert.equal(applied.responses.u2.state,'yes');assert.equal(f.book.series(ctx(),s.seriesId).consents.u1,undefined);
});
test('nudge is manager-only, throttled and targets only unanswered people',async t=>{
  const f=fixture(t),s=f.make(),w=workerFor(f);await w.worker.tick();f.book.respond(ctx(),s.id,'yes',s.version,f.rid());
  assert.throws(()=>f.book.nudge(ctx('u2'),s.id,f.rid()),{code:'FORBIDDEN'});
  f.book.nudge(ctx(),s.id,f.rid());assert.throws(()=>f.book.nudge(ctx(),s.id,f.rid()),/1시간/);await w.worker.tick();
  const post=w.posts.find(p=>p.payload.content?.includes('아직 응답하지'));assert.deepEqual(post.payload.allowedMentions.users,['u2','u3']);
});
test('a reminder cancelled while live membership is being checked is not sent',async t=>{
  const f=fixture(t),s=f.make();let cancelDuringFetch=false;
  const w=workerFor(f,{canParticipate:async()=>{if(cancelDuringFetch){cancelDuringFetch=false;f.book.cancel(ctx(),s.id,s.version,false,f.rid());}return true;}});
  await w.worker.tick();f.advance(s.startAt-f.now()-10*60_000);cancelDuringFetch=true;await w.worker.tick();
  assert.ok(w.posts.every(p=>!p.payload.content?.includes('뒤 출발 예정')));
});
test('delivery issues are visible and can be explicitly retried without duplicating a successful job',async t=>{
  const f=fixture(t),s=f.make(),broken=workerFor(f,{fail:true});await broken.worker.tick();assert.equal(f.book.deliveryIssues(ctx(),s.id).length,1);
  assert.throws(()=>f.book.retryDelivery(ctx('u2'),s.id,s.version,f.rid()),{code:'FORBIDDEN'});
  f.book.retryDelivery(ctx(),s.id,s.version,f.rid());const good=workerFor(f);await good.worker.tick();assert.equal(good.posts.length,1);assert.equal(f.book.deliveryIssues(ctx(),s.id).length,0);
  await good.worker.tick();assert.equal(good.posts.length,1);
});
test('worker replaces started attendance controls and publishes only the next regular occurrence',async t=>{
  const f=fixture(t),s=f.make({repeat:true}),w=workerFor(f);await w.worker.tick();const id=f.book.get(ctx(),s.id).messageId;
  f.advance(s.startAt-f.now());await w.worker.tick();assert.equal(w.messages.get(id).payload.components[0].toJSON().components[0].custom_id,'sc:mine:0');
  assert.throws(()=>f.book.respond(ctx(),s.id,'yes',s.version,f.rid()));
  f.advance(s.duration*60_000+1);await w.worker.tick();assert.equal(f.book.get(ctx(),s.id).status,'elapsed');
  const published=f.repository.db.prepare('SELECT COUNT(*) n FROM schedules WHERE message_id IS NOT NULL').get().n;assert.equal(published,2);
});
test('all schedule menus and modals serialize inside Discord component limits',t=>{
  const f=fixture(t),s=f.make(f.book.parseInput('poll','오늘 21:00\n내일 20:00\n월 20:00\n화 21:00\n수 22:00'));
  const d=f.book.makeDraft(ctx(),f.party.id,{startAt:START+3600_000},f.rid()),p=f.service.getParty(ctx(),f.party.id);
  for(const modal of [ui.scheduleInputModal(p.id,'fixed'),ui.scheduleInputModal(p.id,'poll'),ui.scheduleReasonModal('confirm',s.id,s.version,s.candidates[0].id),ui.scheduleEditModal(s),ui.scheduleEditModal(s,true),ui.scheduleEditModal(s,false,true)]) {
    const data=modal.toJSON();assert.ok(data.custom_id.length<=100);assert.ok(data.components.length<=5);
  }
  for(const payload of [ui.scheduleVote(s,'u1'),ui.scheduleConfirmPicker(s,f.book),ui.scheduleBossPicker(d,p),ui.scheduleCancel(s,true),ui.scheduleRetry(s),ui.scheduleList(Array(20).fill(s),{partyId:p.id,page:1})]) {
    assert.ok(payload.components.length<=5);const ids=new Set();for(const row of payload.components)for(const c of row.toJSON().components){assert.ok(c.custom_id.length<=100);assert.ok(!ids.has(c.custom_id));ids.add(c.custom_id);if(c.options)assert.ok(c.options.length<=25);}
  }
});
test('changing a series time back preserves weekly identity and does not revive a skipped week',t=>{
  const f=fixture(t),s=f.make({repeat:true});
  const skipped=f.repository.db.prepare('SELECT id FROM schedules WHERE series_id=? AND original_at=?').get(s.seriesId,s.originalAt+WEEK);const skip=f.book.get(ctx(),skipped.id);f.book.cancel(ctx(),skip.id,skip.version,false,f.rid());
  const original=f.repository.db.prepare('SELECT id,original_at FROM schedules WHERE series_id=? ORDER BY original_at').all(s.seriesId);
  const later=f.book.edit(ctx(),s.id,s.version,{startAt:s.startAt+3600_000,future:true},f.rid());
  f.book.edit(ctx(),s.id,later.version,{startAt:s.startAt,future:true},f.rid());f.book.maintenance(ctx());
  assert.equal(f.book.get(ctx(),skip.id).status,'cancelled');
  for(const old of original){const current=f.book.get(ctx(),old.id);assert.equal(current.originalAt,old.original_at);if(current.status!=='cancelled')assert.equal(current.startAt,current.originalAt);}
  assert.equal(f.repository.db.prepare('SELECT COUNT(*) n FROM schedules WHERE series_id=?').get(s.seriesId).n,original.length);
});
