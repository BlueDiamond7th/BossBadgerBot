import { requireRule } from './errors.js';
import { BOSSES, bossById, DEFAULT_CRYSTAL_PRICES, priceKey, partyLimit } from './catalog.js';

export const MAX_MESO=1_000_000_000_000;
export const MAX_MEMBERS=6;
function parseMembers(value) {
  const n=typeof value==='number'?value:Number(String(value??'').trim().replace(/명$/,''));
  requireRule(Number.isInteger(n)&&n>=1&&n<=MAX_MEMBERS,`파티원 수는 1~${MAX_MEMBERS} 사이 정수로 입력해 주세요.`);
  return n;
}
// Accepts "4890만", "4억 6500만", "1,230,000,000" and plain digits.
export function parseMeso(input) {
  const raw=String(input??'').replace(/[,\s]/g,'').replace(/메소$/,'');
  requireRule(raw.length>0&&raw.length<=30,'금액을 입력해 주세요. 예: 4억 6500만, 1230000000');
  let total=0,rest=raw;
  for(const [unit,size] of [['조',1_000_000_000_000],['억',100_000_000],['만',10_000]]) {
    const at=rest.indexOf(unit);
    if(at<0) continue;
    const part=rest.slice(0,at);
    requireRule(/^\d+(\.\d+)?$/.test(part),'금액 형식을 확인해 주세요. 예: 4억 6500만');
    total+=Math.round(Number(part)*size);rest=rest.slice(at+1);
  }
  if(rest) {requireRule(/^\d+$/.test(rest),'금액 형식을 확인해 주세요. 예: 4억 6500만');total+=Number(rest);}
  requireRule(Number.isSafeInteger(total)&&total>0&&total<=MAX_MESO,'금액은 1메소 이상 1조 메소 이하로 입력해 주세요.');
  return total;
}
export function formatMeso(value) {
  const n=Math.floor(Number(value));
  if(!Number.isFinite(n)) return '-';
  const eok=Math.floor(n/100_000_000),man=Math.floor(n%100_000_000/10_000),rest=n%10_000;
  const parts=[];
  if(eok) parts.push(`${eok.toLocaleString('ko-KR')}억`);
  if(man) parts.push(`${man.toLocaleString('ko-KR')}만`);
  if(rest||!parts.length) parts.push(rest.toLocaleString('ko-KR'));
  return `${parts.join(' ')} 메소`;
}

// Distribution formulas from the feature specification.
export function distribution(price,memberCount) {
  const n=Math.max(1,memberCount);
  const net=Math.floor(price*0.95),mvpNet=Math.floor(price*0.97);
  return {price,memberCount:n,net,mvpNet,share:Math.floor(net/n*0.95),mvpShare:Math.floor(mvpNet/n*0.97)};
}

export class PriceBook {
  constructor(repository,now=()=>Date.now()) {
    this.db=repository.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS crystal_prices (
      guild_id TEXT NOT NULL, boss_key TEXT NOT NULL, price INTEGER NOT NULL,
      updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id,boss_key));`);
  }
  all(guildId) {
    const prices={...DEFAULT_CRYSTAL_PRICES},overrides=new Set();
    for(const row of this.db.prepare('SELECT boss_key,price FROM crystal_prices WHERE guild_id=?').all(guildId)) {prices[row.boss_key]=row.price;overrides.add(row.boss_key);}
    return {prices,overrides};
  }
  set(ctx,bossId,difficulty,price) {
    const boss=bossById(bossId);
    requireRule(boss?.difficulties.includes(difficulty),'해당 보스의 지원 난이도를 선택해 주세요.');
    const key=priceKey(bossId,difficulty);
    requireRule(key in DEFAULT_CRYSTAL_PRICES,'노말 진 힐라 이하 보스는 솔플로 가정해 결정석 가격을 관리하지 않아요.','NOT_PRICED');
    const value=typeof price==='number'?price:parseMeso(price);
    requireRule(Number.isSafeInteger(value)&&value>0&&value<=MAX_MESO,'금액은 1메소 이상 1조 메소 이하로 입력해 주세요.');
    const before=this.all(ctx.guildId).prices[key];
    this.db.prepare(`INSERT INTO crystal_prices VALUES(?,?,?,?,?)
      ON CONFLICT(guild_id,boss_key) DO UPDATE SET price=excluded.price,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(ctx.guildId,key,value,ctx.userId,this.now());
    return {boss,difficulty,before,price:value};
  }
}

// Crystal income for one party: price divided by party size, capped by the boss's max party size.
export function partyRevenue(party,prices) {
  const size=Math.max(1,party.characterIds.length);
  const lines=[];let weekly=0,monthly=0;
  for(const b of party.bosses) {
    const boss=bossById(b.bossId),price=prices[priceKey(b.bossId,b.difficulty)];
    if(!boss||!price) {lines.push({boss,difficulty:b.difficulty,price:null});continue;}
    const divisor=Math.min(size,partyLimit(boss,b.difficulty)),share=Math.floor(price/divisor);
    if(boss.monthly) monthly+=share;else weekly+=share;
    lines.push({boss,difficulty:b.difficulty,price,divisor,share});
  }
  return {lines,weekly,monthly,size};
}

export const pricedBosses=()=>BOSSES.map(b=>({...b,priced:b.difficulties.filter(d=>priceKey(b.id,d) in DEFAULT_CRYSTAL_PRICES)})).filter(b=>b.priced.length);

