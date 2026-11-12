import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
const ctx=(userId='u1',threadId='t1',guildId='g1')=>({guildId,threadId,userId,isManager:false,eligibleOwnerIds:new Set(['u1','u2','u3'])});
function fixture(t) {
  const repo=new Repository(':memory:'),s=new PartyService(repo);let n=0;const rid=()=>`r${++n}`;
  t.after(()=>repo.close());s.start(ctx(),rid());return {s,rid,repo};
}
const add=(s,rid,who='u1',name='캐릭터')=>s.register(ctx(who),{name,world:'루나',job:'히어로'},rid());

test('each thread participant can register more than 25 characters with no product cap',t=>{
  const {s,rid}=fixture(t);for(let n=0;n<31;n++)add(s,rid,'u1',`도토리${n}`);add(s,rid,'u2','모찌');
  assert.equal(s.snapshot(ctx()).characters.filter(c=>c.active).length,32);
});
test('only owner can edit or unregister, including a manager',t=>{
  const {s,rid}=fixture(t),c=add(s,rid);
  assert.throws(()=>s.editCharacter({...ctx('u2'),isManager:true},c.id,{job:'비숍'},rid()),{code:'FORBIDDEN'});
  assert.throws(()=>s.unregister(ctx('u2'),c.id,rid()),{code:'FORBIDDEN'});
  assert.equal(s.editCharacter(ctx(),c.id,{job:'비숍'},rid()).job,'비숍');
});
test('same character and world cannot be claimed by a second user',t=>{
  const {s,rid}=fixture(t);add(s,rid,'u1','Maple');
  assert.throws(()=>add(s,rid,'u2','maple'),{code:'DUPLICATE'});
});
test('threads and guilds isolate characters, parties and request receipts',t=>{
  const {s,rid}=fixture(t),p=s.createParty(ctx(),'첫 파티',rid());
  const other=ctx('u1','t2');s.start(other,rid());assert.equal(s.snapshot(other).parties.length,0);
  assert.throws(()=>s.getParty(other,p.id),{code:'NOT_FOUND'});
  const guild=ctx('u1','t1','g2');s.start(guild,rid());assert.equal(s.snapshot(guild).parties.length,0);
});
test('duplicate delivery registers exactly once and receipt cannot be reused by another actor',t=>{
  const {s}=fixture(t),input={name:'나무',world:'루나',job:'비숍'};
  assert.equal(s.register(ctx(),input,'same').id,s.register(ctx(),input,'same').id);
  assert.equal(s.snapshot(ctx()).characters.length,1);
  assert.throws(()=>s.register(ctx('u2'),input,'same'),{code:'FORBIDDEN'});
});
test('one character per person in a party; same character can be reused across parties',t=>{
  const {s,rid}=fixture(t),a=add(s,rid,'u1','본캐'),b=add(s,rid,'u1','부캐');
  const p=s.createParty(ctx(),'본캐팟',rid()),q=s.createParty(ctx(),'다른 보스팟',rid());
  s.addCharacter(ctx(),p.id,a.id,rid());s.addCharacter(ctx(),q.id,a.id,rid());
  assert.throws(()=>s.addCharacter(ctx(),p.id,b.id,rid()),/한 사람당/);
  assert.equal(s.getParty(ctx(),q.id).characterIds[0],a.id);
});
test('a departed owner cannot be selected but can be removed from existing parties',t=>{
  const {s,rid}=fixture(t),c=add(s,rid,'u2','모찌'),p=s.createParty(ctx(),'파티',rid());
  assert.throws(()=>s.addCharacter({...ctx(),eligibleOwnerIds:new Set(['u1'])},p.id,c.id,rid()),{code:'NOT_MEMBER'});
  s.addCharacter(ctx(),p.id,c.id,rid());s.removeCharacter({...ctx(),eligibleOwnerIds:new Set()},p.id,c.id,rid());
  assert.equal(s.getParty(ctx(),p.id).characterIds.length,0);
});
test('party edits require creator or manager; copied party belongs to the copier',t=>{
  const {s,rid}=fixture(t),p=s.createParty(ctx(),'파티',rid());
  assert.throws(()=>s.renameParty(ctx('u2'),p.id,'변경',rid()),{code:'FORBIDDEN'});
  assert.equal(s.renameParty({...ctx('u2'),isManager:true},p.id,'수정',rid()).name,'수정');
  assert.equal(s.copyParty(ctx('u2'),p.id,'새 파티',rid()).creatorId,'u2');
});
test('old button versions cannot overwrite newer composition',t=>{
  const {s,rid}=fixture(t),p=s.createParty(ctx(),'파티',rid());s.addBoss(ctx(),p.id,'seren','하드',rid(),p.version);
  assert.throws(()=>s.addBoss(ctx(),p.id,'will','하드',rid(),p.version),{code:'STALE'});
  assert.equal(s.getParty(ctx(),p.id).bosses.length,1);
});
test('bosses are independent per party and difficulty is validated',t=>{
  const {s,rid}=fixture(t),p=s.createParty(ctx(),'A',rid()),q=s.createParty(ctx(),'B',rid());
  s.addBoss(ctx(),p.id,'seren','하드',rid());assert.equal(s.getParty(ctx(),q.id).bosses.length,0);
  assert.throws(()=>s.addBoss(ctx(),p.id,'seren','노말',rid()),{code:'DUPLICATE'});
  assert.throws(()=>s.addBoss(ctx(),p.id,'damien','익스트림',rid()),/지원 난이도/);
});
test('copy uses independent arrays and excludes inactive or departed registrations',t=>{
  const {s,rid}=fixture(t),a=add(s,rid,'u1','나'),b=add(s,rid,'u2','친구'),p=s.createParty(ctx(),'A',rid());
  s.addCharacter(ctx(),p.id,a.id,rid());s.addCharacter(ctx(),p.id,b.id,rid());s.addBoss(ctx(),p.id,'will','하드',rid());
  const q=s.copyParty({...ctx(),eligibleOwnerIds:new Set(['u1'])},p.id,'B',rid());assert.deepEqual(q.characterIds,[a.id]);
  s.removeBoss(ctx(),q.id,'will',rid());assert.equal(s.getParty(ctx(),p.id).bosses.length,1);
});
test('archive is reversible and does not erase references',t=>{
  const {s,rid}=fixture(t),c=add(s,rid),p=s.createParty(ctx(),'A',rid());s.addCharacter(ctx(),p.id,c.id,rid());
  assert.throws(()=>s.unregister(ctx(),c.id,rid()),{code:'IN_USE'});
  s.archive(ctx(),p.id,true,rid());assert.throws(()=>s.getParty(ctx(),p.id),{code:'NOT_FOUND'});
  s.archive(ctx(),p.id,false,rid());assert.equal(s.getParty(ctx(),p.id).characterIds[0],c.id);
});
test('cannot silently change identity of a character already used in a party',t=>{
  const {s,rid}=fixture(t),c=add(s,rid),p=s.createParty(ctx(),'A',rid());s.addCharacter(ctx(),p.id,c.id,rid());
  assert.throws(()=>s.editCharacter(ctx(),c.id,{world:'스카니아'},rid()),{code:'IN_USE'});
});
test('restoration does not reactivate an unregistered character',t=>{
  const {s,rid}=fixture(t),c=add(s,rid),p=s.createParty(ctx(),'A',rid());s.addCharacter(ctx(),p.id,c.id,rid());
  s.archive(ctx(),p.id,true,rid());s.unregister(ctx(),c.id,rid());
  assert.throws(()=>s.archive(ctx(),p.id,false,rid()),{code:'INACTIVE_CHARACTER'});
  assert.equal(s.copyParty(ctx(),p.id,'비어 있는 복사',rid()).characterIds.length,0);
});
test('first version rejects mixed-world composition without modifying slots',t=>{
  const {s,rid}=fixture(t),a=add(s,rid),b=s.register(ctx('u2'),{name:'다른월드',world:'스카니아',job:'비숍'},rid()),p=s.createParty(ctx(),'A',rid());
  s.addCharacter(ctx(),p.id,a.id,rid());assert.throws(()=>s.addCharacter(ctx(),p.id,b.id,rid()),/같은 월드/);
  assert.equal(s.getParty(ctx(),p.id).characterIds.length,1);
});
test('failed mutation is rolled back and does not consume the request ID',t=>{
  const {s,rid}=fixture(t),p=s.createParty(ctx(),'A',rid());
  assert.throws(()=>s.addBoss(ctx(),p.id,'will','잘못된 난이도','retry'));
  s.addBoss(ctx(),p.id,'will','하드','retry');assert.equal(s.getParty(ctx(),p.id).bosses.length,1);
});
test('database and deduplication survive a process restart',t=>{
  const dir=mkdtempSync(join(tmpdir(),'maple-bot-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'test.sqlite');let repo=new Repository(path),s=new PartyService(repo);
  s.start(ctx(),'start');const p=s.createParty(ctx(),'저장되는 파티','create');repo.close();
  repo=new Repository(path);t.after(()=>repo.close());s=new PartyService(repo);
  assert.equal(s.getParty(ctx(),p.id).name,'저장되는 파티');
  assert.equal(s.createParty(ctx(),'저장되는 파티','create').id,p.id);assert.equal(s.snapshot(ctx()).parties.length,1);
});
test('backup script captures the live WAL-backed database and refuses overwrite',t=>{
  const dir=mkdtempSync(join(tmpdir(),'maple-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'live.sqlite'),target=join(dir,'backup.sqlite');const repo=new Repository(source);t.after(()=>repo.close());
  const s=new PartyService(repo);s.start(ctx(),'start');const p=s.createParty(ctx(),'백업할 파티','party');
  const child=spawnSync(process.execPath,['scripts/backup.js',target],{env:{...process.env,DATABASE_PATH:source},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const copy=new Repository(target);t.after(()=>copy.close());
  assert.equal(new PartyService(copy).getParty(ctx(),p.id).name,'백업할 파티');
  const again=spawnSync(process.execPath,['scripts/backup.js',target],{env:{...process.env,DATABASE_PATH:source},encoding:'utf8'});assert.equal(again.status,1);
});
