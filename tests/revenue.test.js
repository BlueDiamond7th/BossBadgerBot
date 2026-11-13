import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { PartyService } from '../src/service.js';
import { parseMeso, formatMeso, distribution, partyRevenue, PriceBook, DistributionBook } from '../src/revenue.js';
import { DEFAULT_CRYSTAL_PRICES, BOSSES, bossById, partyLimit } from '../src/catalog.js';

const ctx=(userId='u1')=>({guildId:'g',threadId:'t',userId,isManager:false,eligibleOwnerIds:new Set(['u1','u2','u3','u4'])});
function fixture(t) {
  const repo=new Repository(':memory:');t.after(()=>repo.close());
  const service=new PartyService(repo);let n=0;const rid=()=>`r${++n}`;service.start(ctx(),rid());
  const p=service.createParty(ctx(),'목요일팟',rid());
  for(const [owner,name] of [['u1','도토리'],['u2','모찌'],['u3','감자']]) {const c=service.register(ctx(owner),{name,world:'루나'},rid());service.addCharacter(ctx(),p.id,c.id,rid());}
  return {repo,service,rid,party:service.getParty(ctx(),p.id)};
}

test('meso amounts accept Korean units and commas and render back in 억/만',()=>{
  assert.equal(parseMeso('4억 6500만'),465_000_000);
  assert.equal(parseMeso('4890만'),48_900_000);
  assert.equal(parseMeso('1,230,000,000'),1_230_000_000);
  assert.equal(parseMeso('1.5억'),150_000_000);
  assert.equal(parseMeso('96억 메소'),9_600_000_000);
  for(const bad of ['','abc','-5','0','2조']) assert.throws(()=>parseMeso(bad));
  assert.equal(formatMeso(465_000_000),'4억 6,500만 메소');
  assert.equal(formatMeso(9_600_000_000),'96억 메소');
  assert.equal(formatMeso(12_345),'1만 2,345 메소');
});
test('initial crystal price table matches the specification',()=>{
  assert.equal(Object.keys(DEFAULT_CRYSTAL_PRICES).length,39);
  assert.equal(DEFAULT_CRYSTAL_PRICES['lotus:하드'],48_900_000);
  assert.equal(DEFAULT_CRYSTAL_PRICES['jinhilla:하드'],100_000_000);
  assert.equal(DEFAULT_CRYSTAL_PRICES['blackmage:익스트림'],5_680_000_000);
  assert.equal(DEFAULT_CRYSTAL_PRICES['jupiter:하드'],5_387_000_000);
  assert.equal(DEFAULT_CRYSTAL_PRICES['baldrix:익스트림'],9_600_000_000);
  // Every priced key refers to a real boss difficulty.
  for(const key of Object.keys(DEFAULT_CRYSTAL_PRICES)) {const [id,d]=key.split(':');assert.ok(BOSSES.find(b=>b.id===id)?.difficulties.includes(d),key);}
});
test('distribution follows the 0.95 / 0.97 formulas with floor rounding',()=>{
  const r=distribution(1_000_000_000,3);
  assert.equal(r.net,950_000_000);assert.equal(r.mvpNet,970_000_000);
  assert.equal(r.share,300_833_333);assert.equal(r.mvpShare,313_633_333);
  assert.equal(distribution(100,0).memberCount,1);
});
test('party crystal revenue divides by party size capped by each boss and difficulty limit',()=>{
  const party={characterIds:['a','b','c','d'],bosses:[{bossId:'adversary',difficulty:'하드'},{bossId:'kalos',difficulty:'카오스'},{bossId:'lotus',difficulty:'익스트림'},{bossId:'blackmage',difficulty:'하드'},{bossId:'lotus',difficulty:'노말'}]};
  const r=partyRevenue(party,DEFAULT_CRYSTAL_PRICES);
  assert.equal(r.lines[0].divisor,3);assert.equal(r.lines[0].share,463_333_333);
  // 칼로스·카링 are 6-person bosses, so four members split four ways.
  assert.equal(r.lines[1].divisor,4);assert.equal(r.lines[1].share,307_500_000);
  assert.equal(r.lines[2].divisor,2);assert.equal(r.lines[2].share,272_500_000);
  assert.equal(r.lines[4].price,null);
  assert.equal(r.weekly,463_333_333+307_500_000+272_500_000);assert.equal(r.monthly,116_250_000);
  assert.equal(partyLimit(bossById('kaling'),'익스트림'),6);assert.equal(partyLimit(bossById('lotus'),'하드'),6);
});
test('servers can override crystal prices but not for bosses assumed to be soloed',t=>{
  const {repo}=fixture(t),book=new PriceBook(repo);
  const r=book.set(ctx(),'kalos','카오스','12억 5000만');
  assert.equal(r.before,1_230_000_000);assert.equal(r.price,1_250_000_000);
  const all=book.all('g');assert.equal(all.prices['kalos:카오스'],1_250_000_000);assert.ok(all.overrides.has('kalos:카오스'));
  assert.equal(book.all('other').prices['kalos:카오스'],1_230_000_000);
  assert.throws(()=>book.set(ctx(),'lotus','노말','1억'),{code:'NOT_PRICED'});
  assert.throws(()=>book.set(ctx(),'lotus','카오스','1억'));
});
test('only a party member can be the seller and only the seller can edit, with every edit logged',t=>{
  const {repo,service,party}=fixture(t),book=new DistributionBook({repository:repo,service});
  assert.throws(()=>book.create(ctx(),{partyId:party.id,sellerId:'u4',item:'미트라의 분노',price:'25억'},'d0'),/해당 파티의 인원이 아닙니다/);
  const record=book.create(ctx(),{partyId:party.id,sellerId:'u2',item:'미트라의 분노',price:'25억'},'d1');
  assert.equal(record.memberCount,3);assert.equal(record.price,2_500_000_000);assert.equal(record.createdBy,'u1');
  assert.equal(book.create(ctx(),{partyId:party.id,sellerId:'u2',item:'중복',price:'1억'},'d1').item,'미트라의 분노');
  assert.throws(()=>book.update(ctx('u1'),'d1',{price:'30억'}),{code:'FORBIDDEN'});
  const edited=book.update(ctx('u2'),'d1',{item:'창세의 뱃지',price:'30억'});
  assert.equal(edited.price,3_000_000_000);assert.equal(edited.edits,1);
  const mvp=book.update(ctx('u2'),'d1',{mvp:true});assert.equal(mvp.mvp,true);
  const resized=book.update(ctx('u2'),'d1',{memberCount:'5'});assert.equal(resized.memberCount,5);
  for(const bad of ['0','7','2.5','다섯']) assert.throws(()=>book.update(ctx('u2'),'d1',{memberCount:bad}),/파티원 수/);
  const log=book.edits('d1');assert.equal(log.length,3);
  assert.deepEqual(JSON.parse(log[0].after_json),{item:'창세의 뱃지',price:3_000_000_000,memberCount:5,mvp:true});
  assert.deepEqual(JSON.parse(log[2].before_json),{item:'미트라의 분노',price:2_500_000_000,memberCount:3,mvp:false});
  assert.equal(log[1].editor_id,'u2');
  assert.equal(book.list(ctx(),party.id).length,1);
  assert.throws(()=>book.get({...ctx(),threadId:'other'},'d1'),{code:'NOT_FOUND'});
});
