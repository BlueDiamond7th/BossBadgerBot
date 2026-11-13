import { requireRule } from './errors.js';
import { kstDay } from './nexon.js';
import { fromScheduler, priceKey } from './catalog.js';

const DAY=86400_000;
// MapleStory weekly bosses reset on Thursday 00:00 KST. Returns that Thursday as YYYY-MM-DD.
export function weekStart(time) {
  const kst=new Date(time+9*3600_000),since=(kst.getUTCDay()-4+7)%7;
  return new Date(Date.UTC(kst.getUTCFullYear(),kst.getUTCMonth(),kst.getUTCDate())-since*DAY).toISOString().slice(0,10);
}
export const addDays=(day,n)=>new Date(Date.parse(`${day}T00:00:00Z`)+n*DAY).toISOString().slice(0,10);
const weekOfDay=day=>weekStart(Date.parse(`${day}T00:00:00+09:00`));

// Boss records reuse the scheduler snapshots that PersonalConnections/SpecTracker already collect.
// Reads come from that cache; only an explicit refresh (or an empty cache) calls the API with the owner's key.
export class BossRecords {
  constructor({repository,service,tracker,connections,now=()=>Date.now()}) {
    this.db=repository.db;this.service=service;this.tracker=tracker;this.connections=connections;this.now=now;this.inflight=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS boss_history (
      guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, character_id TEXT NOT NULL, week TEXT NOT NULL,
      data_json TEXT NOT NULL, saved_by TEXT NOT NULL, saved_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id,thread_id,character_id,week));`);
  }
  // A viewer may see a character's records if they own it or have a character in the same active party.
  access(ctx,characterId) {
    const s=this.service.snapshot(ctx),c=s.characters.find(c=>c.id===characterId&&c.active);
    requireRule(c,'현재 등록된 캐릭터를 선택해 주세요.','NOT_FOUND');
    if(c.ownerId!==ctx.userId) {
      const shared=s.parties.some(p=>!p.archived&&p.characterIds.includes(c.id)&&p.characterIds.some(id=>s.characters.find(x=>x.id===id)?.ownerId===ctx.userId));
      requireRule(shared,'같은 파티의 파티원 캐릭터 기록만 조회할 수 있어요.','FORBIDDEN');
    }
    return c;
  }
  range(period) {
    const thisWeek=weekStart(this.now());
    return period==='last'?{from:addDays(thisWeek,-7),to:addDays(thisWeek,-1)}:{from:thisWeek,to:kstDay(this.now())};
  }
  cached(ctx,characterId,period) {
    const c=this.access(ctx,characterId),{from,to}=this.range(period);
    const row=this.db.prepare('SELECT day,collected_at,data_json FROM scheduler_snapshots WHERE guild_id=? AND thread_id=? AND character_id=? AND day BETWEEN ? AND ? ORDER BY day DESC LIMIT 1').get(ctx.guildId,ctx.threadId,characterId,from,to);
    return row?toRecord(c,period,row):null;
  }
  async refresh(ctx,characterId,period) {
    const c=this.access(ctx,characterId),owner={...ctx,userId:c.ownerId};
    requireRule(this.connections?.status(owner).connected,c.ownerId===ctx.userId?'먼저 /캐릭터 연결로 내 API 키를 연결해 주세요.':'이 캐릭터의 등록자가 아직 API 키를 연결하지 않았어요.','KEY_MISSING');
    const key=`${ctx.guildId}:${ctx.threadId}:${characterId}:${period}`;
    if(this.inflight.has(key)) return this.inflight.get(key);
    const work=(async()=>{
      if(period!=='last') return this.tracker.syncScheduler(owner,characterId);
      // A past day's data no longer changes, so one successful read for that day is final.
      const day=this.range('last').to,existing=this.db.prepare('SELECT data_json FROM scheduler_snapshots WHERE guild_id=? AND thread_id=? AND character_id=? AND day=?').get(ctx.guildId,ctx.threadId,characterId,day);
      if(existing&&JSON.parse(existing.data_json).final) return {cached:true};
      const session=this.connections.session(ctx,c),result=await session.api.scheduler(session.ocid,day);
      session.assertCurrent();this.access(ctx,characterId);
      this.db.prepare('INSERT INTO scheduler_snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,thread_id,character_id,day) DO UPDATE SET collected_at=excluded.collected_at,data_json=excluded.data_json').run(ctx.guildId,ctx.threadId,characterId,result.date,this.now(),JSON.stringify({...result,final:result.date<kstDay(this.now())}));
      return {cached:false};
    })();
    this.inflight.set(key,work);
    try {return await work;} finally {this.inflight.delete(key);}
  }
  // Shows the cache; calls the API only when nothing is cached for that week.
  async view(ctx,characterId,period='current') {
    const cached=this.cached(ctx,characterId,period);
    if(cached) return {record:cached,fetched:false};
    const result=await this.refresh(ctx,characterId,period);
    const record=this.cached(ctx,characterId,period);
    requireRule(record,'해당 주차의 스케줄러 기록을 찾지 못했어요. 게임 접속 여부와 API 제공 상태를 확인해 주세요.','NEXON_NO_SCHEDULER');
    return {record,fetched:!result.cached};
  }
  save(ctx,characterId,day,collectedAt) {
    const c=this.access(ctx,characterId);
    const row=this.db.prepare('SELECT day,collected_at,data_json FROM scheduler_snapshots WHERE guild_id=? AND thread_id=? AND character_id=? AND day=?').get(ctx.guildId,ctx.threadId,characterId,day);
    requireRule(row,'불러온 기록이 만료됐어요. 다시 조회해 주세요.','NOT_FOUND');
    requireRule(row.collected_at===collectedAt,'그 사이 기록이 갱신됐어요. 다시 확인한 뒤 저장해 주세요.','STALE');
    const record=toRecord(c,null,row),{characterName,ownerId,period,...data}=record;
    this.db.prepare(`INSERT INTO boss_history VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(guild_id,thread_id,character_id,week) DO UPDATE SET data_json=excluded.data_json,saved_by=excluded.saved_by,saved_at=excluded.saved_at`).run(ctx.guildId,ctx.threadId,characterId,record.week,JSON.stringify(data),ctx.userId,this.now());
    return record;
  }
  history(ctx,characterId) {
    const c=this.access(ctx,characterId);
    return {character:c,weeks:this.db.prepare('SELECT * FROM boss_history WHERE guild_id=? AND thread_id=? AND character_id=? ORDER BY week DESC').all(ctx.guildId,ctx.threadId,characterId).map(r=>({...JSON.parse(r.data_json),week:r.week,savedBy:r.saved_by,savedAt:r.saved_at}))};
  }
}

function toRecord(character,period,row) {
  const data=JSON.parse(row.data_json);
  return {
    characterId:character.id,characterName:character.name,ownerId:character.ownerId,period,week:weekOfDay(row.day),day:row.day,collectedAt:row.collected_at,final:Boolean(data.final),
    clearCount:data.weeklyBossCount??null,clearLimit:data.weeklyBossLimit??null,
    cleared:(data.bosses??[]).filter(b=>b.complete===true).map(b=>{
      const {boss,difficulty}=fromScheduler(b.name,b.difficulty);
      return {name:b.name,bossId:boss?.id??null,difficulty,monthly:/monthly/i.test(b.cycle??'')};
    }),
  };
}
export function clearedValue(cleared,prices) {
  return cleared.reduce((sum,b)=>sum+(b.bossId?prices[priceKey(b.bossId,b.difficulty)]??0:0),0);
}
