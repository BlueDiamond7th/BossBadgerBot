import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { PersonalConnections } from '../src/connections.js';
import { SpecTracker } from '../src/specs.js';
import { createHandler } from '../src/interactions.js';
import * as views from '../src/views.js';

const ctx=(userId='u1')=>({guildId:'g',threadId:'t',userId,isManager:false});
function setup(t) {
  const repository=new Repository(':memory:');t.after(()=>repository.close());
  const service=new PartyService(repository);service.start(ctx(),'start');
  const connections=new PersonalConnections({repository,service,encryptionKey:Buffer.alloc(32,3).toString('base64')});
  const tracker=new SpecTracker({repository,service,connections});
  return {repository,service,tracker};
}
const snapshot=(f,id,at,power)=>f.repository.db.prepare('INSERT INTO spec_snapshots VALUES(?,?,?,?,?,?,?)').run(`${id}-${at}`,'g','t',id,at,'2026-11-13',JSON.stringify({level:280,combatPower:power,equipment:{},skills:{}}));

test('roster lines read "닉네임 · 월드 - @등록자" then "직업 / 전투력 : #### [환산 사이트]"',t=>{
  const f=setup(t);
  const a=f.service.register(ctx('u1'),{name:'도토리',world:'크로아',job:'블래스터'},'a');
  f.service.register(ctx('u2'),{name:'모찌 빵',world:'루나'},'b');
  const lines=views.roster(f.service.snapshot(ctx()),0,'all',new Set(['u1']),new Map([[a.id,'123456789']])).embeds[0].toJSON().description.split('\n\n');
  assert.equal(lines[0],'**도토리** · 크로아 - <@u1>\n블래스터 / 전투력 : 123,456,789 [환산 사이트](https://maplescouter.com/ko/info?name=%EB%8F%84%ED%86%A0%EB%A6%AC)');
  assert.equal(lines[1],`**모찌 빵** · 루나 - <@u2> · ⚠️ 현재 참가자 아님\n직업 미확인 / 전투력 : 미수집 [환산 사이트](${views.scouterUrl('모찌 빵')})`);
  assert.equal(views.scouterUrl('모찌 빵'),'https://maplescouter.com/ko/info?name=%EB%AA%A8%EC%B0%8C%20%EB%B9%B5');
});
test('roster power comes from the newest spec snapshot, then the selection cache, without API calls',t=>{
  const f=setup(t);
  const [a,b,c]=['A','B','C'].map((name,i)=>f.service.register(ctx(),{name,world:'크로아'},`r${i}`));
  snapshot(f,a.id,1,'100');snapshot(f,a.id,3,'300');snapshot(f,a.id,2,'200');
  f.repository.db.prepare('INSERT INTO personal_characters VALUES(?,?,?,?,?,?,1)').run('g','t',b.id,'u1','hash-b','sealed');
  f.repository.db.prepare('INSERT INTO personal_selection_power VALUES(?,?,?,?,?,?)').run('g','t','u1','hash-b','5000',1);
  const powers=f.tracker.latestPowers(ctx(),[a.id,b.id,c.id]);
  assert.deepEqual([...powers],[[a.id,'300'],[b.id,'5000']]);
  assert.equal(f.tracker.latestPowers({...ctx(),threadId:'other'},[a.id]).size,0);
  assert.equal(f.tracker.latestPowers(ctx(),[]).size,0);
});
test('/캐릭터 목록 and roster paging render the new format with stored powers',async t=>{
  const f=setup(t);
  for(let i=0;i<12;i++) {const c=f.service.register(ctx(),{name:`캐릭${String(i).padStart(2,'0')}`,world:'크로아',job:'히어로'},`r${i}`);snapshot(f,c.id,1,String(1000+i));}
  const handler=createHandler({service:f.service,tracker:f.tracker,guildId:'g',verifyContext:async()=>ctx(),resolveOwners:async(_,ids)=>new Set(ids)});
  const out=[];const base={id:'x',user:{id:'u1'},guildId:'g',channel:{id:'t',isThread:()=>true},inGuild:()=>true,isAutocomplete:()=>false,isStringSelectMenu:()=>false,isModalSubmit:()=>false,
    message:{flags:{has:()=>true}},async deferReply(){},async deferUpdate(){},async deleteReply(){},async editReply(p){out.push(p);},async followUp(p){out.push(p);}};
  await handler({...base,isChatInputCommand:()=>true,isButton:()=>false,commandName:'캐릭터',options:{getSubcommand:()=>'목록',getUser:()=>null,getString:()=>null}});
  const first=out.at(-1).embeds[0].toJSON().description;
  assert.match(first,/^\*\*캐릭00\*\* · 크로아 - <@u1>\n히어로 \/ 전투력 : 1,000 \[환산 사이트\]\(https:\/\/maplescouter\.com\/ko\/info\?name=/);
  await handler({...base,id:'y',isChatInputCommand:()=>false,isButton:()=>true,customId:'mp:roster:all:1'});
  assert.match(out.at(-1).embeds[0].toJSON().description,/\*\*캐릭11\*\* · 크로아 - <@u1>\n히어로 \/ 전투력 : 1,011 /);
});