const text=(value,label,max)=>{
  requireRule(typeof value==='string'&&value.trim().length>0,`${label}을(를) 입력해 주세요.`);
  const v=value.trim().normalize('NFC');
  requireRule(v.length<=max,`${label}은(는) ${max}자 이내로 입력해 주세요.`);
  requireRule(!/[\x00-\x1f\x7f]/u.test(v),`${label}에 줄바꿈이나 제어문자를 넣을 수 없어요.`);
  return v;
};
export class DistributionBook {
  constructor({repository,service,now=()=>Date.now()}) {
    this.db=repository.db;this.service=service;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS distributions (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, party_id TEXT NOT NULL,
      seller_id TEXT NOT NULL, item TEXT NOT NULL, price INTEGER NOT NULL, mvp INTEGER NOT NULL DEFAULT 0,
      member_count INTEGER NOT NULL, member_ids TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS distributions_party ON distributions(guild_id,thread_id,party_id,created_at);
      CREATE TABLE IF NOT EXISTS distribution_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, distribution_id TEXT NOT NULL, editor_id TEXT NOT NULL,
      edited_at INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL);`);
  }
  // Seller must own an active character in the party; Discord membership is checked by the caller.
  partyMembers(ctx,partyId) {
    const s=this.service.snapshot(ctx),p=s.parties.find(p=>p.id===partyId&&!p.archived);
    requireRule(p,'이 채널에서 활성 파티를 찾을 수 없어요.','NOT_FOUND');
    const owners=new Set(p.characterIds.map(id=>s.characters.find(c=>c.id===id)?.ownerId).filter(Boolean));
    return {party:p,owners};
  }
  requireSeller(ctx,partyId,sellerId) {
    const {party,owners}=this.partyMembers(ctx,partyId);
    requireRule(owners.has(sellerId),'해당 파티의 인원이 아닙니다.','NOT_PARTY_MEMBER');
    return {party,owners};
  }
  create(ctx,{partyId,sellerId,item,price},rid) {
    const {party,owners}=this.requireSeller(ctx,partyId,sellerId);
    const record={id:rid,item:text(item,'거래 품목',60),price:typeof price==='number'?price:parseMeso(price)};
    requireRule(Number.isSafeInteger(record.price)&&record.price>0&&record.price<=MAX_MESO,'금액은 1메소 이상 1조 메소 이하로 입력해 주세요.');
    const now=this.now();
    // The request id doubles as the record id, so Discord retries do not create duplicates.
    this.db.prepare('INSERT OR IGNORE INTO distributions VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?)').run(rid,ctx.guildId,ctx.threadId,party.id,sellerId,record.item,record.price,party.characterIds.length,JSON.stringify([...owners]),ctx.userId,now,now);
    return this.get(ctx,rid);
  }
  get(ctx,id) {
    const row=this.db.prepare('SELECT * FROM distributions WHERE id=? AND guild_id=? AND thread_id=?').get(id,ctx.guildId,ctx.threadId);
    requireRule(row,'분배 기록을 찾을 수 없어요.','NOT_FOUND');
    const party=this.service.snapshot(ctx).parties.find(p=>p.id===row.party_id);
    return {id:row.id,partyId:row.party_id,partyName:party?.name??'삭제된 파티',sellerId:row.seller_id,item:row.item,price:row.price,mvp:Boolean(row.mvp),memberCount:row.member_count,memberIds:JSON.parse(row.member_ids),createdBy:row.created_by,createdAt:row.created_at,updatedAt:row.updated_at,edits:this.db.prepare('SELECT COUNT(*) AS n FROM distribution_edits WHERE distribution_id=?').get(row.id).n};
  }
  list(ctx,partyId) {
    return this.db.prepare('SELECT id FROM distributions WHERE guild_id=? AND thread_id=? AND party_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(ctx.guildId,ctx.threadId,partyId).map(r=>this.get(ctx,r.id));
  }
  edits(id) {return this.db.prepare('SELECT * FROM distribution_edits WHERE distribution_id=? ORDER BY id DESC LIMIT 20').all(id);}
  // Only the seller can change item, price, member count or the MVP discount; each change is logged.
  update(ctx,id,changes) {
    const before=this.get(ctx,id);
    requireRule(before.sellerId===ctx.userId,'판매자로 지정된 사람만 수정할 수 있어요.','FORBIDDEN');
    const after={item:changes.item!=null?text(changes.item,'거래 품목',60):before.item,price:changes.price!=null?(typeof changes.price==='number'?changes.price:parseMeso(changes.price)):before.price,memberCount:changes.memberCount!=null?parseMembers(changes.memberCount):before.memberCount,mvp:changes.mvp!=null?Boolean(changes.mvp):before.mvp};
    requireRule(Number.isSafeInteger(after.price)&&after.price>0&&after.price<=MAX_MESO,'금액은 1메소 이상 1조 메소 이하로 입력해 주세요.');
    if(after.item===before.item&&after.price===before.price&&after.memberCount===before.memberCount&&after.mvp===before.mvp) return before;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE distributions SET item=?,price=?,member_count=?,mvp=?,updated_at=? WHERE id=?').run(after.item,after.price,after.memberCount,after.mvp?1:0,this.now(),id);
      this.db.prepare('INSERT INTO distribution_edits(distribution_id,editor_id,edited_at,before_json,after_json) VALUES(?,?,?,?,?)').run(id,ctx.userId,this.now(),JSON.stringify({item:before.item,price:before.price,memberCount:before.memberCount,mvp:before.mvp}),JSON.stringify(after));
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    return this.get(ctx,id);
  }
}
