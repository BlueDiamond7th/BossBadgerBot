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
const snapshot=(f,id,at,power,level=280)=>f.repository.db.prepare('INSERT INTO spec_snapshots VALUES(?,?,?,?,?,?,?)').run(`${id}-${at}`,'g','t',id,at,'2026-11-13',JSON.stringify({level,combatPower:power,equipment:{},skills:{}}));

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

const desc=p=>p.embeds[0].toJSON().description;
function fixture(t) {
  const f=setup(t),add=(owner,name,power,level)=>{const c=f.service.register(ctx(owner),{name,world:'크로아',job:'히어로'},`r-${name}`);if(power)snapshot(f,c.id,1,power,level);return c;};
  // u2 owns the strongest character, so u2's group comes first; inside a group, strongest first.
  add('u1','약한1','100000000',285);add('u1','강한1','300000000',290);add('u2','최강2','500000000',291);add('u2','중간2','200000000',280);add('u3','미수집3');
  const stats=f.tracker.latestStats(ctx(),f.service.snapshot(ctx()).characters.map(c=>c.id));
  return {...f,stats,state:f.service.snapshot(ctx())};
}
test('roster groups characters under each registrant mention, strongest group and character first',t=>{
  const {state,stats}=fixture(t);
  const groups=desc(views.roster(state,0,'all',new Set(['u1','u2']),stats)).split('\n\n');
  assert.deepEqual(groups.map(g=>g.split('\n')[0]),['<@u2>','<@u1>','<@u3> · ⚠️ 현재 참가자 아님']);
  const u2=groups[0].split('\n');
  assert.equal(u2[1],`[**최강2**](${views.scouterUrl('최강2')}) - 크로아 - Lv.291`);
  assert.equal(u2[2],'히어로 / 전투력 : 5억');
  assert.match(u2[3],/^\[\*\*중간2\*\*\]/);
  assert.deepEqual(groups[1].split('\n').filter(l=>l.startsWith('[')).map(l=>l.match(/\*\*(.+)\*\*/)[1]),['강한1','약한1']);
  assert.equal(groups[2].split('\n')[1],`[**미수집3**](${views.scouterUrl('미수집3')}) - 크로아 - Lv.?`);
  assert.equal(groups[2].split('\n')[2],'히어로 / 전투력 : 미수집');
});
test('level filters keep only characters at or above 285/290 and report unknown levels',t=>{
  const {state,stats}=fixture(t);
  const p290=views.roster(state,0,'all',null,stats,290);
  assert.deepEqual([...desc(p290).matchAll(/\*\*\[?\*?\*?([^*\]]+)\*\*\]/g)].map(m=>m[1]),['최강2','강한1']);
  assert.match(p290.embeds[0].toJSON().footer.text,/2개 · Lv\.290 이상 \(레벨 미수집 1명 제외\)/);
  const names285=[...desc(views.roster(state,0,'all',null,stats,285)).matchAll(/\[\*\*(.+?)\*\*\]/g)].map(m=>m[1]);
  assert.deepEqual(names285,['최강2','강한1','약한1']);
  const mine=desc(views.roster(state,0,'u1',null,stats,290));
  assert.equal(mine.split('\n')[0],'<@u1>');assert.equal((mine.match(/\[\*\*/g)??[]).length,1);
  assert.match(desc(views.roster(state,0,'u3',null,stats,285)),/조건에 맞는 캐릭터가 없어요/);
});
test('a group cut by paging is continued with "(계속)" on the next page',t=>{
  const f=setup(t);
  for(let i=0;i<12;i++) {const c=f.service.register(ctx(),{name:`캐릭${String(i).padStart(2,'0')}`,world:'크로아',job:'히어로'},`r${i}`);snapshot(f,c.id,1,String(1000+i));}
  const state=f.service.snapshot(ctx()),stats=f.tracker.latestStats(ctx(),state.characters.map(c=>c.id));
  const first=desc(views.roster(state,0,'all',null,stats)).split('\n');
  assert.equal(first[0],'<@u1>');assert.match(first[1],/^\[\*\*캐릭11\*\*\]/);assert.equal(first[2],'히어로 / 전투력 : 1011');
  const second=desc(views.roster(state,1,'all',null,stats)).split('\n');
  assert.equal(second[0],'<@u1> (계속)');assert.match(second[1],/^\[\*\*캐릭01\*\*\]/);
});
test('roster buttons: paging keeps filters, filter buttons and @ select restart at page 1 with unique IDs',async t=>{
  const f=fixture(t);
  const handler=createHandler({service:f.service,tracker:f.tracker,guildId:'g',verifyContext:async()=>ctx(),resolveOwners:async(_,ids)=>new Set(ids)});
  const out=[];const base={id:'x',user:{id:'u1'},guildId:'g',channel:{id:'t',isThread:()=>true},inGuild:()=>true,isAutocomplete:()=>false,isChatInputCommand:()=>false,isButton:()=>false,isStringSelectMenu:()=>false,isUserSelectMenu:()=>false,isModalSubmit:()=>false,
    message:{flags:{has:()=>true}},async deferReply(){},async deferUpdate(){},async deleteReply(){},async editReply(p){out.push(p);},async followUp(p){out.push(p);}};
  await handler({...base,isChatInputCommand:()=>true,commandName:'캐릭터',options:{getSubcommand:()=>'목록',getUser:()=>null,getString:()=>null}});
  const rows=out.at(-1).components.map(r=>r.toJSON().components);
  assert.deepEqual(rows.map(r=>r.map(c=>c.label??c.placeholder)),[['이전','다음'],['등록자로 보기 (@검색)'],['전체 등록자','전체 레벨','Lv.285+','Lv.290+'],['캐릭터 추가 / 삭제','스펙 변화','보스 히스토리','내 스케줄러'],['보스방','캐릭터','파티','분배금 계산']]);
  const ids=rows.flat().map(c=>c.custom_id);assert.equal(new Set(ids).size,ids.length);
  await handler({...base,id:'b1',isButton:()=>true,customId:rows[2][3].custom_id});
  assert.match(out.at(-1).embeds[0].toJSON().footer.text,/Lv\.290 이상/);
  const levelRows=out.at(-1).components.map(r=>r.toJSON().components);
  assert.equal(levelRows[2][3].style,1,'active filter is highlighted');
  await handler({...base,id:'b2',isUserSelectMenu:()=>true,customId:levelRows[1][0].custom_id,values:['u2']});
  const picked=out.at(-1);
  assert.deepEqual(desc(picked).split('\n').filter(l=>l.startsWith('[')).map(l=>l.match(/\*\*(.+?)\*\*/)[1]),['최강2']);
  assert.deepEqual(picked.components[1].toJSON().components[0].default_values,[{id:'u2',type:'user'}]);
  await handler({...base,id:'b3',isButton:()=>true,customId:picked.components[2].toJSON().components[0].custom_id});
  assert.equal((desc(out.at(-1)).match(/\[\*\*/g)??[]).length,2,'전체 등록자 keeps the Lv.290 filter');
  await handler({...base,id:'b4',isButton:()=>true,customId:'mp:rosterlvl:all:999'});
  assert.doesNotMatch(out.at(-1).embeds[0].toJSON().footer.text,/이상/,'unknown level values fall back to all levels');
});
